import { Activity, CircleDot, Download, GitFork, PanelRight, Radio, RefreshCw, Search, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { GraphCanvas } from "./GraphCanvas";
import {
  EvidenceRail,
  PipelineInspector,
  type PipelineView,
} from "./PipelineInspector";
import type { CaseSnapshot, CaseSummary, JsonObject, JsonValue, MasterContextGraph, MutationRecord, RunSummary } from "./types";

type Layout = "elk" | "fcose" | "breadthfirst";
type InspectorTab =
  | "calls"
  | "context"
  | "coverage"
  | "diff"
  | "reader"
  | "record"
  | "retrieval"
  | "sessions";

const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "record", label: "memory" },
  { id: "coverage", label: "coverage" },
  { id: "retrieval", label: "retrieve" },
  { id: "reader", label: "reader" },
  { id: "context", label: "context" },
  { id: "diff", label: "diff" },
  { id: "sessions", label: "sessions" },
  { id: "calls", label: "calls" },
];

function queryState() {
  const params = new URLSearchParams(location.search);
  return { run: params.get("run") ?? "", caseId: params.get("case") ?? "", batch: Number(params.get("batch") ?? "0"), layout: (params.get("layout") as Layout) || "elk", selected: params.get("selected") ?? "" };
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function valueAtPointer(graph: JsonObject, pointer: string): JsonValue | undefined {
  if (!pointer.startsWith("/context")) return undefined;
  let current: JsonValue = graph;
  for (const segment of pointer.slice(1).split("/")) {
    const key = unescapePointer(segment);
    if (Array.isArray(current)) {
      const next: JsonValue | undefined = current[Number(key)];
      if (next === undefined) return undefined;
      current = next;
    } else if (current !== null && typeof current === "object") {
      const next: JsonValue | undefined = current[key];
      if (next === undefined) return undefined;
      current = next;
    }
    else return undefined;
  }
  return current;
}

function eventType(event: JsonObject): string {
  return String(event.eventType ?? event.event_type ?? "");
}

function App() {
  const initial = queryState();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [runId, setRunId] = useState(initial.run);
  const [caseId, setCaseId] = useState(initial.caseId);
  const [snapshot, setSnapshot] = useState<CaseSnapshot>();
  const [batch, setBatch] = useState(initial.batch);
  const [layout, setLayout] = useState<Layout>(initial.layout);
  const [selected, setSelected] = useState(initial.selected);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("record");
  const [search, setSearch] = useState("");
  const [connection, setConnection] = useState<"live" | "stale" | "offline" | "completed">("stale");
  const [error, setError] = useState<string>();
  const [relayout, setRelayout] = useState(0);
  const lastEventSequence = snapshot?.events.at(-1)?.sequence;

  useEffect(() => { api.runs().then((items) => { setRuns(items); setRunId((value) => value || items[0]?.id || ""); }).catch((value: Error) => { setConnection("offline"); setError(value.message); }); }, []);
  useEffect(() => { if (!runId) return; setError(undefined); api.cases(runId).then((items) => { setCases(items); setCaseId((value) => items.some((item) => item.id === value) ? value : items[0]?.id || ""); }).catch((value: Error) => setError(value.message)); }, [runId]);
  useEffect(() => { if (!runId || !caseId) return; setError(undefined); api.snapshot(runId, caseId, batch || undefined).then((data) => { setSnapshot(data); setConnection(data.status === "live" ? "live" : "completed"); }).catch((value: Error) => setError(value.message)); }, [runId, caseId, batch]);
  useEffect(() => {
    if (!runId || !caseId || batch || snapshot?.status !== "live") return;
    const last = Number(lastEventSequence ?? 0);
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/events?after=${last}`);
    source.onopen = () => setConnection("live");
    source.addEventListener("memory", () => api.snapshot(runId, caseId).then(setSnapshot));
    source.onerror = () => setConnection("stale");
    return () => source.close();
  }, [runId, caseId, batch, lastEventSequence, snapshot?.status]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (runId) params.set("run", runId);
    if (caseId) params.set("case", caseId);
    if (batch) params.set("batch", String(batch));
    params.set("layout", layout);
    if (selected) params.set("selected", selected);
    history.replaceState(null, "", `?${params}`);
  }, [runId, caseId, batch, layout, selected]);

  const graph = useMemo(() => snapshot?.graph ?? {}, [snapshot?.graph]);
  const typedGraph = graph.schemaVersion === 1 ? graph as unknown as MasterContextGraph : undefined;
  const activeCase = cases.find((item) => item.id === caseId);
  const mutations = snapshot?.mutations ?? [];
  const sessionEvents = snapshot?.events.filter((item) => eventType(item) === "session_ingested") ?? [];
  const summaryEvents = snapshot?.events.filter((item) => eventType(item) === "summary_window_created") ?? [];
  const selectedData = useMemo(() => valueAtPointer(graph, selected), [graph, selected]);
  const selectedProvenance = typedGraph?.provenanceByPointer[selected] ?? [];
  const selectedMutation: MutationRecord | undefined = batch ? mutations.at(-1) : undefined;
  const filteredCases = cases.filter((item) => item.id.toLowerCase().includes(search.toLowerCase()));
  const handleSelect = useCallback((id?: string) => setSelected(id ?? ""), []);
  const latestEvent = snapshot?.events.at(-1);
  const activeNode = latestEvent
    ? eventType(latestEvent) === "node_started" && latestEvent.payload && typeof latestEvent.payload === "object" && !Array.isArray(latestEvent.payload)
      ? typeof latestEvent.payload.node === "string" ? latestEvent.payload.node : "node started"
      : eventType(latestEvent).replaceAll("_", " ")
    : "waiting";

  function exportImage(format: "svg" | "png") {
    const canvas = document.querySelector(".graph-canvas canvas") as HTMLCanvasElement | null;
    if (format === "png" && canvas) { const link = document.createElement("a"); link.download = `${caseId}.png`; link.href = canvas.toDataURL(); link.click(); }
    if (format === "svg") window.open(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/export.svg${batch ? `?batch=${batch}` : ""}`, "_blank");
  }

  const hasGraph = Boolean(typedGraph && Object.keys(typedGraph.context).length) || Boolean(graph.entities);

  return (
    <main className="observatory">
      <header className="masthead">
        <div className="wordmark"><CircleDot size={20} /><span>MEMORY</span><strong>OBSERVATORY</strong></div>
        <div className={`connection ${connection}`} aria-live="polite">{connection === "offline" ? <WifiOff size={14} /> : <Radio size={14} />} {connection}</div>
        <div className="run-meter"><span>{activeCase?.event_count ?? 0} events</span><span>{activeCase?.batch_count ?? 0} Contexto batches</span><span>{activeCase?.summary_count ?? 0} Shino windows</span><span>{snapshot?.model_calls.length ?? 0} LLM calls</span></div>
      </header>

      <aside className="library" aria-label="Run and case library">
        <label className="search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find case" /></label>
        <p className="eyebrow">RUN LIBRARY</p>
        <select value={runId} onChange={(event) => { setRunId(event.target.value); setBatch(0); }} aria-label="Run">
          {runs.map((run) => <option key={run.relative_path} value={run.id}>{run.id}</option>)}
        </select>
        <div className="run-facts"><span>{runs.find((run) => run.id === runId)?.status ?? "—"}</span><span>{runs.find((run) => run.id === runId)?.has_graph_artifacts ? "graph artifacts" : "legacy / no graph"}</span></div>
        <p className="eyebrow case-label">CASES · {filteredCases.length}</p>
        <nav className="case-list">{filteredCases.map((item) => <button key={item.id} className={item.id === caseId ? "active" : ""} onClick={() => { setCaseId(item.id); setBatch(0); }}><Activity size={14} /><span>{item.id}</span><small>{item.has_answer ? "done" : "live"}</small></button>)}</nav>
      </aside>

      <section className="stage">
        <div className="stage-tools">
          <div><p className="eyebrow">CASE GRAPH · REVISION {typedGraph?.revision ?? 0}</p><h1>{caseId || "Select a case"}</h1><small className="active-node">Latest event: {activeNode}</small></div>
          <div className="tool-cluster">
            <label>Mode<select value={layout} onChange={(event) => setLayout(event.target.value as Layout)}><option value="elk">Temporal</option><option value="fcose">Relations</option><option value="breadthfirst">Context tree</option></select></label>
            <button title="Relayout" onClick={() => setRelayout((value) => value + 1)}><RefreshCw size={16} /></button>
            <button title="Export SVG" onClick={() => exportImage("svg")}><Download size={16} /> SVG</button>
            <button title="Export PNG" onClick={() => exportImage("png")}><Download size={16} /> PNG</button>
          </div>
        </div>
        {error ? <div className="empty"><WifiOff /><h2>Inspector cannot read this case</h2><p>{error}</p></div> : hasGraph ? <GraphCanvas graph={graph} layout={layout} selectedId={selected} relayoutToken={relayout} onSelect={handleSelect} /> : <div className="empty"><GitFork /><h2>{runs.find((run) => run.id === runId)?.has_graph_artifacts ? "Contexto has not written a batch yet" : "Legacy baseline"}</h2><p>{runs.find((run) => run.id === runId)?.has_graph_artifacts ? "Raw sessions remain safe in the tail channel until the first complete B-session batch." : "This run predates graph artifacts and remains available for score comparison."}</p></div>}
      </section>

      <aside className="inspector" aria-label="Selected memory inspector">
        <div className="inspector-heading"><PanelRight size={17} /><span>MEMORY INSPECTOR</span></div>
        {snapshot?.observer && <EvidenceRail observer={snapshot.observer} />}
        <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
          {INSPECTOR_TABS.map((tab) => <button key={tab.id} role="tab" aria-selected={inspectorTab === tab.id} className={inspectorTab === tab.id ? "active" : ""} onClick={() => setInspectorTab(tab.id)}>{tab.label}</button>)}
        </div>
        {inspectorTab === "record" && (selectedData !== undefined ? <><p className="eyebrow">{selected}</p><h2>{selected.split("/").at(-1) ?? "selected value"}</h2><pre>{JSON.stringify(selectedData, null, 2)}</pre><p className="eyebrow">PROVENANCE · {selectedProvenance.length}</p><pre>{JSON.stringify(selectedProvenance, null, 2)}</pre></> : <><p className="eyebrow">CASE SUMMARY</p><dl><dt>State</dt><dd>{snapshot?.status ?? "—"}</dd><dt>Graph revision</dt><dd>{typedGraph?.revision ?? 0}</dd><dt>Raw sessions</dt><dd>{snapshot?.sessions.length ?? 0}</dd><dt>Contexto mutations</dt><dd>{mutations.length}</dd><dt>Shino summaries</dt><dd>{snapshot?.summaries.length ?? 0}</dd></dl><p className="hint">Select a branch, leaf, or $ref to inspect its exact JSON path and source turns.</p></>)}
        {inspectorTab === "diff" && <section className="diff-view"><p className="eyebrow">{selectedMutation ? `${selectedMutation.batchId} · ${selectedMutation.mode} · ${selectedMutation.accepted ? "applied" : "rejected"}` : "SELECT A CONTEXTO BATCH"}</p>{selectedMutation?.diffs.length ? selectedMutation.diffs.map((diff, index) => <article key={`${diff.path}-${index}`}><code>{diff.op} {diff.path}</code><div className="diff-grid"><div><small>BEFORE</small><pre>{JSON.stringify(diff.before ?? null, null, 2)}</pre></div><div><small>AFTER</small><pre>{JSON.stringify(diff.after ?? null, null, 2)}</pre></div></div></article>) : <p className="hint">Use the memory pulse to replay a Contexto mutation and inspect its before/after values. Rejected batches leave the graph unchanged.</p>}</section>}
        {inspectorTab === "sessions" && <section className="record-list"><p className="eyebrow">RAW SESSION ARCHIVE · LATEST 9 FEEDS ANSWER</p>{snapshot?.sessions.map((session) => <details key={String(session.sessionId ?? session.session_id)}><summary>{String(session.sessionId ?? session.session_id)} <small>{String(session.date)}</small></summary><pre>{JSON.stringify(session.turns, null, 2)}</pre></details>)}</section>}
        {snapshot?.observer && (["coverage", "retrieval", "reader", "context", "calls"] as const).includes(inspectorTab as PipelineView) && <PipelineInspector observer={snapshot.observer} modelCalls={snapshot.model_calls} view={inspectorTab as PipelineView} />}
      </aside>

      <footer className="pulse">
        <div className="pulse-copy"><span className="eyebrow">MEMORY PULSE</span><strong>{batch ? `After Contexto ${batch}` : "Live edge"}</strong></div>
        <div className="pulse-track" role="list" aria-label="Session, Contexto, and Shino timeline">
          {sessionEvents.map((event, index) => <span key={`session-${String(event.sequence)}`} className="session-tick" title={`Session ${index + 1}`} />)}
          {mutations.map((mutation, index) => <button key={mutation.batchId} className={batch === index + 1 ? `batch-tick active ${mutation.accepted ? "applied" : "rejected"}` : `batch-tick ${mutation.accepted ? "applied" : "rejected"}`} onClick={() => setBatch(batch === index + 1 ? 0 : index + 1)} aria-label={`Replay ${mutation.batchId}`}><span>C{index + 1}</span></button>)}
          {summaryEvents.map((event, index) => <span key={`summary-${String(event.sequence)}`} className="summary-tick" title={`Shino window ${index + 1}`}>S{index + 1}</span>)}
        </div>
        <label className="replay">Contexto <input type="range" min="0" max={mutations.length} value={batch} onChange={(event) => setBatch(Number(event.target.value))} /><output>{batch || "live"}</output></label>
      </footer>
    </main>
  );
}

export default App;
