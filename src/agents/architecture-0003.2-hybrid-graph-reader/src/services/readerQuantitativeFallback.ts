import type { ReaderPlan } from "../types.js";
import type { ReaderFocusTurn } from "./readerFocus.js";

export type QuantitativeFallbackResult = {
  plan: ReaderPlan;
  applied: boolean;
  sourceSessionIds: string[];
};

/**
 * Deterministic code must not reverse an evidence Reader's explicit
 * insufficiency decision merely because unrelated retrieved text contains
 * numbers. Quantitative operands remain visible to the Reader and answerer,
 * but evidence sufficiency is never synthesized from lexical heuristics.
 *
 * The stable return shape is retained for replaying older diagnostic
 * artifacts that recorded `quantitativeFallback`.
 */
export function recoverQuantitativeReaderPlan(args: {
  question: string;
  plan: ReaderPlan;
  focusTurns: ReaderFocusTurn[];
}): QuantitativeFallbackResult {
  return {
    plan: args.plan,
    applied: false,
    sourceSessionIds: [],
  };
}
