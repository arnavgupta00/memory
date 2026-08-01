import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSemanticCorpus,
  SemanticCorpusIndex,
  SemanticIndexSet,
  writeSemanticCorpus,
  writeSemanticIndexSet,
} from "../src/retrieval/semanticIndex.js";
import type {
  SemanticDocumentEmbeddingResult,
  SemanticEmbeddingProvider,
  SemanticIndexSetManifest,
  SemanticQueryEmbeddingResult,
  SemanticSession,
} from "../src/retrieval/semanticTypes.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeProvider implements SemanticEmbeddingProvider {
  readonly config = {
    provider: "voyage" as const,
    model: "fake-contextual",
    dimension: 2,
    maxConcurrency: 1,
  };

  embedDocuments(documents: Array<{ sessionId: string; chunks: string[] }>): Promise<SemanticDocumentEmbeddingResult> {
    return Promise.resolve({
      vectors: documents.map((document) =>
        document.chunks.map((text) => text.includes("alpha") ? [1, 0] : [0, 1])),
      usage: { inputTokens: 10, requests: 1, exactTokenCount: true },
    });
  }

  embedQueries(queries: string[]): Promise<SemanticQueryEmbeddingResult> {
    return Promise.resolve({
      vectors: queries.map((query) => query.includes("alpha") ? [1, 0] : [0, 1]),
      usage: { inputTokens: queries.length, requests: 1, exactTokenCount: true },
    });
  }
}

function sessions(): SemanticSession[] {
  return [
    {
      sessionId: "session_alpha",
      date: "2024-01-01",
      annotation: undefined,
      turns: [{ role: "user", content: "alpha evidence" }],
    },
    {
      sessionId: "session_beta",
      date: "2024-01-02",
      annotation: undefined,
      turns: [{ role: "user", content: "beta evidence" }],
    },
  ];
}

describe("SemanticCorpusIndex", () => {
  it("round-trips normalized vectors and returns best sessions", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "semantic-index-test-"));
    temporaryDirectories.push(root);
    const corpus = await buildSemanticCorpus({ sessions: sessions(), provider: new FakeProvider() });
    writeSemanticCorpus(root, corpus);
    const setManifest: SemanticIndexSetManifest = {
      schema_version: 1,
      format: "semantic-index-set-v1",
      provider: "voyage",
      model: "fake-contextual",
      dimension: 2,
      chunker_version: corpus.manifest.chunker_version,
      corpora: [{
        corpus_hash: corpus.manifest.corpus_hash,
        session_count: corpus.manifest.session_count,
        chunk_count: corpus.manifest.chunk_count,
      }],
      total_input_tokens: corpus.manifest.input_tokens,
      total_embedding_requests: corpus.manifest.embedding_requests,
      exact_token_count: true,
      created_at: new Date().toISOString(),
    };
    writeSemanticIndexSet(root, setManifest);
    const indexSet = new SemanticIndexSet(root);
    const hits = indexSet.load(corpus.manifest.corpus_hash).searchSessions([1, 0], 2);
    expect(hits.map((item) => item.sessionId)).toEqual(["session_alpha", "session_beta"]);
    expect(hits[0]?.score).toBeCloseTo(1);
  });

  it("rejects corrupted vector files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "semantic-index-corrupt-"));
    temporaryDirectories.push(root);
    const corpus = await buildSemanticCorpus({ sessions: sessions(), provider: new FakeProvider() });
    const corpusDir = writeSemanticCorpus(root, corpus);
    const vectorsPath = resolve(corpusDir, "vectors.f32");
    const vectors = readFileSync(vectorsPath);
    vectors[0] = (vectors[0] ?? 0) ^ 0xff;
    writeFileSync(vectorsPath, vectors);
    expect(() => new SemanticCorpusIndex(corpusDir)).toThrow(/hash mismatch/u);
  });
});
