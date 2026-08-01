import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  chunkSemanticSession,
  SEMANTIC_CHUNKER_VERSION,
  semanticCorpusHash,
} from "./semanticChunker.js";
import type {
  SemanticChunk,
  SemanticCorpusManifest,
  SemanticDocumentEmbeddingInput,
  SemanticEmbeddingProvider,
  SemanticIndexSetManifest,
  SemanticSession,
  SemanticSessionHit,
} from "./semanticTypes.js";

const CORPUS_MANIFEST = "manifest.json";
const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.f32";
const INDEX_SET_MANIFEST = "index-set.json";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeVector(vector: number[], dimension: number): Float32Array {
  if (vector.length !== dimension) {
    throw new Error(`embedding dimension ${String(vector.length)} does not match ${String(dimension)}`);
  }
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("embedding contains a non-finite value");
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (norm === 0) throw new Error("embedding vector has zero norm");
  return Float32Array.from(vector, (value) => value / norm);
}

function vectorBuffer(vectors: Float32Array[], dimension: number): Buffer {
  const buffer = Buffer.allocUnsafe(vectors.length * dimension * Float32Array.BYTES_PER_ELEMENT);
  let offset = 0;
  for (const vector of vectors) {
    if (vector.length !== dimension) throw new Error("inconsistent vector dimension");
    for (const value of vector) {
      buffer.writeFloatLE(value, offset);
      offset += Float32Array.BYTES_PER_ELEMENT;
    }
  }
  return buffer;
}

function parseCorpusManifest(path: string): SemanticCorpusManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).schema_version !== 1
    || typeof (parsed as Record<string, unknown>).corpus_hash !== "string"
    || Number((parsed as Record<string, unknown>).dimension) <= 0
  ) {
    throw new Error(`invalid semantic corpus manifest: ${path}`);
  }
  return parsed as SemanticCorpusManifest;
}

export type BuiltSemanticCorpus = {
  manifest: SemanticCorpusManifest;
  chunks: SemanticChunk[];
  vectors: Float32Array[];
};

export async function buildSemanticCorpus(args: {
  sessions: SemanticSession[];
  provider: SemanticEmbeddingProvider;
}): Promise<BuiltSemanticCorpus> {
  const documents: SemanticDocumentEmbeddingInput[] = [];
  const chunks: SemanticChunk[] = [];
  for (const session of args.sessions) {
    const sessionChunks = chunkSemanticSession(session);
    chunks.push(...sessionChunks);
    documents.push({ sessionId: session.sessionId, chunks: sessionChunks.map((item) => item.text) });
  }
  const embedded = await args.provider.embedDocuments(documents);
  if (embedded.vectors.length !== documents.length) {
    throw new Error("semantic provider returned an unexpected document count");
  }
  const vectors: Float32Array[] = [];
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    const expected = documents[documentIndex]?.chunks.length ?? 0;
    const returned = embedded.vectors[documentIndex] ?? [];
    if (returned.length !== expected) {
      throw new Error(`semantic provider returned an unexpected chunk count for document ${String(documentIndex)}`);
    }
    for (const vector of returned) {
      vectors.push(normalizeVector(vector, args.provider.config.dimension));
    }
  }
  if (vectors.length !== chunks.length) {
    throw new Error("semantic chunk/vector count mismatch");
  }
  const chunksJson = `${JSON.stringify(chunks)}\n`;
  const vectorsBinary = vectorBuffer(vectors, args.provider.config.dimension);
  const manifest: SemanticCorpusManifest = {
    schema_version: 1,
    corpus_hash: semanticCorpusHash(args.sessions),
    provider: args.provider.config.provider,
    model: args.provider.config.model,
    dimension: args.provider.config.dimension,
    chunker_version: SEMANTIC_CHUNKER_VERSION,
    session_count: args.sessions.length,
    chunk_count: chunks.length,
    input_tokens: embedded.usage.inputTokens,
    embedding_requests: embedded.usage.requests,
    exact_token_count: embedded.usage.exactTokenCount,
    vectors_sha256: sha256(vectorsBinary),
    chunks_sha256: sha256(chunksJson),
    created_at: new Date().toISOString(),
  };
  return { manifest, chunks, vectors };
}

