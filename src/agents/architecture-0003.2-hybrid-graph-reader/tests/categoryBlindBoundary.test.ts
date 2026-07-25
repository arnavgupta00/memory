import { describe, expect, test } from "vitest";

import { emptyState } from "../src/state.js";
import { CaseMetadataSchema } from "../src/types.js";

describe("category-blind agent boundary", () => {
  test("accepts only an opaque case ID and rejects benchmark category metadata", () => {
    expect(CaseMetadataSchema.parse({ question_id: "case-1" })).toEqual({
      question_id: "case-1",
    });
    expect(
      CaseMetadataSchema.safeParse({
        question_id: "case-1",
        question_type: "invented-category",
      }).success,
    ).toBe(false);
    expect(emptyState("case-1")).not.toHaveProperty("questionType");
  });
});
