import type { components } from "./generated/api";

export type RunSummary = components["schemas"]["RunSummary"];
export type CaseSummary = components["schemas"]["CaseSummary"];
export type CaseSnapshot = components["schemas"]["CaseSnapshot"];

export type GraphEntity = {
  id: string;
  kind: string;
  canonical_name: string;
  aliases: string[];
  properties: Record<string, unknown>;
};

export type GraphRelation = {
  id: string;
  source_id: string;
  predicate: string;
  target_id: string;
  status: string;
};

export type GraphClaim = {
  id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  status: string;
};

export type CanonicalGraph = {
  entities?: Record<string, GraphEntity>;
  relations?: Record<string, GraphRelation>;
  claims?: Record<string, GraphClaim>;
};
