# Model roles in architecture 0003

The three roles are independent and may use OpenAI or Gemini in any combination:

| Role | Input | Cadence | Structured output |
|---|---|---:|---|
| `contexto` | current graph + exactly B raw sessions | `floor(N/B)` | patch or replacement proposal |
| `shino` | complete graph + C session IDs only | `floor(N/C)` | one window summary |
| `answer` | assembled final context | once per question | hypothesis, evidence, support status |

Provider configuration is explicit in YAML. The Node host owns one semaphore per role across every
concurrent case, so case parallelism cannot bypass role limits. SDK clients remain private to
[`src/services/modelGateway.ts`](src/services/modelGateway.ts).

Contexto's dynamic JSON crosses provider APIs as a typed tagged tree, then
[`src/services/contextoWire.ts`](src/services/contextoWire.ts) deterministically converts it to the
canonical `JsonValue`. This makes the same contract valid for OpenAI strict Structured Outputs and
Gemini JSON Schema without putting free-form JSON strings in the response.

Each successful call is persisted before deterministic application under a stable key:

```text
contexto:batch:0001
shino:window:0001
answer:final
```

Resume parses and reuses that validated response without another provider request. Captured prompts,
schemas, validated outputs, token usage, latency, request IDs, retries, and failures stay inside the
case artifact namespace. The artifact layer redacts configured secret values and key-like strings.

There is no query planner, reranker, BM25, embedding, retrieval, or repair call. The canonical
GPT-4o judge is an external benchmark call after the agent run and is not an architecture role.
