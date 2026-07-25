export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type RunSummary = {
  id: string;
  relative_path: string;
  status: string;
  architecture: string;
  completed_count: number;
  selected_count: number;
  has_graph_artifacts: boolean;
};

export type CaseSummary = {
  id: string;
  event_count: number;
  batch_count: number;
  summary_count: number;
  has_final_graph: boolean;
  has_answer: boolean;
};

export type SourceReference = {
  sessionId: string;
  turnIndex: number;
  sessionDate: string;
  batchId: string;
  excerpt?: string;
};

export type MasterContextGraph = {
  schemaVersion: 1;
  revision: number;
  context: JsonObject;
  provenanceByPointer: Record<string, SourceReference[]>;
};

export type MutationRecord = {
  batchId: string;
  sessionIds: string[];
  mode: "patch" | "replace_graph" | "rejected";
  explanation: string;
  accepted: boolean;
  rejectionReason?: string;
  diffs: Array<{
    op: string;
    path: string;
    from?: string;
    before?: JsonValue;
    after?: JsonValue;
  }>;
  graphRevisionBefore: number;
  graphRevisionAfter: number;
  graphHash: string;
  mutation?: JsonObject;
};

export type RetrievalChannelCounts = {
  session: number;
  graphCell: number;
  summary: number;
  coverageFallback: number;
  tail: number;
};

export type RoleCallMetric = {
  role: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  retries: number;
  models: string[];
};

export type ObserverArtifacts = {
  schemaVersion: 1;
  legacy: boolean;
  coverage: {
    available: boolean;
    totals: {
      graphCovered: number;
      duplicate: number;
      sessionIndexFallback: number;
      highPrioritySignals: number;
    };
    records: JsonObject[];
  };
  retrieval: {
    available: boolean;
    question: string | null;
    questionDate: string | null;
    algorithm: string | null;
    parameters: JsonObject;
    indexed: RetrievalChannelCounts;
    candidates: RetrievalChannelCounts;
    sessions: JsonValue[];
    graphCells: JsonValue[];
    summaries: JsonValue[];
    coverageFallbackSessions: JsonValue[];
    tailSessions: JsonValue[];
  };
  readerPlan: JsonObject | null;
  finalContext: {
    available: boolean;
    kind:
      | "compact_reader_context"
      | "legacy_full_context"
      | "unavailable";
    value: JsonObject | null;
  };
  roleMetrics: RoleCallMetric[];
};

export type CaseSnapshot = {
  run_id: string;
  case_id: string;
  graph: JsonObject;
  events: JsonObject[];
  sessions: JsonObject[];
  summaries: JsonObject[];
  mutations: MutationRecord[];
  model_calls: JsonObject[];
  observer: ObserverArtifacts;
  answer: JsonObject | null;
  status: "live" | "completed";
};

export type LegacyCanonicalGraph = {
  entities?: Record<string, JsonObject>;
  relations?: Record<string, JsonObject>;
  claims?: Record<string, JsonObject>;
};
