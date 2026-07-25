# 0002 — Hierarchical Temporal Context Graph

## Goal

Build an interpretable memory before the final answer model sees the question context. Sessions
arrive one at a time, but one consolidation call runs per configured batch. The first controlled
comparison uses `B=3` and `B=9`; only `name` and `agent.options.batch_size` differ between those two
OpenAI configurations.

Architecture 0002 intentionally has no embedding model and no macro-reflection layer. Those are
future interventions only if the artifacts reveal semantic retrieval misses or insufficient
cross-batch synthesis.

## Construction flow

For each session, the agent stores the sanitized timestamped turns and appends a `session_ingested`
event. When the buffer reaches `B`, or `answer()` flushes a final remainder:

1. `batch_consolidator.yaml` receives the batch, entity catalog, and active graph state.
2. The configured consolidation role returns a schema-constrained `ConsolidationOutput`.
3. Local validation rejects bad provenance and malformed references.
4. The conservative resolver reuses exact canonical-name/alias matches and assigns UUIDv5 entity
   IDs for new identities. Ambiguous identities stay separate with warnings.
5. The reducer applies accepted operations append-only and emits RFC 6901 JSON Pointer diffs.
6. A `BatchRecord`, graph hash, operation decisions, warnings, and provenance enter the event chain.

Nominal memory calls are `ceil(N / B)`. The final one or two sessions in a B=3 run, or one through
eight sessions in a B=9 run, are not lost: the question-time flush includes them in the same formula.

## Canonical memory

The canonical temporal property graph contains four record families:

- `Entity`: stable identity, dynamic singular snake_case kind, names, aliases, and properties;
- `Claim`: subject, explicit predicate, JSON value, valid/observed time, status, and provenance;
- `Relation`: source/target entity IDs, explicit predicate, valid/observed time, and status;
- `MemoryEvent`: event type, participants, occurrence time, properties, and provenance.

LLMs produce draft operations, never canonical IDs. Valid time and observation time stay separate.
Unknown time remains null. Prior values are retained as `superseded` or `contradicted`; the reducer
never deletes memory history.

The nested context tree is derived from this graph for inspection. It is not a second memory store.

## Question flow

Each question makes exactly three agent LLM calls:

1. `query_planner.yaml` returns entity hints, lexical terms, predicates, time constraints, and zero
   to two likely graph hops.
2. Local retrieval runs BM25, entity/alias, predicate, two-hop graph, temporal, batch-summary, and
   latest-session channels. Reciprocal-rank fusion emits at most 30 compact candidates.
3. `evidence_reranker.yaml` selects at most 12 candidate IDs.
4. The local compiler expands evidence to at most eight historical sessions and adds the latest
   nine, graph projection, complete batch index, relevant diffs, contradictions, and provenance.
5. `final_answer.yaml` returns a hypothesis, evidence references, and
   `supported | conflicted | insufficient`.
6. The local mapper rejects unknown session references and produces the benchmark `AnswerResult`.

Total agent calls are therefore `ceil(N / B) + 3`. The canonical GPT-4o judge is one additional
external benchmark call and is not part of the memory architecture. Embedding calls are zero.

## Durability and resume

Every case owns an ignored artifact namespace:

```text
runs/<run-id>/agent-artifacts/cases/<question-id>/
├── sessions.jsonl
├── events.jsonl
├── batches/
├── model-calls/calls.jsonl
├── final-graph.json
├── final-context.json
├── answer.json
└── final.svg
```

`events.jsonl` is the source of truth. Events contain schema versions, monotonic sequence numbers,
timestamps, previous-event hashes, graph-state hashes, and accepted batch payloads. Resume replays
completed batches, verifies their hashes, restores any archived partial buffer, skips the processed
session prefix, and repeats only an incomplete consolidation call.

When enabled, model-I/O capture stores the rendered prompt envelope, response schema, raw response,
validated response, usage, latency, model, and request ID. The artifact store redacts known secrets
and key-like fields before disk. Publication freezing continues to exclude these diagnostic files.

## Memory Observatory

The inspector is a passive, localhost-only reader:

```bash
memorybench ui build
memorybench ui start --open
memorybench ui open --run RUN_ID
memorybench ui export --run RUN_ID --question-id QUESTION_ID
memorybench ui stop
```

FastAPI serves allowlisted artifacts and one-way SSE updates with event IDs. React and Cytoscape
render temporal, relational, and tree layouts, a session/batch memory pulse, selection details, and
deep-linked run/case/batch/layout state. Closing the browser or killing the inspector does not share
a control path with a benchmark worker and cannot fail a case. On restart, the UI reconstructs state
from disk.

The observer lane adds zero LLM calls.

## Configuration pair

- [`architecture-0002-openai-b3.yaml`](../configs/architecture-0002-openai-b3.yaml)
- [`architecture-0002-openai-b9.yaml`](../configs/architecture-0002-openai-b9.yaml)
- [`architecture-0002-gemini-b3.yaml`](../configs/architecture-0002-gemini-b3.yaml)
- [`architecture-0002-gemini-b9.yaml`](../configs/architecture-0002-gemini-b9.yaml)

The first paid smoke and canary pair are intentionally deferred. Offline implementation does not
make provider or judge calls.

## Design basis

The design follows LongMemEval's session decomposition and time-aware retrieval findings, retains
superseded facts and provenance in the spirit of temporal graph memory, and uses explicit provenance
records and JSON Pointer diffs: [LongMemEval](https://arxiv.org/abs/2410.10813),
[Zep temporal graph paper](https://arxiv.org/abs/2501.13956),
[W3C PROV-O](https://www.w3.org/TR/prov-o/), and
[RFC 6901](https://www.rfc-editor.org/info/rfc6901/).
