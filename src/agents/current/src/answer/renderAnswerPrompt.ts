import { formatContextPackage } from "./formatContextPackage.js";
import { formatRetrievedMemory } from "./formatMemory.js";
import type { ContextPackage } from "../types.js";
import type { RetrievalResult } from "../retrieval/types.js";
import { PromptLoader, type PromptEnvelope } from "../services/promptLoader.js";

export type AnswerPromptInput = {
  question: string;
  questionDate: string;
  retrieval: RetrievalResult;
  contextPackage?: ContextPackage | null;
  promptName?: string;
};

const PACKAGE_PROMPTS = new Set([
  "answer-v3-package",
  "answer-v4-package",
  "answer-v5-package",
]);

/**
 * Load a prompts/<name>.yaml file and fill variables.
 * Bundle prompts use {{retrieved_memory}}; package prompts use {{context_package}}.
 */
export async function renderAnswerPrompt(
  input: AnswerPromptInput,
  loader = new PromptLoader(),
): Promise<PromptEnvelope> {
  const promptName = input.promptName ?? "answer-v2-evidence";
  if (PACKAGE_PROMPTS.has(promptName)) {
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
  // Legacy select-v1 still expects a turn_catalog variable.
  if (promptName === "select-v1") {
    const { formatSelectCatalog } = await import("./formatSelectCatalog.js");
    variables.turn_catalog = formatSelectCatalog(input.retrieval.spans);
  }
  return loader.render(promptName, variables);
}
