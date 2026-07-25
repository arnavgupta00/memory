import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

function listFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("evidence-label isolation", () => {
  test("retrieval source never references has_answer or answer_session_ids", () => {
    const root = join(import.meta.dirname, "../src/retrieval");
    const forbidden = [/has_answer/, /answer_session_ids/];
    for (const file of listFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(text, `${file} must not mention ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });
});
