import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ArchitectureCaseBundle,
  ArchitectureConversation,
  ArchitectureTurn,
  CompactArchitectureCase,
} from "./architectureDataset.js";

export const BEAM_SOURCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9";
export const BEAM_1M_PARQUET_SHA256 = "41b5acbbb55a586b1305514ef9d9fb03365d9b3331b598a1c2dd7603d93ef533";
export const BEAM_ABILITIES = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const;

export type BeamAbility = (typeof BEAM_ABILITIES)[number];

export type BeamCanaryManifest = {
  schema_version: number;
  benchmark: string;
  tier: string;
  name: string;
  role: string;
  source: {
    repository: string;
    commit: string;
    topics_sha256: string;
  };
  conversation_ids: number[];
  question_keys: string[];
  source_records: Array<{
    conversation_id: number;
    chat_sha256: string;
    probing_questions_sha256: string;
  }>;
};

type BeamMessage = {
  id?: number | string;
  role: string;
  content?: string;
  time_anchor?: string | null;
};

type BeamBatch = {
  time_anchor?: string | null;
  turns?: BeamMessage[][];
};

export type BeamProbe = {
  question?: string;
  difficulty?: string;
  source_chat_ids?: unknown;
  [key: string]: unknown;
};

export type BeamProbeFile = Record<BeamAbility, BeamProbe[]>;

export type BeamOracleEntry = {
  question_id: string;
  answer_session_ids: string[];
};

export type BeamSlice = {
  name: string;
  question_ids: string[];
  cases: Array<{
    question_id: string;
    stratum: string;
    question_type: BeamAbility;
  }>;
};

export type PreparedBeamDataset = {
  dataset: ArchitectureCaseBundle;
  oracle: BeamOracleEntry[];
  slice: BeamSlice;
  sourceFiles: Array<{
    conversation_id: number;
    chat_path: string;
    probing_questions_path: string;
    chat_sha256: string;
    probing_questions_sha256: string;
  }>;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function flattenNumericIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(flattenNumericIds);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(flattenNumericIds);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? [numeric] : [];
}

function questionKey(conversationId: number, ability: BeamAbility, ordinal: number): string {
  return `beam-1m/chat-${String(conversationId).padStart(2, "0")}/${ability}/${String(ordinal)}`;
}

function sessionId(conversationId: number, sessionIndex: number): string {
  return `beam1m_c${String(conversationId).padStart(2, "0")}_s${String(sessionIndex + 1).padStart(4, "0")}`;
}

function temporalLabel(sessionIndex: number, anchor: string | null): string {
  const position = `session-${String(sessionIndex + 1).padStart(4, "0")}`;
  return anchor ? `${position} | ${anchor}` : `${position} | no-explicit-time-anchor`;
}

function loadManifest(path: string): BeamCanaryManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BeamCanaryManifest;
  if (manifest.benchmark !== "BEAM" || manifest.tier !== "1M") {
    throw new Error("manifest must target BEAM 1M");
  }
  if (manifest.source.commit !== BEAM_SOURCE_COMMIT) {
    throw new Error(
      `manifest source commit ${manifest.source.commit} does not match ${BEAM_SOURCE_COMMIT}`,
    );
  }
  if (new Set(manifest.conversation_ids).size !== manifest.conversation_ids.length) {
    throw new Error("manifest contains duplicate conversation IDs");
  }
  if (new Set(manifest.question_keys).size !== manifest.question_keys.length) {
    throw new Error("manifest contains duplicate question keys");
  }
  return manifest;
}

function loadProbeFile(path: string): BeamProbeFile {
  const probes = JSON.parse(readFileSync(path, "utf8")) as BeamProbeFile;
  for (const ability of BEAM_ABILITIES) {
    if (!Array.isArray(probes[ability]) || probes[ability].length !== 2) {
      throw new Error(`${path}: ${ability} must contain exactly two probes`);
    }
  }
  return probes;
}

