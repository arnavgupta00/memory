# Model roles in architecture 0002

The agent sees provider APIs only through `runtime.models`. YAML chooses the provider, exact model
ID, generation parameters, retries, prices, and role-wide concurrency. Architecture code chooses a
stable role name and a Pydantic response contract.

```python
result = await runtime.models.generate_structured(
    "memory_consolidator",
    rendered_prompt,
    ConsolidationOutput,
)
```

The gateway asks OpenAI or Gemini for schema-constrained output and validates the response again
locally. When `execution.capture_model_io` is enabled, it records the rendered message envelope,
response JSON Schema, raw structured response, validated object, usage, latency, request ID, and
failure metadata inside the current case namespace. The recorder redacts secrets before disk.

## Active roles

| Role | Cadence | Contract |
|---|---:|---|
| `memory_consolidator` | `ceil(N / B)` | `ConsolidationOutput` |
| `query_planner` | once per question | `QueryPlan` |
| `evidence_reranker` | once per question | `RerankOutput` |
| reserved `answer` | once per question | `FinalAnswerOutput` |

There is no embedding role in architecture 0002. BM25, entity/alias lookup, predicate matching,
two-hop traversal, temporal filtering, batch summaries, and latest sessions are local deterministic
channels. The harness still understands embedding roles for future architectures, but these configs
declare none and this agent never calls `embed()`.

## Configuration

Internal roles live in `agent.models`; the final answerer remains the top-level `answer` model:

```yaml
agent:
  entrypoint: agents.current:create_agent
  models:
    memory_consolidator: &agent_model
      kind: generation
      provider: openai
      model: gpt-5-nano-2025-08-07
      temperature: 1
      reasoning_effort: minimal
      max_output_tokens: 4000
      concurrency: 4
    query_planner: *agent_model
    evidence_reranker: *agent_model
  options:
    batch_size: 3

answer:
  provider: openai
  model: gpt-5-nano-2025-08-07
  temperature: 1
  reasoning_effort: minimal
  max_output_tokens: 4000
  concurrency: 4
```

The canonical `gpt-4o-2024-08-06` judge never appears in `runtime.models`; it runs later as one
external evaluator call per completed question.

## Concurrency and isolation

`execution.case_concurrency: 4` allows four benchmark cases to progress at once. Each case owns its
agent, graph, event chain, artifact directory, and call ledger. Provider instances and their role
semaphores are run-global, so case workers cannot bypass the configured concurrency or pacing.

Do not create provider SDK clients under `agents/current`. Add or change memory behavior here; keep
provider normalization in the stable harness.
