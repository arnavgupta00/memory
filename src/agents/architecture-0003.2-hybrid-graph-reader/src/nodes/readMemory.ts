import type { WorkflowRuntime } from "../runtime.js";
import { graphHash } from "../services/graphMutations.js";
import { buildReaderPromptEvidence } from "../services/readerEvidence.js";
import { enforceReaderGrounding } from "../services/readerGrounding.js";
import { sanitizeReaderPlan } from "../services/readerPlan.js";
import { recoverQuantitativeReaderPlan } from "../services/readerQuantitativeFallback.js";
import { createCandidateConstrainedReaderPlanSchema } from "../services/readerSchema.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { JsonObject, ReaderPlan } from "../types.js";

export function createReadMemoryNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const candidates = state.retrievalCandidates;
    if (!candidates) throw new Error("readMemory requires retrieval candidates");
    await runtime.events.record(
      "node_started",
      { node: "readMemory", call_key: "reader:final" },
      graphHash(state.graph),
    );
    const evidence = buildReaderPromptEvidence(candidates);
    const prompt = await runtime.prompts.render("reader", {
      question: state.question,
      question_date: state.questionDate,
      session_candidates: evidence.sessionCandidates,
      graph_candidates: evidence.graphCandidates,
      summary_candidates: evidence.summaryCandidates,
      coverage_fallback_candidates: evidence.coverageFallbackCandidates,
      tail_candidates: evidence.tailCandidates,
    });
    const response = await runtime.models.generateStructured({
      role: "reader",
      callKey: "reader:final",
      prompt,
      schemaName: "reader_plan_v1",
      schema: createCandidateConstrainedReaderPlanSchema(
        candidates,
        evidence.focusTurns,
      ),
      artifacts: runtime.artifacts,
    });
    const sanitized = sanitizeReaderPlan({
      raw: response.value,
      candidates,
      sessions: state.sessions,
      graph: state.graph,
    });
    const quantitativeFallback = recoverQuantitativeReaderPlan({
      question: state.question,
      plan: sanitized.plan,
      focusTurns: evidence.focusTurns,
    });
    const grounding = enforceReaderGrounding({
      question: state.question,
      plan: quantitativeFallback.plan,
      sessions: state.sessions,
      graph: state.graph,
    });
    const readerPlan: ReaderPlan = grounding.plan;
    const groundingWarnings = grounding.validation.issues.map((issue) =>
      `reader grounding forced abstention: ${JSON.stringify(issue)}`,
    ).concat(
      grounding.removedFactIndexes.map((factIndex) =>
        `reader grounding removed unsupported fact: ${String(factIndex)}`,
      ),
    );
    await runtime.artifacts.writeAtomic(
      "reader-plan.json",
      {
        ...readerPlan,
        promptEvidenceBytes: evidence.includedBytes,
        omittedPromptItems: evidence.omittedItems,
        sanitizerWarnings: sanitized.warnings,
        grounding: grounding as unknown as JsonObject,
        quantitativeFallback: quantitativeFallback as unknown as JsonObject,
      } as unknown as JsonObject,
    );
    return {
      readerPlan,
      readerGeneration: response.generation,
      warnings: [
        ...state.warnings,
        ...evidence.omittedItems.map((item) => `reader prompt omitted over-budget item: ${item}`),
        ...sanitized.warnings,
        ...(quantitativeFallback.applied
          ? [
              `reader applied deterministic quantitative fallback: ${
                quantitativeFallback.sourceSessionIds.join(",")
              }`,
            ]
          : []),
        ...groundingWarnings,
      ],
      currentNode: "readMemory",
    };
  };
}