export function writeSemanticCorpus(root: string, corpus: BuiltSemanticCorpus): string {
  const corpusDir = resolve(root, corpus.manifest.corpus_hash);
  mkdirSync(corpusDir, { recursive: true });
  const chunksJson = `${JSON.stringify(corpus.chunks)}\n`;
  const vectorsBinary = vectorBuffer(corpus.vectors, corpus.manifest.dimension);
  writeFileSync(resolve(corpusDir, CHUNKS_FILE), chunksJson);
  writeFileSync(resolve(corpusDir, VECTORS_FILE), vectorsBinary);
  writeFileSync(
    resolve(corpusDir, CORPUS_MANIFEST),
    `${JSON.stringify(corpus.manifest, null, 2)}\n`,
  );
  return corpusDir;
}

export function writeSemanticIndexSet(
  root: string,
  manifest: SemanticIndexSetManifest,
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, INDEX_SET_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readSemanticIndexSetManifest(root: string): SemanticIndexSetManifest {
  const path = resolve(root, INDEX_SET_MANIFEST);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).schema_version !== 1
    || (parsed as Record<string, unknown>).format !== "semantic-index-set-v1"
  ) {
    throw new Error(`invalid semantic index set: ${path}`);
  }
  return parsed as SemanticIndexSetManifest;
}

export class SemanticCorpusIndex {
  readonly manifest: SemanticCorpusManifest;
  readonly chunks: SemanticChunk[];
  readonly #vectors: Buffer;

  constructor(corpusDir: string) {
    this.manifest = parseCorpusManifest(resolve(corpusDir, CORPUS_MANIFEST));
    const chunksPath = resolve(corpusDir, CHUNKS_FILE);
    const vectorsPath = resolve(corpusDir, VECTORS_FILE);
    const chunksText = readFileSync(chunksPath, "utf8");
    this.#vectors = readFileSync(vectorsPath);
    if (sha256(chunksText) !== this.manifest.chunks_sha256) {
      throw new Error(`semantic chunks hash mismatch: ${chunksPath}`);
    }
    if (sha256(this.#vectors) !== this.manifest.vectors_sha256) {
      throw new Error(`semantic vectors hash mismatch: ${vectorsPath}`);
    }
    this.chunks = JSON.parse(chunksText) as SemanticChunk[];
    const expectedBytes = this.chunks.length
      * this.manifest.dimension
      * Float32Array.BYTES_PER_ELEMENT;
    if (this.#vectors.length !== expectedBytes || this.chunks.length !== this.manifest.chunk_count) {
      throw new Error(`semantic index size mismatch: ${corpusDir}`);
    }
  }

  searchSessions(queryVector: number[], topK: number): SemanticSessionHit[] {
    const query = normalizeVector(queryVector, this.manifest.dimension);
    const bestBySession = new Map<string, { score: number; chunk: SemanticChunk }>();
    const dimension = this.manifest.dimension;
    for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex];
      if (!chunk) continue;
      let score = 0;
      let byteOffset = chunkIndex * dimension * Float32Array.BYTES_PER_ELEMENT;
      for (let index = 0; index < dimension; index += 1) {
        score += (query[index] ?? 0) * this.#vectors.readFloatLE(byteOffset);
        byteOffset += Float32Array.BYTES_PER_ELEMENT;
      }
      const current = bestBySession.get(chunk.sessionId);
      if (!current || score > current.score) bestBySession.set(chunk.sessionId, { score, chunk });
    }
    return [...bestBySession.entries()]
      .sort(
        ([leftId, left], [rightId, right]) =>
          right.score - left.score || leftId.localeCompare(rightId),
      )
      .slice(0, Math.max(0, topK))
      .map(([sessionId, hit], index) => ({
        sessionId,
        rank: index + 1,
        score: hit.score,
        chunk: hit.chunk,
      }));
  }
}

export class SemanticIndexSet {
  readonly root: string;
  readonly manifest: SemanticIndexSetManifest;
  readonly #cache = new Map<string, SemanticCorpusIndex>();

  constructor(root: string) {
    this.root = root;
    this.manifest = readSemanticIndexSetManifest(root);
  }

  has(corpusHash: string): boolean {
    return existsSync(resolve(this.root, corpusHash, CORPUS_MANIFEST));
  }

  load(corpusHash: string): SemanticCorpusIndex {
    const cached = this.#cache.get(corpusHash);
    if (cached) return cached;
    if (!this.has(corpusHash)) {
      throw new Error(`semantic corpus ${corpusHash} is missing from ${this.root}`);
    }
    const index = new SemanticCorpusIndex(resolve(this.root, corpusHash));
    if (
      index.manifest.provider !== this.manifest.provider
      || index.manifest.model !== this.manifest.model
      || index.manifest.dimension !== this.manifest.dimension
    ) {
      throw new Error(`semantic corpus ${corpusHash} does not match its index-set provider`);
    }
    this.#cache.set(corpusHash, index);
    return index;
  }
}
