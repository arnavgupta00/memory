import { readFileSync } from "node:fs";

export type ArchitectureTurn = {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
};

export type ArchitectureCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: ArchitectureTurn[][];
};

export type ArchitectureConversation = {
  conversation_id: number;
  session_ids: string[];
  session_dates: string[];
  sessions: ArchitectureTurn[][];
};

export type CompactArchitectureCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  conversation_id: number;
};

export type ArchitectureCaseBundle = {
  schema_version: 1;
  format: "architecture-case-bundle-v1";
  benchmark: string;
  tier?: string;
  conversations: ArchitectureConversation[];
  cases: CompactArchitectureCase[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCase(value: unknown, label: string): asserts value is ArchitectureCase {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (typeof value.question_id !== "string" || value.question_id.length === 0) {
    throw new Error(`${label}.question_id must be a non-empty string`);
  }
  if (!Array.isArray(value.haystack_session_ids)
    || !Array.isArray(value.haystack_dates)
    || !Array.isArray(value.haystack_sessions)) {
    throw new Error(`${label} must contain haystack session IDs, dates, and sessions`);
  }
  if (
    value.haystack_session_ids.length !== value.haystack_dates.length
    || value.haystack_session_ids.length !== value.haystack_sessions.length
  ) {
    throw new Error(`${label} haystack arrays must have identical lengths`);
  }
}

function materializeBundle(bundle: ArchitectureCaseBundle): ArchitectureCase[] {
  const conversations = new Map<number, ArchitectureConversation>();
  for (const conversation of bundle.conversations) {
    if (conversations.has(conversation.conversation_id)) {
      throw new Error(`duplicate conversation ${String(conversation.conversation_id)}`);
    }
    if (
      conversation.session_ids.length !== conversation.session_dates.length
      || conversation.session_ids.length !== conversation.sessions.length
    ) {
      throw new Error(
        `conversation ${String(conversation.conversation_id)} session arrays have different lengths`,
      );
    }
    conversations.set(conversation.conversation_id, conversation);
  }

  const questionIds = new Set<string>();
  return bundle.cases.map((item) => {
    if (questionIds.has(item.question_id)) {
      throw new Error(`duplicate question ${item.question_id}`);
    }
    questionIds.add(item.question_id);
    const conversation = conversations.get(item.conversation_id);
    if (!conversation) {
      throw new Error(
        `question ${item.question_id} references missing conversation ${String(item.conversation_id)}`,
      );
    }
    return {
      question_id: item.question_id,
      question_type: item.question_type,
      question: item.question,
      question_date: item.question_date,
      haystack_session_ids: conversation.session_ids,
      haystack_dates: conversation.session_dates,
      haystack_sessions: conversation.sessions,
    };
  });
}

/**
 * Load either the canonical LongMemEval case array or the compact, shared-chat
 * bundle used by BEAM. The legacy array path is returned without transformation.
 */
export function loadArchitectureCases(path: string): ArchitectureCase[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) {
    const cases: ArchitectureCase[] = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const item: unknown = parsed[index];
      assertCase(item, `dataset[${String(index)}]`);
      cases.push(item);
    }
    return cases;
  }
  if (!isObject(parsed) || parsed.format !== "architecture-case-bundle-v1") {
    throw new Error("dataset must be a LongMemEval case array or architecture-case-bundle-v1");
  }
  const bundle = parsed as ArchitectureCaseBundle;
  if (!Array.isArray(bundle.conversations) || !Array.isArray(bundle.cases)) {
    throw new Error("architecture case bundle is missing conversations or cases");
  }
  return materializeBundle(bundle);
}
