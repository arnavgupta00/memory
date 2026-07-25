import { describe, expect, test } from "vitest";

import { Bm25Index } from "../src/retrieval/bm25.js";
import { renderSession } from "../src/retrieval/documents.js";
import { tokenizeRetrievalText } from "../src/retrieval/tokenize.js";
import type { RetrievalDocument } from "../src/retrieval/types.js";

function document(id: string, text: string): RetrievalDocument {
  return { id, text, channel: "session", sessionIds: [id], date: null };
}

describe("typed local BM25", () => {
  test("uses Unicode tokens and splits snake_case paths", () => {
    expect(tokenizeRetrievalText("café_visit preferred_recipe")).toEqual([
      "café",
      "visit",
      "preferr",
      "recipe",
    ]);
  });

  test("ranks lexical matches with stable document-ID tie breaking", () => {
    const index = new Bm25Index([
      document("b", "ceramic class"),
      document("a", "ceramic class"),
      document("z", "unrelated"),
    ]);
    expect(index.search("Which ceramic class?", 3).map((item) => item.documentId)).toEqual([
      "a",
      "b",
    ]);
  });

  test("boosts explicit temporal overlap but never removes lexical fallback", () => {
    const index = new Bm25Index([
      document("older", "festival happened in March 2023"),
      document("newer", "festival happened in April 2024"),
      document("undated", "festival happened"),
    ]);
    const results = index.search("Which festival happened in March 2023?", 3);
    expect(results[0]?.documentId).toBe("older");
    expect(results.map((item) => item.documentId)).toContain("undated");
  });

  test("rejects duplicate document IDs", () => {
    expect(() => new Bm25Index([
      document("same", "first"),
      document("same", "second"),
    ])).toThrow("duplicate retrieval document ID");
  });

  test("retains both user and assistant text in one session document", () => {
    const text = renderSession({
      session_id: "s1",
      date: "2025/01/01",
      turns: [
        { role: "user", content: "Which option did you recommend?" },
        { role: "assistant", content: "I recommended the amber package." },
      ],
    });
    expect(text).toContain("[user] Which option did you recommend?");
    expect(text).toContain("[assistant] I recommended the amber package.");
  });
});
