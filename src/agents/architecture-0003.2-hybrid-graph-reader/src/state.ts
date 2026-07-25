import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import {
  AnswerResultSchema,
  ContextoMutationSchema,
  ContextoSemanticRejectionSchema,
  FinalAnswerSchema,
  FinalContextSchema,
  GraphMutationRecordSchema,
  JsonValueSchema,
  MasterContextGraphSchema,
  NormalizedGenerationSchema,
  ReaderPlanSchema,
  SessionSummaryRecordSchema,
  ShinoOutputSchema,
  TimestampedSessionSchema,
} from "./types.js";
import {
  RetrievalCandidatesSchema,
  RetrievalIndexManifestSchema,
} from "./retrieval/types.js";

export const MemoryState = new StateSchema({
  action: z.enum(["ingest", "answer", "resume"]),
  caseId: z.string(),
  sessions: z.array(TimestampedSessionSchema),
  incomingSession: TimestampedSessionSchema.nullable(),
  graph: MasterContextGraphSchema,
  graphTrackedCount: z.number().int().nonnegative(),
  summaryTrackedCount: z.number().int().nonnegative(),
  pendingMutation: ContextoMutationSchema.nullable(),
  pendingMutationRejection: ContextoSemanticRejectionSchema.nullable(),
  mutationRecords: z.array(GraphMutationRecordSchema),
  pendingSummary: ShinoOutputSchema.nullable(),
  summaries: z.array(SessionSummaryRecordSchema),
  question: z.string(),
  questionDate: z.string(),
  retrievalManifest: RetrievalIndexManifestSchema.nullable(),
  retrievalCandidates: RetrievalCandidatesSchema.nullable(),
  readerPlan: ReaderPlanSchema.nullable(),
  readerGeneration: NormalizedGenerationSchema.nullable(),
  finalContext: FinalContextSchema.nullable(),
  finalAnswerOutput: FinalAnswerSchema.nullable(),
  answerGeneration: NormalizedGenerationSchema.nullable(),
  answerResult: AnswerResultSchema.nullable(),
  warnings: z.array(z.string()),
  currentNode: z.string(),
  extensionState: z.record(z.string(), JsonValueSchema).default({}),
});

export type MemoryStateType = typeof MemoryState.State;
export type MemoryStateUpdate = typeof MemoryState.Update;

export function emptyState(caseId: string): MemoryStateType {
  return {
    action: "ingest",
    caseId,
    sessions: [],
    incomingSession: null,
    graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
    graphTrackedCount: 0,
    summaryTrackedCount: 0,
    pendingMutation: null,
    pendingMutationRejection: null,
    mutationRecords: [],
    pendingSummary: null,
    summaries: [],
    question: "",
    questionDate: "",
    retrievalManifest: null,
    retrievalCandidates: null,
    readerPlan: null,
    readerGeneration: null,
    finalContext: null,
    finalAnswerOutput: null,
    answerGeneration: null,
    answerResult: null,
    warnings: [],
    currentNode: "idle",
    extensionState: {},
  };
}
