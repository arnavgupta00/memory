import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync } from "node:fs";

import { z } from "zod";

import { Sha256Schema, canonicalJson, contentAddress, type JsonValue } from "./structuredEventSchemaV1.js";

export const CustodyEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  custodyEventId: z.string().regex(/^custody_[a-f0-9]{64}$/),
  cohortHash: Sha256Schema,
  state: z.enum(["semantic_frozen", "link_frozen", "evaluation_unsealed"]),
  semanticFreezeSha256: Sha256Schema,
  linkFreezeSha256: Sha256Schema.nullable(),
  evaluationManifestSha256: Sha256Schema.nullable(),
  at: z.string().datetime(),
});
export type CustodyEvent = z.infer<typeof CustodyEventSchema>;

function rows(path: string): CustodyEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => CustodyEventSchema.parse(JSON.parse(line)));
}

function append(path: string, event: CustodyEvent): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function appendCustodyTransition(args: {
  ledgerPath: string;
  cohortHash: string;
  state: CustodyEvent["state"];
  semanticFreezeSha256: string;
  linkFreezeSha256?: string | null;
  evaluationManifestSha256?: string | null;
  now?: Date;
}): CustodyEvent {
  const lockPath = `${args.ledgerPath}.transition.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    const prior = [...rows(args.ledgerPath)].reverse().find((row) => row.cohortHash === args.cohortHash);
    if (args.state === "semantic_frozen" && prior) {
      throw new Error(`cohort custody already advanced to ${prior.state}`);
    }
    if (args.state === "link_frozen" && prior?.state !== "semantic_frozen") {
      throw new Error("link construction is allowed only immediately after semantic freeze and before evaluation unsealing");
    }
    if (args.state === "evaluation_unsealed" && prior?.state !== "link_frozen") {
      throw new Error("evaluation can unseal only after the query-blind link freeze");
    }
    const core = {
      cohortHash: args.cohortHash,
      state: args.state,
      semanticFreezeSha256: args.semanticFreezeSha256,
      linkFreezeSha256: args.linkFreezeSha256 ?? null,
      evaluationManifestSha256: args.evaluationManifestSha256 ?? null,
      at: (args.now ?? new Date()).toISOString(),
    } satisfies JsonValue;
    const event = CustodyEventSchema.parse({
      schemaVersion: 1,
      custodyEventId: `custody_${contentAddress("beam.custody_event.v1", core)}`,
      ...core,
    });
    append(args.ledgerPath, event);
    return event;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function latestCustodyState(path: string, cohortHash: string): CustodyEvent | null {
  return [...rows(path)].reverse().find((row) => row.cohortHash === cohortHash) ?? null;
}
