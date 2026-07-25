import { describe, expect, test } from "vitest";

import type { DirectEvidenceExcerpt } from "../src/services/directEvidence.js";
import type { PersonalSignal } from "../src/services/personalSignals.js";
import { selectQuestionEvidence } from "../src/services/questionEvidence.js";

const direct: DirectEvidenceExcerpt[] = [
  { sessionId: "other", turnIndex: 0, sessionDate: "2025/01/01", excerpt: "I spent five hours at a class last week.", pointers: ["/context/events/user/class"], containsTemporalCue: true },
  { sessionId: "review", turnIndex: 0, sessionDate: "2025/01/02", excerpt: "I attended the design review before launch day.", pointers: ["/context/events/user/design_review"], containsTemporalCue: true },
  { sessionId: "deploy", turnIndex: 0, sessionDate: "2025/01/03", excerpt: "I deployed the service on launch day.", pointers: ["/context/projects/user/service/deployment"], containsTemporalCue: true },
];

describe("question evidence projection", () => {
  test("selects both operands of a temporal comparison ahead of unrelated temporal facts", () => {
    const selected = selectQuestionEvidence("How long before I deployed the service did I attend the design review?", direct, []);
    expect(selected.slice(0, 2).map((item) => item.sessionId)).toEqual(["review", "deploy"]);
    expect(selected.every((item) => item.sessionId !== "other")).toBe(true);
  });

  test("uses an omitted high-priority signal as an explicitly unverified fallback", () => {
    const signal: PersonalSignal = {
      signalId: "signal_stable", sessionId: "missing", sessionDate: "2025/01/04", sessionSlot: "session_1",
      turnIndex: 0, turnSlot: "turn_1", sentenceIndex: 0, text: "I attended the conference two days ago.",
      reasons: ["first_person", "time", "change"], priority: "high",
    };
    const selected = selectQuestionEvidence("When did I attend the conference?", [], [signal]);
    expect(selected[0]).toMatchObject({ sessionId: "missing", source: "unverified_signal" });
  });

  test("does not promote an unverified hypothetical first-person clause", () => {
    const signal: PersonalSignal = {
      signalId: "signal_hypothetical", sessionId: "fiction", sessionDate: "2025/01/04", sessionSlot: "session_1",
      turnIndex: 0, turnSlot: "turn_1", sentenceIndex: 0, text: "Imagine I attended the conference two days ago.",
      reasons: ["first_person", "time", "change"], priority: "high",
    };
    expect(selectQuestionEvidence("When did I attend the conference?", [], [signal])).toEqual([]);
  });
});
