import { z } from "zod";

import type { CompactFinalEvidencePayload } from "./finalEvidencePackage.js";
import type { FinalAnswer } from "../types.js";

export const FINAL_ANSWER_EVIDENCE_LIMIT = 16;

type FinalEvidence = FinalAnswer["evidence"][number];

const UnconstrainedFinalEvidenceSchema: z.ZodType<FinalEvidence> = z.strictObject({
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative().nullable(),
});

function nonEmptyValues<T>(values: T[]): [T, ...T[]] | null {
  const first = values[0];
  return first === undefined ? null : [first, ...values.slice(1)];
}

function includedTurnsBySession(
  payload: CompactFinalEvidencePayload,
): Map<string, Set<number>> {
  const turnsBySession = new Map<string, Set<number>>();
  for (const session of payload.sessions) {
    const turns = turnsBySession.get(session.sessionId) ?? new Set<number>();
    for (const turn of session.turns) turns.add(turn.turnIndex);
    turnsBySession.set(session.sessionId, turns);
  }
  return turnsBySession;
}

function evidenceSchema(
  payload: CompactFinalEvidencePayload,
): z.ZodType<FinalEvidence[]> {
  const variants = [...includedTurnsBySession(payload).entries()].map(
    ([sessionId, turnIndexes]) => {
      const allowedTurnIndexes = nonEmptyValues(
        [...turnIndexes].sort((left, right) => left - right),
      );
      return z.strictObject({
        sessionId: z.literal(sessionId),
        turnIndex: allowedTurnIndexes === null
          ? z.null()
          : z.union([z.literal(allowedTurnIndexes), z.null()]),
      });
    },
  );
  const first = variants[0];
  if (first === undefined) {
    return z.array(UnconstrainedFinalEvidenceSchema).max(0);
  }
  const itemSchema = variants.length === 1
    ? first
    : z.discriminatedUnion("sessionId", [first, ...variants.slice(1)]);
  return z.array(itemSchema).max(FINAL_ANSWER_EVIDENCE_LIMIT);
}

export function createCandidateConstrainedFinalAnswerSchema(
  payload: CompactFinalEvidencePayload,
): z.ZodType<FinalAnswer> {
  return z.strictObject({
    hypothesis: z.string(),
    evidence: evidenceSchema(payload),
    supportStatus: z.enum(["supported", "conflicted", "insufficient"]),
  });
}
