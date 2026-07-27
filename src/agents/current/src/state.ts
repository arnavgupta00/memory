import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import {
  AnswerOutputSchema,
  AnswerResultSchema,
  ContextPackageSchema,
  NormalizedGenerationSchema,
  TimestampedSessionSchema,
} from "./types.js";
import { type RetrievalResult } from "./retrieval/types.js";

const RetrievalResultSchema = z.custom<RetrievalResult>(
  (value) => value !== null && typeof value === "object",
);

export const MemoryState = new StateSchema({
  action: z.enum(["ingest", "answer"]),
  caseId: z.string(),
  sessions: z.array(TimestampedSessionSchema),
  incomingSession: TimestampedSessionSchema.nullable(),
  question: z.string(),
  questionDate: z.string(),
  retrieval: RetrievalResultSchema.nullable(),
  contextPackage: ContextPackageSchema.nullable(),
  selectGeneration: NormalizedGenerationSchema.nullable(),
  finalAnswerOutput: AnswerOutputSchema.nullable(),
  answerGeneration: NormalizedGenerationSchema.nullable(),
  answerResult: AnswerResultSchema.nullable(),
  warnings: z.array(z.string()),
  currentNode: z.string(),
});

export type MemoryStateType = typeof MemoryState.State;
export type MemoryStateUpdate = typeof MemoryState.Update;

export function emptyState(caseId: string): MemoryStateType {
  return {
    action: "ingest",
    caseId,
    sessions: [],
    incomingSession: null,
    question: "",
    questionDate: "",
    retrieval: null,
    contextPackage: null,
    selectGeneration: null,
    finalAnswerOutput: null,
    answerGeneration: null,
    answerResult: null,
    warnings: [],
    currentNode: "idle",
  };
}
