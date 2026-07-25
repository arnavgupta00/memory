import { formatRetrievedMemory } from "./formatMemory.js";
import type { RetrievalResult } from "../retrieval/types.js";
import { PromptLoader, type PromptEnvelope } from "../services/promptLoader.js";

export type AnswerPromptInput = {
  question: string;
  questionDate: string;
  retrieval: RetrievalResult;
  promptName?: string;
};

/**
 * Load a prompts/<name>.yaml file and fill {{question}}, {{question_date}},
 * {{retrieved_memory}}.
 */
export async function renderAnswerPrompt(
  input: AnswerPromptInput,
  loader = new PromptLoader(),
): Promise<PromptEnvelope> {
  return loader.render(input.promptName ?? "answer-v2-simple", {
    question: input.question,
    question_date: input.questionDate,
    retrieved_memory: formatRetrievedMemory(input.retrieval.spans),
  });
}
