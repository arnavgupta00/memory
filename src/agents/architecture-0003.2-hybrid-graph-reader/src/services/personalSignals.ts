import { createHash } from "node:crypto";

import { SessionSlotSchema, type SessionSlot, type TimestampedSession } from "../types.js";
import { signalOperandHints, type SignalOperandHints } from "./signalOperands.js";

export type PersonalSignalReason =
  | "first_person"
  | "quantity"
  | "time"
  | "change"
  | "completed_event"
  | "relationship"
  | "possession_or_project";

export type PersonalSignal = {
  signalId: string;
  sessionId: string;
  sessionDate: string;
  sessionSlot: SessionSlot;
  turnIndex: number;
  turnSlot: string;
  sentenceIndex: number;
  text: string;
  reasons: PersonalSignalReason[];
  priority: "high" | "medium" | "low";
};

const REASON_PATTERNS: ReadonlyArray<readonly [PersonalSignalReason, RegExp]> = [
  ["first_person", /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|we'd|we'll|our|ours)\b/i],
  ["quantity", /(?:\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/i],
  ["time", /\b(?:today|yesterday|tomorrow|last|next|ago|minutes?|hours?|days?|weeks?|months?|years?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/i],
  ["change", /\b(?:now|currently|already|still|started|stopped|increased|decreased|grew|changed|finished|completed|attended|visited|graduated|received|replaced|moved|got|bought|purchased|paid|ordered|sold|donated|planted|spent)\b/i],
  ["completed_event", /\b(?:attended|baked|built|bought|completed|cooked|created|finished|joined|left|made|met|ordered|paid|planted|received|returned|sold|took|traveled|visited|went|won)\b/i],
  ["relationship", /\b(?:mom|mother|dad|father|parent|parents|sister|brother|sibling|partner|wife|husband|friend|child|children|son|daughter|pet|dog|cat|horse)\b/i],
  ["possession_or_project", /\b(?:my|our)\s+[\p{L}\p{N}_'-]+|\b(?:project|plan|trip|work|home|apartment|garden|account|subscription|device)\b/iu],
];

function sentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function reasonsFor(text: string): PersonalSignalReason[] {
  const reasons = REASON_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason);
  if (/\bMay\b/.test(text) || /\b(?:\d{1,4}[/-]){1,2}\d{1,4}\b|\b\d{1,2}:\d{2}\b/.test(text)) {
    reasons.push("time");
  }
  return [...new Set(reasons)];
}

function priorityFor(reasons: PersonalSignalReason[]): PersonalSignal["priority"] {
  const score = reasons.reduce((total, reason) => {
    if (
      reason === "quantity"
      || reason === "time"
      || reason === "change"
      || reason === "completed_event"
    ) {
      return total + 2;
    }
    if (reason === "relationship" || reason === "possession_or_project") return total + 1;
    return total;
  }, 0);
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function stableSignalId(sessionId: string, turnIndex: number, sentenceIndex: number, text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ").toLowerCase();
  const digest = createHash("sha256")
    .update(`${sessionId}\u0000${String(turnIndex)}\u0000${String(sentenceIndex)}\u0000${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return `signal_${digest}`;
}

export function personalSignals(sessions: TimestampedSession[]): PersonalSignal[] {
  const candidates = sessions.flatMap((session, sessionIndex) =>
    session.turns.flatMap((turn, turnIndex) => {
      if (turn.role !== "user") return [];
      return sentences(turn.content).flatMap((text, sentenceIndex) => {
        const reasons = reasonsFor(text);
        if (!reasons.includes("first_person")) return [];
        return [{
          signalId: stableSignalId(session.session_id, turnIndex, sentenceIndex, text),
          sessionId: session.session_id,
          sessionDate: session.date,
          sessionSlot: SessionSlotSchema.parse(`session_${String(sessionIndex + 1)}`),
          turnIndex,
          turnSlot: `turn_${String(turnIndex + 1)}`,
          sentenceIndex,
          text,
          reasons,
          priority: priorityFor(reasons),
        }];
      });
    }),
  );
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return candidates
    .sort((left, right) => rank[left.priority] - rank[right.priority]
      || left.sessionSlot.localeCompare(right.sessionSlot)
      || left.turnIndex - right.turnIndex
      || left.sentenceIndex - right.sentenceIndex);
}

export type PersonalSignalIndex = {
  requiredHighPrioritySignals: IndexedPersonalSignal[];
  additionalCandidates: IndexedPersonalSignal[];
};

export type IndexedPersonalSignal = PersonalSignal & {
  operandHints: SignalOperandHints;
};

export function personalSignalIndex(sessions: TimestampedSession[]): PersonalSignalIndex {
  const signals = personalSignals(sessions).map((signal) => ({
    ...signal,
    operandHints: signalOperandHints(signal.text, signal.sessionDate),
  }));
  return {
    requiredHighPrioritySignals: signals.filter((signal) => signal.priority === "high"),
    additionalCandidates: signals.filter((signal) => signal.priority !== "high"),
  };
}
