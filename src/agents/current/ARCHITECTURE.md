# Current architecture

**Architecture ID:** `0001-full-context`

The current agent is intentionally simple: it stores every sanitized session in an in-memory list,
serializes the complete history when a question arrives, and asks the configured Gemini or OpenAI
model for the answer. There is no retrieval, indexing, consolidation, graph, or temporal layer yet.

The complete model-facing prompt is editable at
[`prompts/full_history.yaml`](prompts/full_history.yaml). `prompt.py` contains rendering and
validation only; prompt instructions, modes, structure, and `{variable}` insertion points live in
the YAML file.

The runtime now supports named generation and embedding roles for future architectures, but
`0001-full-context` deliberately calls only the reserved final `answer` role. See
[`MODEL_ROLES.md`](MODEL_ROLES.md) for the extension boundary. This runtime capability does not
change the memory behavior or architecture ID of the baseline.

The exact design record is maintained as a pair:

- [`architecture/0001-full-context.md`](architecture/0001-full-context.md)
- [`architecture/0001-full-context.excalidraw`](architecture/0001-full-context.excalidraw)

See [`architecture/LOG.md`](architecture/LOG.md) for the version history. When you replace this
design, create `0002-<name>.md` and `0002-<name>.excalidraw` rather than rewriting the `0001` record.
