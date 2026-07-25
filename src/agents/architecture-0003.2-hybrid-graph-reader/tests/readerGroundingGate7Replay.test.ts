import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enforceReaderGrounding } from "../src/services/readerGrounding.js";
import {
  MasterContextGraphSchema,
  ReaderPlanSchema,
  TimestampedSessionSchema,
} from "../src/types.js";

const DEV_CASE_IDS = ["7161e7e2", "488d3006", "54026fce"] as const;
const runRoot = resolve(
  import.meta.dirname,
  "../../../..",
  "runs/gate-07-blind-18-0003-2-b3c9-002/agent-artifacts/cases",
);
const hasSavedGate7Artifacts = DEV_CASE_IDS.every((caseId) =>
  existsSync(resolve(runRoot, caseId, "model-calls/reader-final.json"))
);
const ReaderArtifactSchema = z.looseObject({
  validatedResponse: ReaderPlanSchema,
});
const QuestionArtifactSchema = z.looseObject({
  question: z.string().min(1),
});

describe.skipIf(!hasSavedGate7Artifacts)(
  "saved Gate-7 reader grounding replay (zero API calls)",
  () => {
    test.each(DEV_CASE_IDS)(
      "%s preserves its sufficient Reader plan",
      async (caseId) => {
        const caseRoot = resolve(runRoot, caseId);
        const rawPlan = ReaderArtifactSchema.parse(JSON.parse(
          await readFile(
            resolve(caseRoot, "model-calls/reader-final.json"),
            "utf8",
          ),
        )).validatedResponse;
        const question = QuestionArtifactSchema.parse(JSON.parse(
          await readFile(resolve(caseRoot, "final-context.json"), "utf8"),
        )).question;
        const sessions = (await readFile(
          resolve(caseRoot, "sessions.jsonl"),
          "utf8",
        ))
          .split("\n")
          .filter(Boolean)
          .map((line) => TimestampedSessionSchema.parse(JSON.parse(line)));
        const graph = MasterContextGraphSchema.parse(JSON.parse(
          await readFile(resolve(caseRoot, "final-graph.json"), "utf8"),
        ));

        expect(rawPlan.supportStatus).toBe("sufficient");
        const replay = enforceReaderGrounding({
          question,
          plan: rawPlan,
          sessions,
          graph,
        });

        expect(replay.validation).toMatchObject({
          valid: true,
          action: "accept",
          issues: [],
        });
        expect(replay.plan).toEqual(rawPlan);
        expect(
          replay.validation.anchors.map((anchor) => anchor.text),
        ).not.toContain("I'm");
        expect(
          replay.validation.anchors.map((anchor) => anchor.text),
        ).not.toContain("I've");
      },
    );
  },
);