function buildConversation(args: {
  beamRoot: string;
  conversationId: number;
  expectedChatHash: string;
  expectedProbesHash: string;
  allowOfficialReencoding: boolean;
}): {
  conversation: ArchitectureConversation;
  probes: BeamProbeFile;
  messageToSession: Map<number, string>;
  finalAnchor: string | null;
  sourceFile: PreparedBeamDataset["sourceFiles"][number];
} {
  const chatPath = resolve(args.beamRoot, String(args.conversationId), "chat.json");
  const probesPath = resolve(
    args.beamRoot,
    String(args.conversationId),
    "probing_questions/probing_questions.json",
  );
  const chatRaw = readFileSync(chatPath);
  const probesRaw = readFileSync(probesPath);
  const actualChatHash = sha256(chatRaw);
  const actualProbesHash = sha256(probesRaw);
  if (actualChatHash !== args.expectedChatHash && !args.allowOfficialReencoding) {
    throw new Error(`conversation ${String(args.conversationId)} chat checksum mismatch`);
  }
  if (actualProbesHash !== args.expectedProbesHash && !args.allowOfficialReencoding) {
    throw new Error(`conversation ${String(args.conversationId)} probe checksum mismatch`);
  }

  const batches = JSON.parse(chatRaw.toString("utf8")) as BeamBatch[];
  const probes = loadProbeFile(probesPath);
  const sessionIds: string[] = [];
  const sessionDates: string[] = [];
  const sessions: ArchitectureTurn[][] = [];
  const messageToSession = new Map<number, string>();
  let currentAnchor: string | null = null;

  for (const batch of batches) {
    if (typeof batch.time_anchor === "string" && batch.time_anchor.trim()) {
      currentAnchor = batch.time_anchor.trim();
    }
    for (const group of batch.turns ?? []) {
      if (!Array.isArray(group) || group.length === 0) continue;
      const id = sessionId(args.conversationId, sessions.length);
      const turns: ArchitectureTurn[] = [];
      for (const message of group) {
        if (typeof message.time_anchor === "string" && message.time_anchor.trim()) {
          currentAnchor = message.time_anchor.trim();
        }
        if (message.role !== "user" && message.role !== "assistant") {
          throw new Error(
            `conversation ${String(args.conversationId)} contains unsupported role ${message.role}`,
          );
        }
        if (typeof message.content !== "string") {
          throw new Error(`conversation ${String(args.conversationId)} contains a message without content`);
        }
        const numericId = Number(message.id);
        if (!Number.isFinite(numericId)) {
          throw new Error(`conversation ${String(args.conversationId)} contains a non-numeric message ID`);
        }
        if (messageToSession.has(numericId)) {
          throw new Error(
            `conversation ${String(args.conversationId)} contains duplicate message ID ${String(numericId)}`,
          );
        }
        messageToSession.set(numericId, id);
        turns.push({ role: message.role, content: message.content });
      }
      sessionIds.push(id);
      sessionDates.push(temporalLabel(sessions.length, currentAnchor));
      sessions.push(turns);
    }
  }

  if (sessions.length === 0) {
    throw new Error(`conversation ${String(args.conversationId)} contains no sessions`);
  }
  return {
    conversation: {
      conversation_id: args.conversationId,
      session_ids: sessionIds,
      session_dates: sessionDates,
      sessions,
    },
    probes,
    messageToSession,
    finalAnchor: currentAnchor,
    sourceFile: {
      conversation_id: args.conversationId,
      chat_path: chatPath,
      probing_questions_path: probesPath,
      chat_sha256: actualChatHash,
      probing_questions_sha256: actualProbesHash,
    },
  };
}

