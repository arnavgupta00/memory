import { describe, expect, test } from "vitest";

import {
  enforceReaderGrounding,
  extractExactSurfaceAnchors,
  isQuestionRestatement,
  validateReaderGrounding,
} from "../src/services/readerGrounding.js";
import type {
  MasterContextGraph,
  ReaderPlan,
  TimestampedSession,
} from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "matching",
    date: "2025/01/01",
    turns: [{
      role: "user",
      content:
        "I reserved the Airbnb in San Francisco while working as a Software Engineer Manager.",
    }],
  },
  {
    session_id: "nearby-role",
    date: "2025/01/02",
    turns: [{
      role: "user",
      content:
        "I lead four engineers as a Senior Software Engineer, and my manager joined us.",
    }],
  },
  {
    session_id: "nearby-place",
    date: "2025/01/03",
    turns: [{
      role: "user",
      content: "I reserved an Airbnb in San Francisco three months in advance.",
    }],
  },
  {
    session_id: "unselected",
    date: "2025/01/04",
    turns: [{ role: "user", content: "This session was not selected." }],
  },
];

const graph: MasterContextGraph = {
  schemaVersion: 1,
  revision: 1,
  context: {
    employment: {
      current: {
        role: "Software Engineer Manager",
      },
    },
  },
  provenanceByPointer: {},
};

function plan(args: {
  sessionId?: string;
  statement?: string;
  factSessionIds?: string[];
  graphPointers?: string[];
  supportStatus?: ReaderPlan["supportStatus"];
  answerMode?: ReaderPlan["answerMode"];
} = {}): ReaderPlan {
  const sessionId = args.sessionId ?? "matching";
  const selectedGraphPointers = args.graphPointers ?? [];
  return {
    supportStatus: args.supportStatus ?? "sufficient",
    answerMode: args.answerMode ?? "direct",
    selectedSessions:
      args.supportStatus === "insufficient"
        ? []
        : [{ sessionId, turnIndexes: [0], purpose: "direct_answer" }],
    selectedGraphPointers,
    evidenceFacts:
      args.supportStatus === "insufficient"
        ? []
        : [{
            statement:
              args.statement
              ?? "The reservation was in San Francisco for the stated role.",
            sessionIds: args.factSessionIds ?? [sessionId],
            graphPointers: selectedGraphPointers,
          }],
    conflicts: [],
  };
}

