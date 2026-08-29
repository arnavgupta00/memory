import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLinkGeneration,
  materializeTypedLink,
} from "../src/ingestion/structuredEventMaterializerV1.js";
import {
  TypedLinkCoreSchema,
  RawTurnSchema,
  SemanticRecordSchema,
  type LinkerOutput,
} from "../src/ingestion/structuredEventSchemaV1.js";
import {
  applyActiveLinkEvidenceFloor,
  applyLinkAudit,
  explicitClockMinutes,
  materializeLinkerOutputs,
  repeatedTurnSemanticCountMismatches,
} from "../src/ingestion/structuredEventWorkflowV1.js";
import { appendCustodyTransition } from "../src/ingestion/structuredEventCustodyV1.js";

const recordA = `record_${"a".repeat(64)}`;
const recordB = `record_${"b".repeat(64)}`;
const selector = `selector_${"c".repeat(64)}`;
const metadata = `metadata_${"d".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function update() {
  return {
    schemaVersion: 2 as const,
    type: "UPDATES" as const,
    sourceEndpoint: { endpointType: "record" as const, endpointId: recordA },
    targetEndpoint: { endpointType: "record" as const, endpointId: recordB },
    direction: "source_to_target" as const,
    affectedFieldPath: "/arguments/value",
    effectiveTime: { status: "unknown" as const, value: null },
    assertion: "explicit" as const,
    status: "confirmed" as const,
    confidence: "high" as const,
    provenanceBasis: [{
      basisKind: "source_span" as const,
      selectorIds: [selector],
      metadataSelectorIds: [],
      parsedValue: null,
      methodVersion: "fixture-v1",
    }],
  };
}

describe("query-blind typed links", () => {
  it("requires directional update field and provenance", () => {
    expect(TypedLinkCoreSchema.parse(update()).type).toBe("UPDATES");
    expect(TypedLinkCoreSchema.safeParse({ ...update(), affectedFieldPath: null }).success).toBe(false);
    expect(TypedLinkCoreSchema.safeParse({ ...update(), direction: "symmetric" }).success).toBe(false);
    expect(TypedLinkCoreSchema.safeParse({ ...update(), provenanceBasis: [{
      basisKind: "source_span", selectorIds: [], metadataSelectorIds: [], parsedValue: null, methodVersion: "x",
    }] }).success).toBe(false);
  });

  it("rejects endpoint type/ID mismatches", () => {
    expect(TypedLinkCoreSchema.safeParse({
      ...update(),
      sourceEndpoint: { endpointType: "mention", endpointId: recordA },
    }).success).toBe(false);
  });

  it("materializes links only inside the frozen endpoint/provenance scope", () => {
    const { schemaVersion: _schemaVersion, ...draft } = update();
    const output: LinkerOutput = { links: [draft], unresolvedRelations: [] };
    const accepted = materializeLinkerOutputs({
      outputs: [output],
      allowedEndpointIds: new Set([recordA, recordB]),
      allowedSelectorIds: new Set([selector]),
      allowedMetadataSelectorIds: new Set([metadata]),
    });
    expect(accepted[0]?.linkId).toMatch(/^link_[a-f0-9]{64}$/);
    expect(() => materializeLinkerOutputs({
      outputs: [output],
      allowedEndpointIds: new Set([recordA]),
      allowedSelectorIds: new Set([selector]),
      allowedMetadataSelectorIds: new Set([metadata]),
    })).toThrow(/outside the semantic freeze/);
  });

  it("freezes only independently accepted links and retains rejections as unresolved", () => {
    const { schemaVersion: _schemaVersion, ...draft } = update();
    const output: LinkerOutput = { links: [draft, { ...draft, type: "REFERS_TO", affectedFieldPath: null }], unresolvedRelations: [] };
    const audited = applyLinkAudit(output, {
      decisions: [
        { linkIndex: 0, accepted: true, reason: "explicit update is supported" },
        { linkIndex: 1, accepted: false, reason: "shared topic is not reference" },
      ],
    });
    expect(audited.links).toEqual([draft]);
    expect(audited.unresolvedRelations).toEqual([expect.objectContaining({
      attemptedType: "REFERS_TO",
      reason: expect.stringContaining("shared topic is not reference"),
    })]);
    expect(() => applyLinkAudit(output, {
      decisions: [{ linkIndex: 0, accepted: true, reason: "incomplete audit" }],
    })).toThrow(/exactly one decision/);
  });

  it("keeps only confirmed temporal links with two endpoint clocks in the declared direction", () => {
    const { schemaVersion: _schemaVersion, ...draft } = update();
    const valid = { ...draft, type: "BEFORE" as const, affectedFieldPath: null };
    const missingTargetTime = {
      ...valid,
      sourceEndpoint: { endpointType: "record" as const, endpointId: recordB },
      targetEndpoint: { endpointType: "record" as const, endpointId: recordA },
    };
    const uncertain = { ...draft, type: "REFERS_TO" as const, affectedFieldPath: null, status: "candidate" as const };
    const filtered = applyActiveLinkEvidenceFloor(
      { links: [valid, missingTargetTime, uncertain], unresolvedRelations: [] },
      { [recordA]: 17 * 60, [recordB]: 17 * 60 + 30 },
    );
    expect(filtered.links).toEqual([valid]);
    expect(filtered.unresolvedRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptedType: "BEFORE", reason: expect.stringContaining("two exact endpoint clocks") }),
      expect.objectContaining({ attemptedType: "REFERS_TO", reason: expect.stringContaining("confirmed status") }),
    ]));
    expect(explicitClockMinutes(["Dinner is at 5:30 PM."])).toBe(17 * 60 + 30);
    expect(explicitClockMinutes(["Entertainment: $50"])).toBeNull();
  });

  it("detects semantic loss at one exact duplicate USER occurrence", () => {
    const raw = (turnOrdinal: number) => RawTurnSchema.parse({
      schemaVersion: 2,
      rawTurnId: `rawturn_${String(turnOrdinal + 1).repeat(64)}`,
      archiveId: "archive",
      hostConversationId: "conversation",
      hostSessionId: "session",
      hostTurnId: `turn-${String(turnOrdinal)}`,
      role: "user",
      rawTimestamp: null,
      sessionOrdinal: 0,
      turnOrdinal,
      content: "Plan catering and invitations.",
      contentByteLength: 30,
      contentSha256: "9".repeat(64),
      transportArtifactSha256: null,
    });
    const semantic = (turnOrdinal: number, suffix: string) => SemanticRecordSchema.parse({
      schemaVersion: 2,
      recordKind: "intention",
      discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeSelectorId: null },
      predicate: { surface: `plan ${suffix}`, normalized: null },
      arguments: [],
      stance: {
        sourceSpeakerRole: "user", sourceSpeakerSurface: null, reportedSpeakerMentionId: null,
        speechAct: "intention", polarity: "positive", modalForce: "planned",
        eventStatus: "proposed", adoption: "not_applicable", speakerCertainty: "certain",
      },
      temporal: {
        assertionTime: { raw: null, precision: "unknown", source: "host_metadata" },
        sessionOrdinal: 0, turnOrdinal, validTimes: [],
      },
      claimSelectorIds: [selector],
      recordId: `record_${suffix.repeat(64).slice(0, 64)}`,
    });
    const turns = [raw(2), raw(4)];
    const records = [semantic(2, "a"), semantic(4, "b"), semantic(4, "c")];
    expect(repeatedTurnSemanticCountMismatches(turns, records)).toEqual([
      expect.objectContaining({ rawTurnId: turns[0]?.rawTurnId, actualRecordCount: 1, requiredRecordCount: 2 }),
    ]);
    expect(repeatedTurnSemanticCountMismatches(turns, [...records, semantic(2, "d")])).toEqual([]);
  });

  it("keeps link generations append-only and order-stable", () => {
    const one = materializeTypedLink(update());
    const generation = createLinkGeneration({
      linkIds: [one.linkId],
      mapperFreezeSha256: "e".repeat(64),
      linkerPromptSha256: "f".repeat(64),
      linkerModel: "fixture",
    });
    expect(generation.linkIds).toEqual([one.linkId]);
    expect(generation.generationId).toMatch(/^linkgen_[a-f0-9]{64}$/);
  });

  it("blocks any new link construction after evaluation unsealing", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "beam-custody-"));
    temporaryDirectories.push(directory);
    const ledgerPath = resolve(directory, "custody.jsonl");
    const cohortHash = "1".repeat(64);
    const semanticFreezeSha256 = "2".repeat(64);
    const linkFreezeSha256 = "3".repeat(64);
    appendCustodyTransition({ ledgerPath, cohortHash, state: "semantic_frozen", semanticFreezeSha256 });
    appendCustodyTransition({ ledgerPath, cohortHash, state: "link_frozen", semanticFreezeSha256, linkFreezeSha256 });
    appendCustodyTransition({
      ledgerPath, cohortHash, state: "evaluation_unsealed", semanticFreezeSha256, linkFreezeSha256,
      evaluationManifestSha256: "4".repeat(64),
    });
    expect(() => appendCustodyTransition({
      ledgerPath, cohortHash, state: "link_frozen", semanticFreezeSha256, linkFreezeSha256,
    })).toThrow(/before evaluation unsealing/);
  });
});
