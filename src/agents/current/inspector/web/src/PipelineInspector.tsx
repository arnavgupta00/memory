import type {
  JsonObject,
  JsonValue,
  ObserverArtifacts,
} from "./types";

export type PipelineView =
  | "calls"
  | "context"
  | "coverage"
  | "reader"
  | "retrieval";

type Props = {
  observer: ObserverArtifacts;
  modelCalls: JsonObject[];
  view: PipelineView;
};

function objectValue(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined, fallback = "—"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function EmptyArtifact({ label }: { label: string }) {
  return (
    <div className="artifact-empty">
      <strong>{label} was not recorded</strong>
      <p>
        This case remains readable, but it predates this Architecture 0003.2
        observer artifact.
      </p>
    </div>
  );
}

export function EvidenceRail({
  observer,
}: {
  observer: ObserverArtifacts;
}) {
  const candidateTotal = Object.values(observer.retrieval.candidates).reduce(
    (total, count) => total + count,
    0,
  );
  const readerStatus = stringValue(
    observer.readerPlan?.supportStatus,
    "not recorded",
  );
  return (
    <ol className="evidence-rail" aria-label="Evidence pipeline">
      <li data-state={observer.coverage.available ? "ready" : "missing"}>
        <span>01</span>
        <strong>Contexto</strong>
        <small>
          {observer.coverage.available
            ? `${observer.coverage.records.length} batches`
            : "not recorded"}
        </small>
      </li>
      <li data-state={observer.retrieval.available ? "ready" : "missing"}>
        <span>02</span>
        <strong>Retrieve</strong>
        <small>
          {observer.retrieval.available
            ? `${candidateTotal} candidates`
            : "not recorded"}
        </small>
      </li>
      <li data-state={observer.readerPlan ? "ready" : "missing"}>
        <span>03</span>
        <strong>Reader</strong>
        <small>{readerStatus.replaceAll("_", " ")}</small>
      </li>
      <li data-state={observer.finalContext.available ? "ready" : "missing"}>
        <span>04</span>
        <strong>Answer</strong>
        <small>
          {observer.finalContext.kind === "compact_reader_context"
            ? "compact context"
            : observer.finalContext.kind.replaceAll("_", " ")}
        </small>
      </li>
    </ol>
  );
}

function CoverageView({ observer }: { observer: ObserverArtifacts }) {
  if (!observer.coverage.available) {
    return <EmptyArtifact label="Contexto coverage" />;
  }
  const { totals } = observer.coverage;
  const covered = totals.graphCovered + totals.duplicate;
  const coveragePercent =
    totals.highPrioritySignals === 0
      ? 100
      : Math.round((covered / totals.highPrioritySignals) * 100);
  return (
    <section className="pipeline-view" data-testid="coverage-view">
      <div className="pipeline-title">
        <div>
          <p className="eyebrow">CONTEXTO COVERAGE</p>
          <h2>{coveragePercent}% directly covered</h2>
        </div>
        <strong className="coverage-score">{covered}/{totals.highPrioritySignals}</strong>
      </div>
      <div
        className="coverage-bar"
        aria-label={`${coveragePercent}% of high-priority signals covered`}
      >
        <span style={{ width: `${coveragePercent}%` }} />
      </div>
      <div className="metric-triplet">
        <article>
          <small>GRAPH</small>
          <strong>{totals.graphCovered}</strong>
          <span>materialized</span>
        </article>
        <article>
          <small>KNOWN</small>
          <strong>{totals.duplicate}</strong>
          <span>duplicate</span>
        </article>
        <article className={totals.sessionIndexFallback > 0 ? "attention" : ""}>
          <small>SAFETY NET</small>
          <strong>{totals.sessionIndexFallback}</strong>
          <span>session fallback</span>
        </article>
      </div>
      <p className="eyebrow">BATCH AUDIT</p>
      <div className="record-list">
        {observer.coverage.records.map((record, index) => {
          const counts = objectValue(record.counts);
          const signals = arrayValue(record.signals);
          return (
            <details key={stringValue(record.batchId, `batch-${index + 1}`)}>
              <summary>
                <span>{stringValue(record.batchId, `batch ${index + 1}`)}</span>
                <small>
                  {stringValue(counts?.graphCovered, "0")} graph ·{" "}
                  {stringValue(counts?.sessionIndexFallback, "0")} fallback
                </small>
              </summary>
              {signals.length === 0 ? (
                <p className="hint">No high-priority signals in this batch.</p>
              ) : (
                <div className="signal-list">
                  {signals.map((signal, signalIndex) => {
                    const item = objectValue(signal);
                    const status = stringValue(item?.status, "unknown");
                    return (
                      <article key={`${stringValue(item?.signalId)}-${signalIndex}`}>
                        <span className={`status-mark ${status}`} />
                        <div>
                          <strong>{stringValue(item?.text, "Signal")}</strong>
                          <small>{status.replaceAll("_", " ")}</small>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}

type RetrievalChannel = {
  key:
    | "coverageFallback"
    | "graphCell"
    | "session"
    | "summary"
    | "tail";
  label: string;
  items: JsonValue[];
};

function candidateTitle(value: JsonValue, index: number): string {
  const candidate = objectValue(value);
  if (!candidate) return `candidate ${index + 1}`;
  const session = objectValue(candidate.session);
  const summary = objectValue(candidate.summary);
  return stringValue(
    candidate.pointer
      ?? candidate.sessionId
      ?? session?.session_id
      ?? summary?.windowId
      ?? candidate.documentId,
    `candidate ${index + 1}`,
  );
}

function candidateDetail(value: JsonValue): string {
  const candidate = objectValue(value);
  if (!candidate) return "";
  const score =
    typeof candidate.score === "number" ? candidate.score.toFixed(3) : "—";
  const matchedTerms = arrayValue(candidate.matchedTerms)
    .filter((term): term is string => typeof term === "string")
    .slice(0, 5)
    .join(" · ");
  return matchedTerms ? `score ${score} · ${matchedTerms}` : `score ${score}`;
}

function RetrievalView({ observer }: { observer: ObserverArtifacts }) {
  if (!observer.retrieval.available) {
    return <EmptyArtifact label="Retrieval index" />;
  }
  const retrieval = observer.retrieval;
  const channels: RetrievalChannel[] = [
    { key: "session", label: "Full sessions", items: retrieval.sessions },
    { key: "graphCell", label: "Graph cells", items: retrieval.graphCells },
    { key: "summary", label: "Shino summaries", items: retrieval.summaries },
    {
      key: "coverageFallback",
      label: "Coverage fallback",
      items: retrieval.coverageFallbackSessions,
    },
    { key: "tail", label: "Unprocessed tail", items: retrieval.tailSessions },
  ];
  return (
    <section className="pipeline-view" data-testid="retrieval-view">
      <div className="pipeline-title">
        <div>
          <p className="eyebrow">LOSSLESS RETRIEVAL</p>
          <h2>{retrieval.algorithm?.toUpperCase() ?? "Local index"}</h2>
        </div>
        <small>{retrieval.questionDate}</small>
      </div>
      {retrieval.question && (
        <blockquote className="question-card">{retrieval.question}</blockquote>
      )}
      <div className="channel-grid" aria-label="Retrieval channels">
        {channels.map((channel) => (
          <article key={channel.key}>
            <small>{channel.label}</small>
            <strong>{retrieval.candidates[channel.key]}</strong>
            <span>of {retrieval.indexed[channel.key]} indexed</span>
          </article>
        ))}
      </div>
      <div className="record-list candidate-list">
        {channels.map((channel) => (
          <details key={channel.key} open={channel.items.length > 0}>
            <summary>
              <span>{channel.label}</span>
              <small>{channel.items.length} returned</small>
            </summary>
            {channel.items.length === 0 ? (
              <p className="hint">No candidates returned through this channel.</p>
            ) : channel.items.map((item, index) => (
              <article className="candidate-row" key={`${candidateTitle(item, index)}-${index}`}>
                <span>{index + 1}</span>
                <div>
                  <strong>{candidateTitle(item, index)}</strong>
                  <small>{candidateDetail(item)}</small>
                </div>
              </article>
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}

function ReaderView({ observer }: { observer: ObserverArtifacts }) {
  const plan = observer.readerPlan;
  if (!plan) return <EmptyArtifact label="Reader plan" />;
  const sessions = arrayValue(plan.selectedSessions);
  const pointers = arrayValue(plan.selectedGraphPointers);
  const facts = arrayValue(plan.evidenceFacts);
  const conflicts = arrayValue(plan.conflicts);
  const grounding = objectValue(plan.grounding);
  const validation = objectValue(grounding?.validation);
  return (
    <section className="pipeline-view" data-testid="reader-view">
      <div className="pipeline-title">
        <div>
          <p className="eyebrow">READER DECISION</p>
          <h2>{stringValue(plan.supportStatus).replaceAll("_", " ")}</h2>
        </div>
        <span className="mode-chip">
          {stringValue(plan.answerMode).replaceAll("_", " ")}
        </span>
      </div>
      <div className="reader-ledger">
        <span><strong>{sessions.length}</strong> sessions</span>
        <span><strong>{pointers.length}</strong> graph paths</span>
        <span><strong>{facts.length}</strong> facts</span>
        <span><strong>{conflicts.length}</strong> conflicts</span>
      </div>
      {validation && (
        <div className={`grounding-verdict ${validation.valid === true ? "valid" : "invalid"}`}>
          <strong>
            Grounding {validation.valid === true ? "passed" : "requires abstention"}
          </strong>
          <small>{arrayValue(validation.issues).length} deterministic issues</small>
        </div>
      )}
      <p className="eyebrow">EVIDENCE FACTS</p>
      {facts.length === 0 ? (
        <p className="hint">The reader selected no answer-supporting facts.</p>
      ) : (
        <div className="fact-stack">
          {facts.map((fact, index) => {
            const item = objectValue(fact);
            return (
              <article key={`${stringValue(item?.statement)}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{stringValue(item?.statement)}</strong>
                  <small>
                    {arrayValue(item?.sessionIds).map(String).join(" · ")
                      || arrayValue(item?.graphPointers).map(String).join(" · ")}
                  </small>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {conflicts.length > 0 && (
        <>
          <p className="eyebrow">CONFLICT RESOLUTION</p>
          <pre>{JSON.stringify(conflicts, null, 2)}</pre>
        </>
      )}
      <details className="raw-artifact">
        <summary>Open typed reader plan</summary>
        <pre>{JSON.stringify(plan, null, 2)}</pre>
      </details>
    </section>
  );
}

function ContextView({ observer }: { observer: ObserverArtifacts }) {
  const context = observer.finalContext.value;
  if (!context) return <EmptyArtifact label="Final context" />;
  const evidencePackage = objectValue(context.evidencePackage);
  const plan = objectValue(context.readerPlan);
  return (
    <section className="pipeline-view" data-testid="context-view">
      <div className="pipeline-title">
        <div>
          <p className="eyebrow">ANSWER INPUT</p>
          <h2>
            {observer.finalContext.kind === "compact_reader_context"
              ? "Compact evidence package"
              : "Legacy full context"}
          </h2>
        </div>
        <span className={`mode-chip ${observer.finalContext.kind === "compact_reader_context" ? "compact" : "legacy"}`}>
          {observer.finalContext.kind === "compact_reader_context"
            ? "reader-scoped"
            : "historical"}
        </span>
      </div>
      {typeof context.question === "string" && (
        <blockquote className="question-card">{context.question}</blockquote>
      )}
      {evidencePackage && (
        <div className="context-envelope">
          <small>THE ANSWER MODEL RECEIVES</small>
          <strong>
            {arrayValue(evidencePackage.sessions).length} evidence sessions
          </strong>
          <span>
            {arrayValue(evidencePackage.graphValues).length} graph values ·{" "}
            {arrayValue(plan?.evidenceFacts).length} reader facts
          </span>
        </div>
      )}
      <details className="raw-artifact" open>
        <summary>Inspect final context JSON</summary>
        <pre>{JSON.stringify(context, null, 2)}</pre>
      </details>
    </section>
  );
}

function CallsView({
  modelCalls,
  observer,
}: {
  modelCalls: JsonObject[];
  observer: ObserverArtifacts;
}) {
  if (observer.roleMetrics.length === 0 && modelCalls.length === 0) {
    return <EmptyArtifact label="Model-call ledger" />;
  }
  return (
    <section className="pipeline-view" data-testid="calls-view">
      <p className="eyebrow">PER-ROLE COST SURFACE</p>
      <div className="role-metrics">
        {observer.roleMetrics.map((metric) => (
          <article key={metric.role}>
            <header>
              <strong>{metric.role}</strong>
              <span>{metric.calls} calls</span>
            </header>
            <dl>
              <dt>Tokens</dt><dd>{formatNumber(metric.totalTokens)}</dd>
              <dt>Input</dt><dd>{formatNumber(metric.inputTokens)}</dd>
              <dt>Output</dt><dd>{formatNumber(metric.outputTokens)}</dd>
              <dt>Mean latency</dt><dd>{(metric.averageLatencyMs / 1000).toFixed(1)}s</dd>
              <dt>Retries</dt><dd>{metric.retries}</dd>
              <dt>Failures</dt><dd>{metric.failures}</dd>
            </dl>
            <small>{metric.models.join(" · ")}</small>
          </article>
        ))}
      </div>
      <p className="eyebrow">MODEL CALL LEDGER</p>
      <div className="record-list">
        {modelCalls.map((call, index) => {
          const metadata = objectValue(call.call) ?? call;
          return (
            <details key={`${stringValue(metadata.role)}-${index}`}>
              <summary>
                <span>{stringValue(metadata.role, "model call")}</span>
                <small>{stringValue(metadata.model, "")}</small>
              </summary>
              <pre>{JSON.stringify(call, null, 2)}</pre>
            </details>
          );
        })}
      </div>
    </section>
  );
}

export function PipelineInspector({ modelCalls, observer, view }: Props) {
  if (view === "coverage") return <CoverageView observer={observer} />;
  if (view === "retrieval") return <RetrievalView observer={observer} />;
  if (view === "reader") return <ReaderView observer={observer} />;
  if (view === "context") return <ContextView observer={observer} />;
  return <CallsView modelCalls={modelCalls} observer={observer} />;
}
