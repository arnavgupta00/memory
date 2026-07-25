import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import type {
  RetrievalCandidates,
  SessionRetrievalCandidate,
  TailRetrievalCandidate,
} from "../src/retrieval/types.js";
import { RetrievalCandidatesSchema } from "../src/retrieval/types.js";
import { focusReaderTurns } from "../src/services/readerFocus.js";
import type { TimestampedSession } from "../src/types.js";

function session(id: string, turns: TimestampedSession["turns"]): TimestampedSession {
  return {
    session_id: id,
    date: "2025/01/01",
    turns,
  };
}

function sessionCandidate(
  value: TimestampedSession,
  rank: number,
): SessionRetrievalCandidate {
  return {
    documentId: `session:${rank}:${value.session_id}`,
    score: 1,
    bm25Score: 1,
    temporalBoost: 0,
    matchedTerms: [],
    rank,
    session: value,
  };
}

function tailCandidate(
  value: TimestampedSession,
  rank: number,
): TailRetrievalCandidate {
  return {
    ...sessionCandidate(value, rank),
    documentId: `tail:${rank}:${value.session_id}`,
  };
}

function candidates(
  sessions: SessionRetrievalCandidate[],
  tailSessions: TailRetrievalCandidate[] = [],
): RetrievalCandidates {
  return {
    schemaVersion: 1,
    question: "placeholder",
    questionDate: "2025/01/02",
    sessions,
    graphCells: [],
    summaries: [],
    coverageFallbackSessions: [],
    tailSessions,
  };
}

