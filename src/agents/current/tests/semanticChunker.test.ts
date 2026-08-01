import { describe, expect, it } from "vitest";

import {
  chunkSemanticSession,
  semanticCorpusHash,
} from "../src/retrieval/semanticChunker.js";
import type { SemanticSession } from "../src/retrieval/semanticTypes.js";

function fixture(): SemanticSession {
  return {
    sessionId: "answer_private_identifier",
    date: "March-01-2024",
    annotation: {
      facts: [{ text: "The user selected the blue racket.", turn_index: 0 }],
      keyphrases: ["blue racket"],
      events: [],
    },
    turns: [
      { role: "user", content: "I selected the blue racket after the demo." },
      { role: "assistant", content: "The blue racket is now recorded." },
    ],
  };
}

describe("semantic session chunking", () => {
  it("keeps date, role and provenance while excluding raw session IDs", () => {
    const chunks = chunkSemanticSession(fixture());
    expect(chunks.map((item) => item.source)).toEqual(["notes", "user", "assistant"]);
    expect(chunks.every((item) => item.text.includes("March-01-2024"))).toBe(true);
    expect(chunks.every((item) => !item.text.includes("answer_private_identifier"))).toBe(true);
  });

  it("creates a deterministic question-independent corpus identity", () => {
    const first = fixture();
    const second = fixture();
    expect(semanticCorpusHash([first])).toBe(semanticCorpusHash([second]));
    second.turns[0] = { role: "user", content: "I selected the red racket." };
    expect(semanticCorpusHash([first])).not.toBe(semanticCorpusHash([second]));
  });
});
