import { formatContextDigest } from "./formatContextDigest.js";
import { formatContextPackage } from "./formatContextPackage.js";
import { formatRetrievedMemory } from "./formatMemory.js";
import type { ContextDigest, ContextPackage } from "../types.js";
import type { RetrievalResult } from "../retrieval/types.js";
import { PromptLoader, type PromptEnvelope } from "../services/promptLoader.js";

export type AnswerPromptInput = {
  question: string;
  questionDate: string;
  retrieval: RetrievalResult;
  contextPackage?: ContextPackage | null;
  contextDigest?: ContextDigest | null;
  promptName?: string;
};

const PACKAGE_ONLY_PROMPTS = new Set([
  "answer-v3-package",
  "answer-v4-package",
  "answer-v5-package",
  "answer-v6-package",
]);

const DIGEST_ONLY_PROMPTS = new Set(["answer-v7-digest"]);

const DIGEST_AND_PACKAGE_PROMPTS = new Set(["answer-v7-hybrid"]);

/**
 * Load a prompts/<name>.yaml file and fill variables.
 * Bundle prompts use {{retrieved_memory}}; package prompts use {{context_package}};
 * digest prompts use {{context_digest}} (and optionally {{context_package}}).
 */
export async function renderAnswerPrompt(
  input: AnswerPromptInput,
  loader = new PromptLoader(),
): Promise<PromptEnvelope> {
  const promptName = input.promptName ?? "answer-v2-evidence";
  if (DIGEST_ONLY_PROMPTS.has(promptName)) {
    if (!input.contextDigest) {
      throw new Error(`${promptName} requires a context digest`);
    }
    return loader.render(promptName, {
      question: input.question,
      question_date: input.questionDate,
      context_digest: formatContextDigest(input.contextDigest),
    });
  }
  if (DIGEST_AND_PACKAGE_PROMPTS.has(promptName)) {
    if (!input.contextDigest) {
      throw new Error(`${promptName} requires a context digest`);
    }
    if (!input.contextPackage) {
      throw new Error(`${promptName} requires a context package`);
    }
    return loader.render(promptName, {
      question: input.question,
      question_date: input.questionDate,
      context_digest: formatContextDigest(input.contextDigest),
      context_package: formatContextPackage(input.contextPackage),
    });
  }
  if (PACKAGE_ONLY_PROMPTS.has(promptName)) {
    if (!input.contextPackage) {
      throw new Error(`${promptName} requires a context package`);
    }
    return loader.render(promptName, {
      question: input.question,
      question_date: input.questionDate,
      context_package: formatContextPackage(input.contextPackage),
    });
  }
  return loader.render(promptName, {
    question: input.question,
    question_date: input.questionDate,
    retrieved_memory: formatRetrievedMemory(input.retrieval.spans),
  });
}

export type SelectPromptInput = {
  question: string;
  questionDate: string;
  retrieval: RetrievalResult;
  packageMaxTurns: number;
  promptName?: string;
  sessionIndexText?: string;
  sessionExpandMax?: number;
};

export async function renderSelectPrompt(
  input: SelectPromptInput,
  loader = new PromptLoader(),
): Promise<PromptEnvelope> {
  const promptName = input.promptName ?? "select-v2";
  const variables: Record<string, string> = {
    question: input.question,
    question_date: input.questionDate,
    retrieved_memory: formatRetrievedMemory(input.retrieval.spans),
    package_max_turns: String(input.packageMaxTurns),
  };
  if (promptName === "select-v5") {
    variables.session_index = input.sessionIndexText ?? "(no sessions)";
    variables.session_expand_max = String(input.sessionExpandMax ?? 8);
  }
  // Legacy select-v1 still expects a turn_catalog variable.
  if (promptName === "select-v1") {
    const { formatSelectCatalog } = await import("./formatSelectCatalog.js");
    variables.turn_catalog = formatSelectCatalog(input.retrieval.spans);
  }
  return loader.render(promptName, variables);
}
