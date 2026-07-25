import { Activity, CircleDot, Download, GitFork, PanelRight, Radio, RefreshCw, Search, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { GraphCanvas } from "./GraphCanvas";
import type { CanonicalGraph, CaseSnapshot, CaseSummary, RunSummary } from "./types";

type Layout = "elk" | "fcose" | "breadthfirst";

function queryState() {
  const params = new URLSearchParams(location.search);
  return { run: params.get("run") ?? "", caseId: params.get("case") ?? "", batch: Number(params.get("batch") ?? "0"), layout: (params.get("layout") as Layout) || "elk", selected: params.get("selected") ?? "" };
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
  const [inspectorTab, setInspectorTab] = useState<"record" | "diff" | "sessions" | "calls">("record");
  const [search, setSearch] = useState("");
  const [connection, setConnection] = useState<"live" | "stale" | "offline">("stale");
  const [error, setError] = useState<string>();
  const [relayout, setRelayout] = useState(0);

  useEffect(() => { api.runs().then((items) => { setRuns(items); setRunId((value) => value || items[0]?.id || ""); }).catch((value: Error) => { setConnection("offline"); setError(value.message); }); }, []);
  useEffect(() => { if (!runId) return; api.cases(runId).then((items) => { setCases(items); setCaseId((value) => items.some((item) => item.id === value) ? value : items[0]?.id || ""); }).catch((value: Error) => setError(value.message)); }, [runId]);
  useEffect(() => { if (!runId || !caseId) return; api.snapshot(runId, caseId, batch || undefined).then((data) => { setSnapshot(data); setConnection(data.status === "live" ? "live" : "stale"); }).catch((value: Error) => setError(value.message)); }, [runId, caseId, batch]);
  useEffect(() => {
    if (!runId || !caseId || batch) return;
    const last = Number(snapshot?.events.at(-1)?.sequence ?? 0);
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/events?after=${last}`);
    source.onopen = () => setConnection("live");
    source.addEventListener("memory", () => api.snapshot(runId, caseId).then(setSnapshot));
    source.onerror = () => setConnection("stale");
    return () => source.close();
  }, [runId, caseId, batch, snapshot?.events]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (runId) params.set("run", runId);
    if (caseId) params.set("case", caseId);
    if (batch) params.set("batch", String(batch));
    params.set("layout", layout);
    if (selected) params.set("selected", selected);
    history.replaceState(null, "", `?${params}`);
  }, [runId, caseId, batch, layout, selected]);

  const graph = useMemo(
    () => (snapshot?.graph ?? {}) as CanonicalGraph,
    [snapshot?.graph],
  );
  const activeCase = cases.find((item) => item.id === caseId);
  const batchEvents = snapshot?.events.filter((item) => item.event_type === "batch_applied") ?? [];
  const sessionEvents = snapshot?.events.filter((item) => item.event_type === "session_ingested") ?? [];
  const selectedData = useMemo(() => graph.entities?.[selected] ?? graph.claims?.[selected] ?? graph.relations?.[selected], [graph, selected]);
  const selectedBatchEvent = batch ? batchEvents.at(-1) : undefined;
  const selectedBatchPayload = selectedBatchEvent?.payload;
  const selectedBatchRecord =
    selectedBatchPayload && typeof selectedBatchPayload === "object"
      ? (selectedBatchPayload as Record<string, unknown>).batch_record
      : undefined;
  const batchDiffs =
    selectedBatchRecord && typeof selectedBatchRecord === "object" && Array.isArray((selectedBatchRecord as Record<string, unknown>).diffs)
      ? ((selectedBatchRecord as Record<string, unknown>).diffs as Record<string, unknown>[])
      : [];
  const filteredCases = cases.filter((item) => item.id.toLowerCase().includes(search.toLowerCase()));
  const handleSelect = useCallback((id?: string) => setSelected(id ?? ""), []);

  function exportImage(format: "svg" | "png") {
    const canvas = document.querySelector(".graph-canvas canvas") as HTMLCanvasElement | null;
    if (format === "png" && canvas) { const link = document.createElement("a"); link.download = `${caseId}.png`; link.href = canvas.toDataURL(); link.click(); }
    if (format === "svg") window.open(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/export.svg${batch ? `?batch=${batch}` : ""}`, "_blank");
  }

  return (
    <main className="observatory">
      <header className="masthead">
        <div className="wordmark"><CircleDot size={20} /><span>MEMORY</span><strong>OBSERVATORY</strong></div>
        <div className={`connection ${connection}`} aria-live="polite">{connection === "offline" ? <WifiOff size={14} /> : <Radio size={14} />} {connection}</div>
        <div className="run-meter"><span>{activeCase?.event_count ?? 0} events</span><span>{activeCase?.batch_count ?? 0} batches</span><span>{snapshot?.model_calls.length ?? 0} LLM calls</span></div>
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
          <div><p className="eyebrow">CASE GRAPH</p><h1>{caseId || "Select a case"}</h1></div>
          <div className="tool-cluster">
            <label>Mode<select value={layout} onChange={(event) => setLayout(event.target.value as Layout)}><option value="elk">Temporal</option><option value="fcose">Relational</option><option value="breadthfirst">Tree</option></select></label>
            <button title="Relayout" onClick={() => setRelayout((value) => value + 1)}><RefreshCw size={16} /></button>
            <button title="Export SVG" onClick={() => exportImage("svg")}><Download size={16} /> SVG</button>
            <button title="Export PNG" onClick={() => exportImage("png")}><Download size={16} /> PNG</button>
          </div>
        </div>
        {error ? <div className="empty"><WifiOff /><h2>Inspector cannot read this case</h2><p>{error}</p></div> : Object.keys(graph.entities ?? {}).length ? <GraphCanvas graph={graph} layout={layout} selectedId={selected} relayoutToken={relayout} onSelect={handleSelect} /> : <div className="empty"><GitFork /><h2>{runs.find((run) => run.id === runId)?.has_graph_artifacts ? "Graph is forming" : "Legacy baseline"}</h2><p>{runs.find((run) => run.id === runId)?.has_graph_artifacts ? "Waiting for the first accepted batch operations." : "This run predates graph artifacts and remains available for score comparison."}</p></div>}
      </section>

      <aside className="inspector" aria-label="Selected memory inspector">
        <div className="inspector-heading"><PanelRight size={17} /><span>MEMORY INSPECTOR</span></div>
        <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
          {(["record", "diff", "sessions", "calls"] as const).map((tab) => (
            <button key={tab} role="tab" aria-selected={inspectorTab === tab} className={inspectorTab === tab ? "active" : ""} onClick={() => setInspectorTab(tab)}>{tab}</button>
          ))}
        </div>
        {inspectorTab === "record" && (selectedData ? <><p className="eyebrow">SELECTED RECORD</p><h2>{("canonical_name" in selectedData ? selectedData.canonical_name : "predicate" in selectedData ? selectedData.predicate : selected)}</h2><pre>{JSON.stringify(selectedData, null, 2)}</pre></> : <><p className="eyebrow">CASE SUMMARY</p><dl><dt>State</dt><dd>{snapshot?.status ?? "—"}</dd><dt>Sessions</dt><dd>{snapshot?.sessions.length ?? 0}</dd><dt>Model calls</dt><dd>{snapshot?.model_calls.length ?? 0}</dd></dl><p className="hint">Select a node or edge to inspect identity, temporal state, and provenance.</p></>)}
        {inspectorTab === "diff" && <section className="diff-view"><p className="eyebrow">{batch ? `BATCH ${batch} MUTATIONS` : "SELECT A BATCH"}</p>{batchDiffs.length ? batchDiffs.map((diff, index) => <article key={`${String(diff.path)}-${index}`}><code>{String(diff.path ?? "unknown path")}</code><div className="diff-grid"><div><small>BEFORE</small><pre>{JSON.stringify(diff.old_value ?? null, null, 2)}</pre></div><div><small>AFTER</small><pre>{JSON.stringify(diff.new_value ?? null, null, 2)}</pre></div></div></article>) : <p className="hint">Use the memory pulse to replay a batch and inspect its property-level before/after diff.</p>}</section>}
        {inspectorTab === "sessions" && <section className="record-list"><p className="eyebrow">RAW SESSION ARCHIVE</p>{snapshot?.sessions.map((session) => <details key={String(session.session_id)}><summary>{String(session.session_id)} <small>{String(session.date)}</small></summary><pre>{JSON.stringify(session.turns, null, 2)}</pre></details>)}</section>}
        {inspectorTab === "calls" && <section className="record-list"><p className="eyebrow">MODEL CALL LEDGER</p>{snapshot?.model_calls.map((call, index) => { const metadata = call.call && typeof call.call === "object" ? call.call as Record<string, unknown> : call; return <details key={index}><summary>{String(metadata.role ?? "model call")} <small>{String(metadata.model ?? "")}</small></summary><pre>{JSON.stringify(call, null, 2)}</pre></details>; })}</section>}
      </aside>

      <footer className="pulse">
        <div className="pulse-copy"><span className="eyebrow">MEMORY PULSE</span><strong>{batch ? `Replay after batch ${batch}` : "Live edge"}</strong></div>
        <div className="pulse-track" role="list" aria-label="Session and batch timeline">
          {sessionEvents.map((event, index) => <span key={String(event.sequence)} className="session-tick" title={`Session ${index + 1}`} />)}
          {batchEvents.map((event, index) => <button key={String(event.sequence)} className={batch === index + 1 ? "batch-tick active" : "batch-tick"} onClick={() => setBatch(batch === index + 1 ? 0 : index + 1)} aria-label={`Replay batch ${index + 1}`}><span>B{index + 1}</span></button>)}
        </div>
        <label className="replay">Batch <input type="range" min="0" max={activeCase?.batch_count ?? 0} value={batch} onChange={(event) => setBatch(Number(event.target.value))} /><output>{batch || "live"}</output></label>
      </footer>
    </main>
  );
}

export default App;
