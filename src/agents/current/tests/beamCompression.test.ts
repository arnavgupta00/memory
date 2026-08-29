import { describe, expect, it } from "vitest";

import type { ArchitectureCase } from "../src/benchmarks/architectureDataset.js";
import {
  CompressionPlanSchema,
  CompressionWorkerSchema,
  buildDiscoveryUnion,
  evaluateCompressionCoverage,
  reduceCompressionClaims,
  type RecertifiedOracleEntry,
} from "../src/compression/beamCompression.js";
import { buildOpaqueSessionSpace } from "../src/retrieval/opaqueSessionIds.js";
import { PromptLoader } from "../src/services/promptLoader.js";
import { usageCost } from "../src/compression/structuredCall.js";

function fixture(): {
  raw: ArchitectureCase;
  trace: { question_id: string; trace: Array<Record<string, unknown>> };
} {
  const raw: ArchitectureCase = {
    question_id: "beam-1m/chat-01/summarization/1",
    question_type: "summarization",
    question: "Summarize the project.",
    question_date: "2026-08-08",
    haystack_session_ids: ["raw_a", "raw_b", "raw_c"],
    haystack_dates: ["day-1", "day-2", "day-3"],
    haystack_sessions: [
      [{ role: "user", content: "I started Project Cedar." }],
      [{ role: "user", content: "The first attempt failed because the API timed out." }],
      [{ role: "user", content: "Unrelated lunch discussion." }],
    ],
  };
  const opaque = buildOpaqueSessionSpace({
    namespace: raw.question_id,
    sessionIds: raw.haystack_session_ids,
    datesBySessionId: new Map(raw.haystack_session_ids.map((id, index) => [id, raw.haystack_dates[index] ?? ""])),
    annotations: new Map(),
  });
  const first = opaque.realToOpaque.get("raw_a");
  const second = opaque.realToOpaque.get("raw_b");
  if (!first || !second) throw new Error("fixture opaque IDs missing");
  return {
    raw,
    trace: {
      question_id: raw.question_id,
      trace: [{
        initial_discovery: {
          sparse_queries: [{ session_ids: [first, second] }],
          dense_queries: [{ hits: [{ session_id: first, rank: 1 }] }],
        },
      }],
    },
  };
}