export function prepareBeamDataset(args: {
  beamRoot: string;
  manifestPath: string;
  allowOfficialReencoding?: boolean;
}): PreparedBeamDataset {
  const manifest = loadManifest(args.manifestPath);
  const allowOfficialReencoding = args.allowOfficialReencoding === true
    && validateOfficialReencoding(args.beamRoot);
  const topicsPath = resolve(args.beamRoot, "topics.json");
  const topicsHash = sha256(readFileSync(topicsPath));
  if (topicsHash !== manifest.source.topics_sha256) {
    throw new Error("BEAM topics.json checksum does not match the frozen manifest");
  }
  const records = new Map(
    manifest.source_records.map((record) => [record.conversation_id, record]),
  );
  const allowedKeys = new Set(manifest.question_keys);
  const conversations: ArchitectureConversation[] = [];
  const cases: CompactArchitectureCase[] = [];
  const oracle: BeamOracleEntry[] = [];
  const sliceCases: BeamSlice["cases"] = [];
  const sourceFiles: PreparedBeamDataset["sourceFiles"] = [];

  for (const conversationId of manifest.conversation_ids) {
    const record = records.get(conversationId);
    if (!record) throw new Error(`manifest is missing source hashes for chat ${String(conversationId)}`);
    const prepared = buildConversation({
      beamRoot: args.beamRoot,
      conversationId,
      expectedChatHash: record.chat_sha256,
      expectedProbesHash: record.probing_questions_sha256,
      allowOfficialReencoding,
    });
    conversations.push(prepared.conversation);
    sourceFiles.push(prepared.sourceFile);

    for (const ability of BEAM_ABILITIES) {
      for (let index = 0; index < prepared.probes[ability].length; index += 1) {
        const probe = prepared.probes[ability][index];
        if (!probe) throw new Error("missing probe after fixed-length validation");
        const key = questionKey(conversationId, ability, index + 1);
        if (!allowedKeys.has(key)) continue;
        if (typeof probe.question !== "string" || probe.question.trim().length === 0) {
          throw new Error(`${key} has no question text`);
        }
        const sourceMessageIds = [...new Set(flattenNumericIds(probe.source_chat_ids))];
        const goldSessions = [...new Set(sourceMessageIds.map((messageId) => {
          const sourceSession = prepared.messageToSession.get(messageId);
          if (!sourceSession) {
            throw new Error(`${key} references missing message ID ${String(messageId)}`);
          }
          return sourceSession;
        }))];
        cases.push({
          question_id: key,
          question_type: ability,
          question: probe.question,
          question_date: prepared.finalAnchor ?? "no-explicit-time-anchor",
          conversation_id: conversationId,
        });
        oracle.push({ question_id: key, answer_session_ids: goldSessions });
        sliceCases.push({
          question_id: key,
          stratum: probe.difficulty?.trim().toLowerCase() || "unspecified",
          question_type: ability,
        });
      }
    }
  }

  const actualKeys = cases.map((item) => item.question_id);
  if (actualKeys.length !== manifest.question_keys.length) {
    throw new Error(
      `prepared ${String(actualKeys.length)} questions, expected ${String(manifest.question_keys.length)}`,
    );
  }
  const missingKeys = manifest.question_keys.filter((key) => !actualKeys.includes(key));
  if (missingKeys.length > 0) throw new Error(`manifest questions were not prepared: ${missingKeys.join(", ")}`);

  return {
    dataset: {
      schema_version: 1,
      format: "architecture-case-bundle-v1",
      benchmark: "BEAM",
      tier: "1M",
      conversations,
      cases,
    },
    oracle,
    slice: {
      name: manifest.name,
      question_ids: actualKeys,
      cases: sliceCases,
    },
    sourceFiles,
  };
}

function validateOfficialReencoding(beamRoot: string): boolean {
  const provenancePath = resolve(beamRoot, "source-provenance.json");
  if (!existsSync(provenancePath)) {
    throw new Error("official re-encoding requires source-provenance.json");
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
    parquet_path?: string;
    parquet_sha256?: string;
    official_source_commit?: string;
    generated_file_sha256?: Record<string, string>;
  };
  if (provenance.parquet_sha256 !== BEAM_1M_PARQUET_SHA256) {
    throw new Error("source provenance does not identify the official BEAM-1M parquet");
  }
  if (provenance.official_source_commit !== BEAM_SOURCE_COMMIT) {
    throw new Error("source provenance has the wrong BEAM commit");
  }
  if (!provenance.parquet_path || sha256(readFileSync(resolve(provenance.parquet_path))) !== BEAM_1M_PARQUET_SHA256) {
    throw new Error("official BEAM-1M parquet is missing or has changed");
  }
  const generated = provenance.generated_file_sha256 ?? {};
  for (const [relativePath, expected] of Object.entries(generated)) {
    const path = resolve(beamRoot, relativePath);
    if (!existsSync(path) || sha256(readFileSync(path)) !== expected) {
      throw new Error(`re-encoded BEAM source file changed: ${relativePath}`);
    }
  }
  return true;
}

export function loadBeamCanaryManifest(path: string): BeamCanaryManifest {
  return loadManifest(path);
}

export function beamQuestionKey(
  conversationId: number,
  ability: BeamAbility,
  ordinal: number,
): string {
  return questionKey(conversationId, ability, ordinal);
}

export function loadBeamProbes(path: string): BeamProbeFile {
  return loadProbeFile(path);
}
