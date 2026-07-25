import type {
  Bm25SearchResult,
  RetrievalDocument,
} from "./types.js";
import {
  explicitTemporalTerms,
  tokenizeRetrievalText,
} from "./tokenize.js";

export const BM25_K1 = 1.2 as const;
export const BM25_B = 0.75 as const;
export const DEFAULT_TEMPORAL_BOOST = 0.15;

type IndexedDocument = {
  document: RetrievalDocument;
  length: number;
  termFrequency: Map<string, number>;
  temporalTerms: Set<string>;
};

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export class Bm25Index {
  readonly #documents: IndexedDocument[];
  readonly #documentFrequency: Map<string, number>;
  readonly #averageLength: number;

  constructor(documents: RetrievalDocument[]) {
    const ids = new Set<string>();
    this.#documents = documents.map((document) => {
      if (ids.has(document.id)) throw new Error(`duplicate retrieval document ID: ${document.id}`);
      ids.add(document.id);
      const tokens = tokenizeRetrievalText(document.text);
      return {
        document,
        length: tokens.length,
        termFrequency: countTerms(tokens),
        temporalTerms: explicitTemporalTerms(document.text),
      };
    });
    this.#documentFrequency = new Map<string, number>();
    for (const indexed of this.#documents) {
      for (const token of indexed.termFrequency.keys()) {
        this.#documentFrequency.set(token, (this.#documentFrequency.get(token) ?? 0) + 1);
      }
    }
    this.#averageLength =
      this.#documents.length === 0
        ? 0
        : this.#documents.reduce((total, item) => total + item.length, 0) /
          this.#documents.length;
  }

  search(
    query: string,
    limit: number,
    temporalBoost = DEFAULT_TEMPORAL_BOOST,
  ): Bm25SearchResult[] {
    if (limit < 0 || !Number.isInteger(limit)) throw new Error("retrieval limit must be a nonnegative integer");
    if (temporalBoost < 0) throw new Error("temporal boost cannot be negative");
    const queryTerms = [...new Set(tokenizeRetrievalText(query))];
    const queryTemporal = explicitTemporalTerms(query);
    const documentCount = this.#documents.length;
    const scored = this.#documents.map((indexed) => {
      let bm25Score = 0;
      const matchedTerms: string[] = [];
      for (const term of queryTerms) {
        const frequency = indexed.termFrequency.get(term) ?? 0;
        if (frequency === 0) continue;
        matchedTerms.push(term);
        const documentFrequency = this.#documentFrequency.get(term) ?? 0;
        const inverseDocumentFrequency = Math.log(
          1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
        );
        const lengthRatio = this.#averageLength === 0 ? 0 : indexed.length / this.#averageLength;
        const denominator =
          frequency + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio);
        bm25Score += inverseDocumentFrequency * ((frequency * (BM25_K1 + 1)) / denominator);
      }
      const temporalMatches = [...queryTemporal].filter((term) =>
        indexed.temporalTerms.has(term),
      ).length;
      const appliedTemporalBoost =
        queryTemporal.size === 0 ? 0 : temporalBoost * temporalMatches;
      return {
        documentId: indexed.document.id,
        score: bm25Score + appliedTemporalBoost,
        bm25Score,
        temporalBoost: appliedTemporalBoost,
        matchedTerms,
        rank: 0,
      };
    });
    return scored
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.matchedTerms.length - left.matchedTerms.length ||
          left.documentId.localeCompare(right.documentId),
      )
      .slice(0, limit)
      .map((result, index) => ({ ...result, rank: index + 1 }));
  }
}