describe("reader turn focus", () => {
  test("surfaces an answer-bearing turn and its adjacent conversational pair", () => {
    const source = session("degree-session", [
      { role: "user", content: "Can you suggest a planning app?" },
      { role: "assistant", content: "Try a simple task board." },
      {
        role: "user",
        content: "I graduated with a degree in Business Administration.",
      },
      {
        role: "assistant",
        content: "Your Business Administration background should help.",
      },
      { role: "user", content: "How should I organize receipts?" },
    ]);
    expect(
      focusReaderTurns(
        "What degree did I graduate with?",
        candidates([sessionCandidate(source, 1)]),
      ),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "degree-session",
        turnIndex: 2,
        content: "I graduated with a degree in Business Administration.",
      }),
      expect.objectContaining({
        sessionId: "degree-session",
        turnIndex: 3,
        content: "Your Business Administration background should help.",
      }),
    ]));
  });

  test("selects assistant evidence through the adjacent user request", () => {
    const source = session("omelette-session", [
      {
        role: "user",
        content: "What ingredients make a classic French omelette?",
      },
      { role: "assistant", content: "Use 2-3 eggs, butter, and salt." },
      { role: "user", content: "How can I make it fluffy?" },
    ]);
    const result = focusReaderTurns(
      "How many eggs did the classic French omelette recipe need?",
      candidates([sessionCandidate(source, 1)]),
    );
    expect(result.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    expect(result[1]?.content).toContain("2-3 eggs");
  });

  test("keeps canonical IDs, deduplicates tail sessions, and caps each session", () => {
    const primary = session("stable-id", [
      { role: "user", content: "Monday clinic travel time was two hours." },
      { role: "assistant", content: "The clinic trip took two hours." },
      { role: "user", content: "I left at seven on Monday." },
      { role: "assistant", content: "Seven was the departure time." },
      { role: "user", content: "The clinic was busy on Monday." },
      { role: "assistant", content: "The clinic visit was on Monday." },
    ]);
    const result = focusReaderTurns(
      "What time did I reach the clinic on Monday?",
      candidates(
        [sessionCandidate(primary, 1)],
        [
          tailCandidate(primary, 1),
          tailCandidate(
            session("tail-only", [
              { role: "user", content: "I reached the clinic at nine." },
              { role: "assistant", content: "Nine was the arrival time." },
            ]),
            2,
          ),
        ],
      ),
    );
    expect(result.filter((turn) => turn.sessionId === "stable-id")).toHaveLength(6);
    expect(result.filter((turn) => turn.sessionId === "tail-only")).toHaveLength(2);
    expect(result.every((turn) => !turn.sessionId.includes("reader-focus"))).toBe(true);
  });

  test("is deterministic for identical inputs", () => {
    const source = session("repeatable", [
      { role: "user", content: "I attend yoga three times each week." },
      { role: "assistant", content: "Yoga helps with your anxiety." },
      { role: "user", content: "I used to attend twice each week." },
      { role: "assistant", content: "That is the older routine." },
    ]);
    const input = candidates([sessionCandidate(source, 1)]);
    expect(focusReaderTurns("How often do I attend yoga?", input)).toEqual(
      focusReaderTurns("How often do I attend yoga?", input),
    );
  });

  test("retains a third query-relevant window needed for a comparison", () => {
    const source = session("comparison", [
      { role: "user", content: "I use Instagram for my business." },
      { role: "assistant", content: "Instagram can help the business." },
      { role: "user", content: "I post regularly on Instagram." },
      { role: "assistant", content: "Regular posts can attract followers." },
      { role: "user", content: "I started with 250 Instagram followers." },
      { role: "assistant", content: "The starting count was 250 followers." },
    ]);
    const result = focusReaderTurns(
      "What was the increase in Instagram followers?",
      candidates([sessionCandidate(source, 1)]),
    );
    expect(result.map((turn) => turn.turnIndex)).toContain(4);
    expect(result.map((turn) => turn.turnIndex)).toContain(5);
  });

  test("prioritizes the immediate follow-up pair over a non-adjacent lexical distractor", () => {
    const source = session("conversation-chain", [
      {
        role: "user",
        content: "The archive desk beside River Gate needs a recommendation.",
      },
      {
        role: "assistant",
        content: "I can compare suitable options for that archive desk.",
      },
      {
        role: "user",
        content: "Which option would you choose?",
      },
      {
        role: "assistant",
        content: "Cedar Lantern is the best fit.",
      },
      {
        role: "user",
        content: "The archive desk beside River Gate has blue walls.",
      },
      {
        role: "assistant",
        content: "Those blue walls make the archive desk easy to recognize.",
      },
    ]);
    const result = focusReaderTurns(
      "What was recommended for the archive desk beside River Gate?",
      candidates([sessionCandidate(source, 1)]),
    );
    expect(result.map((turn) => turn.turnIndex)).toEqual(
      expect.arrayContaining([0, 1, 2, 3]),
    );
    expect(result[3]?.content).toBe("Cedar Lantern is the best fit.");
  });

  test("retains enough exact c4f10528 answer evidence within the bounded session cap", () => {
    const source = session("answer_ultrachat_234453", [
      {
        role: "user",
        content: "What are some unique shopping experiences to be had in Bandung?",
      },
      {
        role: "assistant",
        content: "Bandung has factory outlets, traditional markets, and shopping centers.",
      },
      {
        role: "user",
        content: "Which shopping destination should I visit first?",
      },
      {
        role: "assistant",
        content: "It depends on what kind of shopping experience you prefer.",
      },
      {
        role: "user",
        content:
          "I think I'll start with Cihampelas Walk to check out the denim street. Can you recommend any good restaurants or cafes in the area?",
      },
      {
        role: "assistant",
        content:
          "There are several options in the Cihampelas Walk area, including Miss Bee Providore.",
      },
      {
        role: "user",
        content:
          "I'm definitely going to try out Miss Bee Providore for some delicious food. Do they have any signature dishes I should try?",
      },
      {
        role: "assistant",
        content:
          "Miss Bee Providore offers Miss Bee's Nasi Goreng, its take on classic Indonesian fried rice.",
      },
      {
        role: "user",
        content:
          "I'm definitely going to try the Miss Bee's Nasi Goreng and finish it off with the chocolate brownie.",
      },
      {
        role: "assistant",
        content:
          "Enjoy your meal at Miss Bee Providore and have a great time shopping at Cihampelas Walk!",
      },
      {
        role: "user",
        content: "What other activities can I do in Bandung?",
      },
      {
        role: "assistant",
        content: "You can visit a volcano or explore tea plantations.",
      },
    ]);
    const result = focusReaderTurns(
      "I'm planning to visit Bandung again and I was wondering if you could remind me of the name of that restaurant in Cihampelas Walk that serves a great Nasi Goreng?",
      candidates([sessionCandidate(source, 1)]),
    );
    const referenceTurns = result.filter(
      (turn) => turn.sessionId === "answer_ultrachat_234453",
    );
    expect(referenceTurns).toHaveLength(6);
    expect(
      referenceTurns.some((turn) => turn.turnIndex >= 6 && turn.turnIndex <= 9),
    ).toBe(true);
    expect(referenceTurns.map((turn) => turn.content).join("\n")).toContain(
      "Miss Bee Providore",
    );
    expect(referenceTurns.map((turn) => turn.content).join("\n")).toContain(
      "Nasi Goreng",
    );
  });

  const savedCandidatesPath = resolve(
    process.cwd(),
    "../../../runs/gate-07-blind-18-0003-2-b3c9-002/agent-artifacts/cases/c4f10528/retrieval/candidates.json",
  );
  test.skipIf(!existsSync(savedCandidatesPath))(
    "expands the saved c4f10528 reference-session window to its answer-bearing follow-up",
    () => {
      const saved = RetrievalCandidatesSchema.parse(
        JSON.parse(readFileSync(savedCandidatesPath, "utf8")),
      );
      const referenceTurns = focusReaderTurns(saved.question, saved).filter(
        (turn) => turn.sessionId === "answer_ultrachat_234453",
      );
      expect(referenceTurns.map((turn) => turn.turnIndex)).toEqual(
        expect.arrayContaining([4, 5, 6, 7]),
      );
      expect(referenceTurns.map((turn) => turn.content).join("\n")).toContain(
        "Miss Bee's Nasi Goreng",
      );
    },
  );

  const savedTemporalCandidatesPath = resolve(
    process.cwd(),
    "../../../runs/gate-07-blind-18-0003-2-b3c9-002/agent-artifacts/cases/gpt4_98f46fc6/retrieval/candidates.json",
  );
  test.skipIf(!existsSync(savedTemporalCandidatesPath))(
    "does not let a follow-up pair displace the two events in the saved temporal comparison",
    () => {
      const saved = RetrievalCandidatesSchema.parse(
        JSON.parse(readFileSync(savedTemporalCandidatesPath, "utf8")),
      );
      const focused = focusReaderTurns(saved.question, saved);
      const bakeSaleTurns = focused
        .filter((turn) => turn.sessionId === "answer_5850de18_2")
        .map((turn) => turn.turnIndex);
      const galaTurns = focused
        .filter((turn) => turn.sessionId === "answer_5850de18_1")
        .map((turn) => turn.turnIndex);
      expect(bakeSaleTurns).toContain(4);
      expect(galaTurns).toContain(6);
    },
  );
});