describe("reader exact-constraint grounding", () => {
  test("accepts exact named-role and location surfaces in selected evidence", () => {
    const result = validateReaderGrounding({
      question:
        "Where did I reserve the Airbnb as a Software Engineer Manager in San Francisco?",
      plan: plan(),
      sessions,
      graph,
    });

    expect(result).toMatchObject({
      valid: true,
      action: "accept",
      issues: [],
    });
    expect(result.anchors.map((anchor) => anchor.text)).toEqual([
      "Airbnb",
      "Software Engineer Manager",
      "San Francisco",
    ]);
  });

  test("rejects a nearby but different named role", () => {
    const result = validateReaderGrounding({
      question:
        "How many engineers report to me as a Software Engineer Manager?",
      plan: plan({
        sessionId: "nearby-role",
        statement: "Four engineers report to the user.",
      }),
      sessions,
      graph,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "unmatched_exact_surface_anchor",
      anchor: {
        text: "Software Engineer Manager",
        normalized: "software engineer manager",
        kind: "capitalized_phrase",
      },
    });
  });

  test("rejects a nearby but different exact location", () => {
    const result = validateReaderGrounding({
      question: "When did I reserve the Airbnb in Sacramento?",
      plan: plan({
        sessionId: "nearby-place",
        statement: "The Airbnb was reserved three months in advance.",
      }),
      sessions,
      graph,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "unmatched_exact_surface_anchor",
      anchor: {
        text: "Sacramento",
        normalized: "sacramento",
        kind: "capitalized_token",
      },
    });
  });

  test("grounds session-level context outside the selected answer turns", () => {
    const contextualSession: TimestampedSession = {
      session_id: "contextual-answer",
      date: "2025/01/05",
      turns: [
        { role: "user", content: "I am planning another visit to Bandung." },
        { role: "assistant", content: "There are many places to revisit." },
        { role: "user", content: "Which restaurant served the signature dish?" },
        { role: "assistant", content: "Miss Bee Providore served the signature dish." },
      ],
    };
    const result = validateReaderGrounding({
      question: "Which restaurant in Bandung served the signature dish?",
      plan: {
        supportStatus: "sufficient",
        answerMode: "assistant_answer",
        selectedSessions: [{
          sessionId: "contextual-answer",
          turnIndexes: [2, 3],
          purpose: "direct_answer",
        }],
        selectedGraphPointers: [],
        evidenceFacts: [{
          statement: "Miss Bee Providore served the signature dish.",
          sessionIds: ["contextual-answer"],
          graphPointers: [],
        }],
        conflicts: [],
      },
      sessions: [...sessions, contextualSession],
      graph,
    });

    expect(result).toMatchObject({
      valid: true,
      action: "accept",
      issues: [],
    });
  });

  test("rejects question restatements and facts sourced outside selections", () => {
    const question = "When did I reserve the Airbnb in Sacramento?";
    const result = validateReaderGrounding({
      question,
      plan: plan({
        sessionId: "nearby-place",
        statement: `The user asked: "${question}"`,
        factSessionIds: ["unselected"],
      }),
      sessions,
      graph,
    });

    expect(isQuestionRestatement(question, `The user asked: "${question}"`))
      .toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      {
        code: "fact_session_not_selected",
        factIndex: 0,
        sessionId: "unselected",
      },
      {
        code: "fact_has_no_selected_source",
        factIndex: 0,
      },
      {
        code: "question_restatement_fact",
        factIndex: 0,
      },
    ]));
    expect(result.action).toBe("force_abstain");
  });

  test("accepts a clean abstention without requiring question anchors", () => {
    const result = validateReaderGrounding({
      question: "When did I reserve the Airbnb in Sacramento?",
      plan: plan({
        supportStatus: "insufficient",
        answerMode: "abstain",
      }),
      sessions,
      graph,
    });

    expect(result).toEqual({
      valid: true,
      action: "accept",
      anchors: [],
      matchedAnchors: [],
      issues: [],
    });
  });

  test("grounds an exact role through a selected graph value", () => {
    const pointer = "/context/employment/current";
    const result = validateReaderGrounding({
      question: "What is my role as Software Engineer Manager?",
      plan: {
        ...plan({
          graphPointers: [pointer],
          statement: "The current role is Software Engineer Manager.",
        }),
        selectedSessions: [],
        evidenceFacts: [{
          statement: "The current role is Software Engineer Manager.",
          sessionIds: [],
          graphPointers: [pointer],
        }],
      },
      sessions,
      graph,
    });

    expect(result.valid).toBe(true);
    expect(result.matchedAnchors).toEqual([
      {
        text: "Software Engineer Manager",
        normalized: "software engineer manager",
        kind: "capitalized_phrase",
      },
    ]);
  });

  test("extracts quoted constraints without treating question words as names", () => {
    expect(
      extractExactSurfaceAnchors(
        'Which option replaced "Plan Alpha" for Rachel?',
      ),
    ).toEqual([
      {
        text: "Plan Alpha",
        normalized: "plan alpha",
        kind: "quoted_phrase",
      },
      {
        text: "Plan Alpha",
        normalized: "plan alpha",
        kind: "capitalized_phrase",
      },
      {
        text: "Rachel",
        normalized: "rachel",
        kind: "capitalized_token",
      },
    ]);
  });

  test("ignores framing contractions without classifying punctuation as phrase whitespace", () => {
    expect(
      extractExactSurfaceAnchors(
        "I'm checking and I've wondered whether We're discussing what What's relevant for Admon.",
      ),
    ).toEqual([
      {
        text: "Admon",
        normalized: "admon",
        kind: "capitalized_token",
      },
    ]);
  });

  test("retains possessive names while ignoring contractions with framing-token bases", () => {
    expect(
      extractExactSurfaceAnchors(
        "Rachel's plan replaced GM's schedule after I'm told We're ready.",
      ),
    ).toEqual([
      {
        text: "Rachel's",
        normalized: "rachel s",
        kind: "capitalized_token",
      },
      {
        text: "GM's",
        normalized: "gm s",
        kind: "capitalized_token",
      },
    ]);
  });

  test("preserves multiword and singleton entity safeguards beside a contraction", () => {
    expect(
      extractExactSurfaceAnchors(
        "I'm asking about Software Engineer Manager in San Francisco for Rachel's team.",
      ),
    ).toEqual([
      {
        text: "Software Engineer Manager",
        normalized: "software engineer manager",
        kind: "capitalized_phrase",
      },
      {
        text: "San Francisco",
        normalized: "san francisco",
        kind: "capitalized_phrase",
      },
      {
        text: "Rachel's",
        normalized: "rachel s",
        kind: "capitalized_token",
      },
    ]);
  });

  test("prunes an unrelated fact without discarding valid grounded evidence", () => {
    const result = enforceReaderGrounding({
      question: "What did I reserve in San Francisco?",
      plan: {
        ...plan(),
        evidenceFacts: [
          {
            statement: "The reservation was in San Francisco.",
            sessionIds: ["matching"],
            graphPointers: [],
          },
          {
            statement: "An unrelated statement.",
            sessionIds: ["unselected"],
            graphPointers: [],
          },
        ],
      },
      sessions,
      graph,
    });

    expect(result.plan.supportStatus).toBe("sufficient");
    expect(result.plan.evidenceFacts).toHaveLength(1);
    expect(result.removedFactIndexes).toEqual([1]);
    expect(result.validation.valid).toBe(true);
  });

  test("forces abstention when question restatement is the only fact", () => {
    const question = "When did I reserve the Airbnb in Sacramento?";
    const result = enforceReaderGrounding({
      question,
      plan: plan({
        sessionId: "nearby-place",
        statement: `The user asked: "${question}"`,
      }),
      sessions,
      graph,
    });

    expect(result.plan).toMatchObject({
      supportStatus: "insufficient",
      answerMode: "abstain",
      selectedSessions: [],
      evidenceFacts: [],
    });
    expect(result.removedFactIndexes).toEqual([0]);
  });

  test("grounds a constraint through the adjacent user turn", () => {
    const pairedSessions: TimestampedSession[] = [{
      session_id: "recipe",
      date: "2025/01/01",
      turns: [
        {
          role: "user",
          content: "How many eggs are in a classic French omelette?",
        },
        {
          role: "assistant",
          content: "Use two or three eggs with butter and salt.",
        },
      ],
    }];
    const result = enforceReaderGrounding({
      question: "How many eggs are in a classic French omelette?",
      plan: {
        supportStatus: "sufficient",
        answerMode: "assistant_answer",
        selectedSessions: [{
          sessionId: "recipe",
          turnIndexes: [1],
          purpose: "direct_answer",
        }],
        selectedGraphPointers: [],
        evidenceFacts: [{
          statement: "The recipe uses two or three eggs.",
          sessionIds: ["recipe"],
          graphPointers: [],
        }],
        conflicts: [],
      },
      sessions: pairedSessions,
      graph,
    });

    expect(result.validation.valid).toBe(true);
    expect(result.plan.supportStatus).toBe("sufficient");
  });
});
