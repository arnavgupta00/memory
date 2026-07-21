# Current architecture

**Architecture ID:** `0001-full-context`

The current agent is intentionally simple: it stores every sanitized session in an in-memory list,
serializes the complete history when a question arrives, and asks the configured Gemini or OpenAI
model for the answer. There is no retrieval, indexing, consolidation, graph, or temporal layer yet.

The exact design record is maintained as a pair:

- [`architecture/0001-full-context.md`](architecture/0001-full-context.md)
- [`architecture/0001-full-context.excalidraw`](architecture/0001-full-context.excalidraw)

See [`architecture/LOG.md`](architecture/LOG.md) for the version history. When you replace this
design, create `0002-<name>.md` and `0002-<name>.excalidraw` rather than rewriting the `0001` record.
