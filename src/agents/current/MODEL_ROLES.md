# Model roles for complex architectures

`CurrentAgent` receives every external model through `runtime.models`. Agent code selects a stable
role name; YAML selects the provider, exact model ID, limits, retries, concurrency, and optional
run-date pricing.

This keeps architecture code independent of OpenAI and Gemini SDK details:

```python
memory = await self.runtime.models.generate(
    "memory_writer",
    "Extract durable, timestamped memories from this session...",
)

embedded = await self.runtime.models.embed(
    "memory_embedder",
    ["The user moved to Pune", "The user prefers aisle seats"],
)

final = await self.runtime.models.generate(
    self.runtime.answer_role,
    "Answer using the retrieved evidence...",
)
```

## The four architecture entry points

| Entry point | What arrives | Recommended responsibility |
|---|---|---|
| `create_agent(runtime)` | Named model gateway and architecture options | Construct stores and components |
| `reset(case)` | Question ID and type, but not the question | Clear or namespace every per-case store |
| `ingest(session)` | One complete timestamped session | Extract, consolidate, embed, and index memory |
| `answer(question, question_date)` | Question after every session was ingested | Retrieve, reason, and call the final answer role |

The agent receives sessions one at a time. It can process them online, retain them for deferred batch
processing, or combine the two approaches.

## Configuration

The final benchmark answerer stays in the top-level `answer` block. It is automatically registered
under the reserved role `answer` and remains visible in benchmark reports:

```yaml
answer:
  provider: gemini
  model: gemini-3.1-pro-preview
  temperature: 0
  max_output_tokens: 800
```

Internal architecture roles live under `agent.models`:

```yaml
agent:
  entrypoint: agents.current:create_agent
  models:
    memory_writer:
      kind: generation
      provider: openai
      model: gpt-4.1-mini-2025-04-14
      temperature: 0
      max_output_tokens: 1200

    memory_embedder:
      kind: embedding
      provider: openai
      model: text-embedding-3-small
      dimensions: 1536

    retrieval_document_embedder:
      kind: embedding
      provider: gemini
      model: gemini-embedding-001
      dimensions: 1536
      task_type: RETRIEVAL_DOCUMENT

    retrieval_query_embedder:
      kind: embedding
      provider: gemini
      model: gemini-embedding-001
      dimensions: 1536
      task_type: RETRIEVAL_QUERY
```

A complete starting configuration is available at
[`configs/examples/complex-agent.yaml`](configs/examples/complex-agent.yaml).

## Guarantees

- `answer`, `judge`, and canonical-judge variants are reserved role names.
- The canonical GPT-4o judge is never added to `runtime.models`.
- Model IDs cannot be `latest`, `default`, or another placeholder.
- All declared provider clients are validated when the run starts, before benchmark cases execute.
- Every successful call records role, provider/model, parameters, token usage, latency, request ID,
  item count, and a SHA-256 input hash.
- Prompts, session text, embedding inputs, and API keys are not written into model-call records.
- Reports aggregate usage and user-supplied run-date pricing separately for every role.

## Credentials

- Any OpenAI generation or embedding role requires `OPENAI_API_KEY`.
- Any Gemini generation or embedding role requires `GEMINI_API_KEY`.
- Canonical judging independently requires `OPENAI_API_KEY`.

Do not create SDK clients inside `agents/current`. Adding a new provider belongs in the harness
gateway; building memory behavior belongs here.