describe("BEAM compression pipeline primitives", () => {
  it("builds an inclusive union without applying ranking or top-K selection", () => {
    const { raw, trace } = fixture();
    const union = buildDiscoveryUnion(raw, trace);
    expect(union.sessions.map((session) => session.realSessionId).sort()).toEqual(["raw_a", "raw_b"]);
    expect(union.sessions.find((session) => session.realSessionId === "raw_a")?.hitCount).toBe(2);
    expect(union.sessions.find((session) => session.realSessionId === "raw_b")?.hitCount).toBe(1);
  });

  it("keeps every source-grounded claim and rejects fabricated provenance", () => {
    const { raw, trace } = fixture();
    const discovery = buildDiscoveryUnion(raw, trace);
    const first = discovery.sessions.find((session) => session.realSessionId === "raw_a");
    const second = discovery.sessions.find((session) => session.realSessionId === "raw_b");
    if (!first || !second) throw new Error("fixture discovery missing");
    const plan = CompressionPlanSchema.parse({
      questionMode: "summary",
      answerContract: "Cover the beginning and failure.",
      storyBranches: [{
        id: "cedar",
        description: "Project Cedar",
        evidenceNeeded: ["beginning", "failed attempt"],
      }],
      evidenceFacets: [
        {
          id: "beginning",
          priority: "must",
          description: "Beginning",
          evidenceShapes: ["started"],
          completionRule: "One grounded beginning",
        },
        {
          id: "failure",
          priority: "must",
          description: "Failure",
          evidenceShapes: ["failed"],
          completionRule: "One grounded failure",
        },
      ],
      crossSessionOperations: ["construct_timeline"],
      workerInstructions: ["Keep rare failures"],
      novelEvidencePolicy: "Retain unplanned relevant evidence.",
      coverageChecklist: ["beginning", "failure"],
    });
    const output = CompressionWorkerSchema.parse({
      sessionResults: [
        {
          sessionId: first.opaqueSessionId,
          disposition: "relevant",
          claims: [{
            turnIndex: 0,
            verbatimQuote: "I started Project Cedar.",
            normalizedFact: "Project Cedar started.",
            facetIds: ["beginning"],
            storyBranchIds: ["cedar"],
            evidenceKind: "event",
            whyNeeded: "Beginning",
            confidence: "high",
            unplannedNovelEvidence: false,
          }],
        },
        {
          sessionId: second.opaqueSessionId,
          disposition: "relevant",
          claims: [
            {
              turnIndex: 0,
              verbatimQuote: "The first attempt failed because the API timed out.",
              normalizedFact: "The first attempt failed because of an API timeout.",
              facetIds: ["failure"],
              storyBranchIds: ["cedar"],
              evidenceKind: "event",
              whyNeeded: "Failure",
              confidence: "high",
              unplannedNovelEvidence: false,
            },
            {
              turnIndex: 0,
              verbatimQuote: "This quote was fabricated.",
              normalizedFact: "Fabricated.",
              facetIds: ["failure"],
              storyBranchIds: ["cedar"],
              evidenceKind: "other",
              whyNeeded: "Should fail",
              confidence: "low",
              unplannedNovelEvidence: false,
            },
          ],
        },
      ],
    });
    const reduced = reduceCompressionClaims({ plan, discovery, workerOutputs: [output] });
    expect(reduced.claims).toHaveLength(2);
    expect(reduced.rejectedClaims).toEqual([
      expect.objectContaining({ reason: "quote_not_in_source" }),
    ]);
    expect(reduced.uncoveredMustFacetIds).toEqual([]);

    const oracle: RecertifiedOracleEntry = {
      question_id: raw.question_id,
      status: "certified",
      evidence_atoms: [
        {
          atom_id: "beginning",
          description: "Started Cedar",
          sources: [{
            message_id: 1,
            session_id: "raw_a",
            turn_index: 0,
            role: "user",
            quote: "I started Project Cedar.",
          }],
        },
        {
          atom_id: "failure",
          description: "Attempt failed",
          sources: [{
            message_id: 2,
            session_id: "raw_b",
            turn_index: 0,
            role: "user",
            quote: "The first attempt failed because the API timed out.",
          }],
        },
      ],
    };
    expect(evaluateCompressionCoverage(reduced, oracle)).toEqual(expect.objectContaining({
      coveredAtoms: 2,
      totalAtoms: 2,
      fullStory: true,
    }));
  });

  it("renders planner, worker, and oracle-audit prompts with strict variables", async () => {
    const loader = new PromptLoader();
    const planner = await loader.render("beam-compression-plan-v1", {
      question: "q",
      question_date: "d",
      discovery_sessions: "[]",
    });
    const worker = await loader.render("beam-compression-worker-v1", {
      question: "q",
      question_date: "d",
      compression_plan: "{}",
      worker_sessions: "[]",
    });
    const audit = await loader.render("beam-evidence-recertify-v1", {
      probe_record: "{}",
      candidate_messages: "[]",
    });
    const adjudication = await loader.render("beam-evidence-recertify-adjudicate-v1", {
      probe_record: "{}",
      candidate_messages: "[]",
      primary_audit: "{}",
      review_audit: "{}",
      prior_adjudication: "{}",
      validation_feedback: "[]",
    });
    expect([planner, worker, audit, adjudication].flatMap((prompt) => prompt.messages)
      .every((message) => !message.content.includes("{{"))).toBe(true);
  });

  it("uses current Luna pricing, cached input, and the long-context multiplier", () => {
    expect(usageCost("gpt-5.6-luna", {
      input_tokens: 300_000,
      cached_input_tokens: 200_000,
      cache_write_tokens: 50_000,
      output_tokens: 10_000,
      total_tokens: 310_000,
      reasoning_tokens: 5_000,
    })).toBeCloseTo(0.071, 8);
    expect(usageCost("gpt-5.4-nano-2026-03-17", {
      input_tokens: 300_000,
      cached_input_tokens: 200_000,
      cache_write_tokens: 0,
      output_tokens: 10_000,
      total_tokens: 310_000,
      reasoning_tokens: 5_000,
    })).toBeCloseTo(0.0365, 8);
  });
});
