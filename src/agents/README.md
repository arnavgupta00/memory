# Agents: build here

```text
agents/
├── baselines/full_context/       # Frozen runnable Architecture 0001
└── current/                      # Active TypeScript Architecture 0003.2
    ├── src/
    │   ├── host.ts               # Versioned Python↔Node NDJSON host
    │   ├── workflow.ts           # LangGraph topology and routes only
    │   ├── state.ts              # Zod StateSchema
    │   ├── types.ts              # Shared runtime/domain contracts
    │   ├── nodes/                # Small workflow nodes
    │   └── services/             # Providers, prompts, graph gates, artifacts
    ├── prompts/                  # Complete YAML instructions
    ├── configs/                  # B3/C9, B9/C9, OpenAI, Gemini, mixed
    ├── inspector/                # Hono SSE server + React/Cytoscape UI
    ├── architecture/             # Versioned design and editable diagrams
    └── tests/                    # Offline architecture tests
```

## Where to start

Open [`current/src/workflow.ts`](current/src/workflow.ts), then follow each node into its service.
LongMemEval still calls `reset`, `ingest`, and `answer` through the Node bridge, but architecture
code never imports the dataset, evaluator, runner, or publication internals.

What you normally edit:

- orchestration: [`current/src/workflow.ts`](current/src/workflow.ts) and
  [`current/src/nodes/`](current/src/nodes/);
- memory structure and mutation safety:
  [`current/src/services/graphMutations.ts`](current/src/services/graphMutations.ts);
- model behavior: [`current/prompts/`](current/prompts/);
- B/C/model experiments: [`current/configs/`](current/configs/);
- visualization: [`current/inspector/`](current/inspector/).

What you should normally leave alone: `src/longmemeval/`. It sanitizes benchmark cases, runs the
agent, owns manifests/predictions, and invokes the pinned canonical judge.

Architecture 0002 is retained under [`../../legacy/python-architecture-0002/`](../../legacy/python-architecture-0002/)
for audit and reference, not imported at runtime.
