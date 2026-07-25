import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from "cytoscape";
import elk from "cytoscape-elk";
import fcose from "cytoscape-fcose";
import { useEffect, useRef } from "react";
import type { JsonObject, JsonValue, LegacyCanonicalGraph, MasterContextGraph } from "./types";

cytoscape.use(elk);
cytoscape.use(fcose);

type Props = {
  graph: JsonObject;
  layout: "elk" | "fcose" | "breadthfirst";
  selectedId?: string;
  relayoutToken: number;
  onSelect: (id?: string) => void;
};

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function labelFor(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  if (typeof value !== "object") return String(value);
  return Array.isArray(value) ? `${value.length} items` : `${Object.keys(value).length} fields`;
}

function isMemoryCell(value: JsonValue): value is JsonObject {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.memory_type === "string"
    && value.current !== null
    && typeof value.current === "object"
    && !Array.isArray(value.current);
}

function memoryCellDetail(value: JsonObject): string {
  const current = value.current;
  if (current === null || typeof current !== "object" || Array.isArray(current)) return "memory";
  return labelFor(current.value ?? null);
}

function treeElements(graph: MasterContextGraph): ElementDefinition[] {
  const result: ElementDefinition[] = [
    { data: { id: "/context", label: "master context", detail: `revision ${graph.revision}`, type: "root", value: graph.context } },
  ];
  const references: Array<{ id: string; source: string; target: string }> = [];

  const visit = (value: JsonValue, pointer: string, parent: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`, pointer));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const childPointer = `${pointer}/${escapePointer(key)}`;
        const isReference = key === "$ref" && typeof child === "string";
        const isSemanticMemory = isMemoryCell(child);
        result.push({
          data: {
            id: childPointer,
            label: isReference ? "$ref" : key,
            detail: isSemanticMemory ? memoryCellDetail(child) : labelFor(child),
            type: isReference ? "reference" : isSemanticMemory ? "leaf" : child !== null && typeof child === "object" ? "branch" : "leaf",
            value: child,
            provenance: graph.provenanceByPointer[childPointer] ?? [],
          },
        });
        result.push({ data: { id: `contains:${parent}:${childPointer}`, source: parent, target: childPointer, label: isSemanticMemory ? "remembers" : "groups", type: "tree-edge" } });
        if (isReference) references.push({ id: `ref:${childPointer}`, source: childPointer, target: child });
        else if (!isSemanticMemory && child !== null && typeof child === "object") visit(child, childPointer, childPointer);
      }
    }
  };

  visit(graph.context, "/context", "/context");
  for (const reference of references) {
    if (result.some((item) => item.data.id === reference.target)) {
      result.push({ data: { ...reference, label: "$ref", type: "ref-edge" } });
    }
  }
  return result;
}

function legacyElements(graph: LegacyCanonicalGraph): ElementDefinition[] {
  const result: ElementDefinition[] = [];
  Object.entries(graph.entities ?? {}).forEach(([id, entity]) =>
    result.push({ data: { id, label: String(entity.canonical_name ?? id), detail: String(entity.kind ?? "entity"), type: "branch", value: entity } }),
  );
  Object.entries(graph.claims ?? {}).forEach(([id, claim]) => {
    result.push({ data: { id, label: String(claim.predicate ?? "claim"), detail: labelFor(claim.value ?? null), type: "leaf", value: claim } });
    if (typeof claim.subject_id === "string") result.push({ data: { id: `claim:${id}`, source: claim.subject_id, target: id, label: "asserts" } });
  });
  Object.entries(graph.relations ?? {}).forEach(([id, relation]) => {
    if (typeof relation.source_id === "string" && typeof relation.target_id === "string") {
      result.push({ data: { id, source: relation.source_id, target: relation.target_id, label: String(relation.predicate ?? "relates") } });
    }
  });
  return result;
}

function elements(graph: JsonObject): ElementDefinition[] {
  if (graph.schemaVersion === 1 && graph.context && typeof graph.context === "object" && !Array.isArray(graph.context)) {
    return treeElements(graph as unknown as MasterContextGraph);
  }
  return legacyElements(graph as LegacyCanonicalGraph);
}

function layoutOptions(layout: Props["layout"]): LayoutOptions {
  const options = layout === "elk"
    ? { name: "elk", fit: true, padding: 72, elk: { algorithm: "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "48" } }
    : { name: layout, fit: true, padding: 72, animate: false, directed: layout === "breadthfirst" };
  return options as unknown as LayoutOptions;
}

export function GraphCanvas({ graph, layout, selectedId, relayoutToken, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  const hasLaidOut = useRef(false);

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!host.current) return;
    cy.current = cytoscape({
      container: host.current,
      elements: [],
      minZoom: 0.12,
      maxZoom: 3,
      style: [
        { selector: "node", style: { "background-color": "#131d28", "border-color": "#62b0e8", "border-width": 2, label: "data(label)", color: "#eaf0f7", "font-family": "IBM Plex Sans", "font-size": 11, "text-valign": "bottom", "text-margin-y": 8, width: 34, height: 34 } },
        { selector: "node[type = 'root']", style: { shape: "round-rectangle", width: 48, height: 48, "background-color": "#163342", "border-color": "#5ad0b0" } },
        { selector: "node[type = 'branch']", style: { shape: "round-rectangle", "background-color": "#182536", "border-color": "#62b0e8" } },
        { selector: "node[type = 'leaf']", style: { width: 25, height: 25, "background-color": "#251f38", "border-color": "#a98bfa" } },
        { selector: "node[type = 'reference']", style: { shape: "diamond", width: 28, height: 28, "background-color": "#3a2b16", "border-color": "#f3b64a" } },
        { selector: "edge", style: { width: 1.2, "line-color": "#3b5268", "target-arrow-color": "#3b5268", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", color: "#8ea1b5", "font-size": 8, "text-background-color": "#0b1118", "text-background-opacity": 0.8 } },
        { selector: "edge[type = 'ref-edge']", style: { "line-style": "dashed", "line-color": "#f3b64a", "target-arrow-color": "#f3b64a", width: 2 } },
        { selector: ":selected", style: { "border-color": "#5ad0b0", "border-width": 4, "overlay-color": "#5ad0b0", "overlay-opacity": 0.08 } },
      ],
    });
    cy.current.on("tap", "node, edge", (event) => onSelectRef.current(event.target.id()));
    cy.current.on("tap", (event) => event.target === cy.current && onSelectRef.current(undefined));
    return () => cy.current?.destroy();
  }, []);

  useEffect(() => {
    if (!cy.current) return;
    const definitions = elements(graph);
    const incomingIds = new Set(definitions.map((item) => String(item.data.id)));
    cy.current.elements().filter((item) => !incomingIds.has(item.id())).remove();
    const newNodes = definitions.filter((item) => item.data.source === undefined && cy.current?.$id(String(item.data.id)).empty());
    const newEdges = definitions.filter((item) => item.data.source !== undefined && cy.current?.$id(String(item.data.id)).empty());
    cy.current.add(newNodes);
    cy.current.add(newEdges);
    definitions.forEach((item) => cy.current?.$id(String(item.data.id)).data(item.data));
    newNodes.forEach((item, index) => {
      const node = cy.current?.$id(String(item.data.id));
      const neighbors = node?.neighborhood("node");
      if (node && neighbors?.length) {
        const anchor = neighbors.nodes().first().position();
        node.position({ x: anchor.x + 64 + index * 8, y: anchor.y + index * 24 });
      }
    });
    if (!hasLaidOut.current && definitions.length) {
      cy.current.layout(layoutOptions(layout)).run();
      hasLaidOut.current = true;
    }
  }, [graph, layout]);

  useEffect(() => { cy.current?.layout(layoutOptions(layout)).run(); }, [layout, relayoutToken]);
  useEffect(() => { if (cy.current && selectedId) cy.current.$id(selectedId).select(); }, [selectedId]);

  return <div className="graph-canvas" ref={host} aria-label="Dynamic master context graph" />;
}
