import type { ArchitectureTurn } from "../benchmarks/architectureDataset.js";
import type { SessionAnnotation } from "./notesIndex.js";

export type SemanticProviderId = "voyage" | "gemini" | "openai";

export type SemanticProviderConfig = {
  provider: SemanticProviderId;
  model: string;
  dimension: number;
  maxConcurrency: number;
};

export type SemanticSession = {
  sessionId: string;
  date: string;
  turns: ArchitectureTurn[];
  annotation: SessionAnnotation | undefined;
};

export type SemanticChunkSource = "notes" | "user" | "assistant";

export type SemanticChunk = {
  chunkId: string;
  sessionId: string;
  sessionDate: string;
  source: SemanticChunkSource;
  turnIndex: number | null;
  partIndex: number;
  text: string;
};

export type SemanticDocumentEmbeddingInput = {
  sessionId: string;
  chunks: string[];
};

export type SemanticEmbeddingUsage = {
  inputTokens: number;
  requests: number;
  exactTokenCount: boolean;
};

export type SemanticDocumentEmbeddingResult = {
  vectors: number[][][];
  usage: SemanticEmbeddingUsage;
};

export type SemanticQueryEmbeddingResult = {
  vectors: number[][];
  usage: SemanticEmbeddingUsage;
};

export interface SemanticEmbeddingProvider {
  readonly config: SemanticProviderConfig;
  embedDocuments(
    documents: SemanticDocumentEmbeddingInput[],
  ): Promise<SemanticDocumentEmbeddingResult>;
  embedQueries(queries: string[]): Promise<SemanticQueryEmbeddingResult>;
}

export type SemanticCorpusManifest = {
  schema_version: 1;
  corpus_hash: string;
  provider: SemanticProviderId;
  model: string;
  dimension: number;
  chunker_version: string;
  session_count: number;
  chunk_count: number;
  input_tokens: number;
  embedding_requests: number;
  exact_token_count: boolean;
  vectors_sha256: string;
  chunks_sha256: string;
  created_at: string;
};

export type SemanticIndexSetManifest = {
  schema_version: 1;
  format: "semantic-index-set-v1";
  provider: SemanticProviderId;
  model: string;
  dimension: number;
  chunker_version: string;
  corpora: Array<{
    corpus_hash: string;
    session_count: number;
    chunk_count: number;
  }>;
  total_input_tokens: number;
  total_embedding_requests: number;
  exact_token_count: boolean;
  created_at: string;
};

export type SemanticSessionHit = {
  sessionId: string;
  rank: number;
  score: number;
  chunk: SemanticChunk;
};
