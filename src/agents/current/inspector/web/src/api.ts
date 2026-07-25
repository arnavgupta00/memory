import type { CaseSnapshot, CaseSummary, RunSummary } from "./types";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export const api = {
  runs: () => get<RunSummary[]>("/api/runs"),
  cases: (run: string) => get<CaseSummary[]>(`/api/runs/${encodeURIComponent(run)}/cases`),
  snapshot: (run: string, caseId: string, batch?: number) =>
    get<CaseSnapshot>(
      `/api/runs/${encodeURIComponent(run)}/cases/${encodeURIComponent(caseId)}` +
        (batch === undefined ? "" : `?batch=${batch}`),
    ),
};
