import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  EvidenceRail,
  PipelineInspector,
  type PipelineView,
} from "./PipelineInspector";
import type { ObserverArtifacts } from "./types";

const observer: ObserverArtifacts = {
  schemaVersion: 1,
  legacy: false,
  coverage: {
    available: true,
    totals: {
      graphCovered: 3,
      duplicate: 1,
      sessionIndexFallback: 1,
      highPrioritySignals: 5,
    },
    records: [{
      batchId: "b0001",
      counts: {
        graphCovered: 3,
        duplicate: 1,
        sessionIndexFallback: 1,
      },
      signals: [{
        signalId: "signal-1",
        text: "The current role changed.",
        status: "graph_covered",
      }],
    }],
  },
  retrieval: {
    available: true,
    question: "What changed?",
    questionDate: "2025/01/02",
    algorithm: "bm25",
    parameters: { k1: 1.2, b: 0.75 },
    indexed: {
      session: 48,
      graphCell: 9,
      summary: 4,
      coverageFallback: 1,
      tail: 2,
    },
    candidates: {
      session: 12,
      graphCell: 3,
      summary: 1,
      coverageFallback: 1,
      tail: 1,
    },
    sessions: [{
      rank: 1,
      score: 8.2,
      matchedTerms: ["changed"],
      session: { session_id: "s1" },
    }],
    graphCells: [],
    summaries: [],
    coverageFallbackSessions: [],
    tailSessions: [],
  },
  readerPlan: {
    supportStatus: "sufficient",
    answerMode: "knowledge_update",
    selectedSessions: [{ sessionId: "s1" }],
    selectedGraphPointers: ["/context/work/current"],
    evidenceFacts: [{
      statement: "The current role changed.",
      sessionIds: ["s1"],
      graphPointers: [],
    }],
    conflicts: [],
    grounding: {
      validation: {
        valid: true,
        issues: [],
      },
    },
  },
  finalContext: {
    available: true,
    kind: "compact_reader_context",
    value: {
      question: "What changed?",
      readerPlan: {
        evidenceFacts: [{ statement: "The current role changed." }],
      },
      evidencePackage: {
        sessions: [{ sessionId: "s1" }],
        graphValues: [{ pointer: "/context/work/current" }],
      },
    },
  },
  roleMetrics: [{
    role: "reader",
    calls: 1,
    failures: 0,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    totalLatencyMs: 1000,
    averageLatencyMs: 1000,
    retries: 0,
    models: ["gpt-test"],
  }],
};

function renderView(view: PipelineView) {
  return render(
    <PipelineInspector
      observer={observer}
      modelCalls={[{ call: { role: "reader", model: "gpt-test" } }]}
      view={view}
    />,
  );
}

describe("Architecture 0003.2 observer panels", () => {
  test("shows the four-stage evidence rail", () => {
    render(<EvidenceRail observer={observer} />);
    expect(screen.getByLabelText("Evidence pipeline")).toBeTruthy();
    expect(screen.getByText("Contexto")).toBeTruthy();
    expect(screen.getByText("Retrieve")).toBeTruthy();
    expect(screen.getByText("Reader")).toBeTruthy();
    expect(screen.getByText("Answer")).toBeTruthy();
  });

  test.each([
    ["coverage", "80% directly covered"],
    ["retrieval", "LOSSLESS RETRIEVAL"],
    ["reader", "READER DECISION"],
    ["context", "Compact evidence package"],
    ["calls", "PER-ROLE COST SURFACE"],
  ] as const)("renders the %s observer view", (view, visibleText) => {
    renderView(view);
    expect(screen.getByText(visibleText)).toBeTruthy();
  });

  test("preserves a useful legacy empty state", () => {
    render(
      <PipelineInspector
        observer={{
          ...observer,
          legacy: true,
          coverage: {
            available: false,
            totals: {
              graphCovered: 0,
              duplicate: 0,
              sessionIndexFallback: 0,
              highPrioritySignals: 0,
            },
            records: [],
          },
        }}
        modelCalls={[]}
        view="coverage"
      />,
    );
    expect(screen.getByText("Contexto coverage was not recorded")).toBeTruthy();
    expect(screen.getByText(/predates this Architecture 0003.2/)).toBeTruthy();
  });
});
