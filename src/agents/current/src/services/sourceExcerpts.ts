import {
  SOURCE_EXCERPT_MAX_LENGTH,
  type ContextoMutation,
  type SourceReference,
} from "../types.js";

const OMISSION_MARKER = "\n…\n";
const HEAD_SHARE = 0.65;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function takeWithinBudget(
  graphemes: string[],
  budget: number,
  direction: "head" | "tail",
): string {
  const selected: string[] = [];
  let length = 0;
  const indexes = direction === "head"
    ? graphemes.keys()
    : Array.from(graphemes.keys()).reverse();
  for (const index of indexes) {
    const grapheme = graphemes[index];
    if (grapheme === undefined || length + grapheme.length > budget) break;
    selected.push(grapheme);
    length += grapheme.length;
  }
  return direction === "head" ? selected.join("") : selected.reverse().join("");
}

/**
 * Bounds persisted excerpts in UTF-16 code units, matching Zod's string-length
 * semantics, without splitting Unicode grapheme clusters. Both ends are kept
 * because autobiographical subjects tend to occur near the start while dates,
 * quantities, and outcomes often occur near the end.
 */
export function boundSourceExcerpt(excerpt: string | null): string | null {
  if (excerpt === null || excerpt.length <= SOURCE_EXCERPT_MAX_LENGTH) return excerpt;

  const contentBudget = SOURCE_EXCERPT_MAX_LENGTH - OMISSION_MARKER.length;
  const headBudget = Math.floor(contentBudget * HEAD_SHARE);
  const tailBudget = contentBudget - headBudget;
  const graphemes = Array.from(
    graphemeSegmenter.segment(excerpt),
    (part) => part.segment,
  );
  const head = takeWithinBudget(graphemes, headBudget, "head");
  const tail = takeWithinBudget(graphemes, tailBudget, "tail");
  return `${head}${OMISSION_MARKER}${tail}`;
}

function boundSource(source: SourceReference): SourceReference {
  const excerpt = boundSourceExcerpt(source.excerpt);
  return excerpt === source.excerpt ? source : { ...source, excerpt };
}

function boundSources(sources: SourceReference[]): SourceReference[] {
  return sources.map(boundSource);
}

/**
 * Normalizes the canonical mutation immediately after provider-wire decoding.
 * It returns a new value and never mutates the provider response retained in
 * the model-call cache.
 */
export function boundMutationSourceExcerpts(mutation: ContextoMutation): ContextoMutation {
  if (mutation.mode === "semantic_updates") {
    return {
      ...mutation,
      updates: mutation.updates.map((update) => ({
        ...update,
        sources: boundSources(update.sources),
      })),
    };
  }
  if (mutation.mode === "patch") {
    return {
      ...mutation,
      operations: mutation.operations.map((operation) => ({
        ...operation,
        sources: boundSources(operation.sources),
      })),
    };
  }
  return {
    ...mutation,
    provenance: mutation.provenance.map((item) => ({
      ...item,
      sources: boundSources(item.sources),
    })),
    migration: mutation.migration.map((item) => ({
      ...item,
      sources: boundSources(item.sources),
    })),
  };
}
