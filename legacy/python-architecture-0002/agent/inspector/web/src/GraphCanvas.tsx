import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from "cytoscape";
import elk from "cytoscape-elk";
import fcose from "cytoscape-fcose";
import { useEffect, useRef } from "react";
import type { CanonicalGraph } from "./types";

cytoscape.use(elk);
cytoscape.use(fcose);

type Props = {
  graph: CanonicalGraph;
  layout: "elk" | "fcose" | "breadthfirst";
  selectedId?: string;
  relayoutToken: number;
  onSelect: (id?: string) => void;
};

function elements(graph: CanonicalGraph): ElementDefinition[] {
  const result: ElementDefinition[] = [];
  Object.values(graph.entities ?? {}).forEach((entity) =>
    result.push({ data: { id: entity.id, label: entity.canonical_name, detail: entity.kind, type: "entity" } }),
  );
  Object.values(graph.claims ?? {}).forEach((claim) => {
    result.push({ data: { id: claim.id, label: claim.predicate, detail: String(claim.value), type: "claim", status: claim.status } });
    result.push({ data: { id: `edge-${claim.id}`, source: claim.subject_id, target: claim.id, label: "asserts" } });
  });
  Object.values(graph.relations ?? {}).forEach((relation) =>
    result.push({ data: { id: relation.id, source: relation.source_id, target: relation.target_id, label: relation.predicate, status: relation.status } }),
  );
  return result;
}

function layoutOptions(layout: Props["layout"]): LayoutOptions {
  const options = layout === "elk"
    ? { name: "elk", fit: true, padding: 72, elk: { algorithm: "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "48" } }
    : { name: layout, fit: true, padding: 72, animate: false };
  return options as unknown as LayoutOptions;
}

export function GraphCanvas({ graph, layout, selectedId, relayoutToken, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  const hasLaidOut = useRef(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!host.current) return;
    cy.current = cytoscape({
      container: host.current,
      elements: [],
      minZoom: 0.15,
      maxZoom: 2.8,
      style: [
        { selector: "node", style: { "background-color": "#131d28", "border-color": "#62b0e8", "border-width": 2, label: "data(label)", color: "#eaf0f7", "font-family": "IBM Plex Sans", "font-size": 11, "text-valign": "bottom", "text-margin-y": 8, width: 36, height: 36 } },
        { selector: "node[type = 'claim']", style: { shape: "round-rectangle", "background-color": "#201b33", "border-color": "#a98bfa", width: 26, height: 26 } },
        { selector: "edge", style: { width: 1.3, "line-color": "#3b5268", "target-arrow-color": "#3b5268", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", color: "#8ea1b5", "font-size": 9, "text-background-color": "#0b1118" } },
        { selector: "[status = 'contradicted']", style: { "line-style": "dashed", "line-color": "#f3b64a", "border-color": "#f3b64a" } },
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
    const newNodes = definitions.filter(
      (item) => item.data.source === undefined && cy.current?.$id(String(item.data.id)).empty(),
    );
    const newEdges = definitions.filter(
      (item) => item.data.source !== undefined && cy.current?.$id(String(item.data.id)).empty(),
    );
    cy.current.add(newNodes);
    cy.current.add(newEdges);
    definitions.forEach((item) => cy.current?.$id(String(item.data.id)).data(item.data));
    newNodes.forEach((item, index) => {
      const node = cy.current?.$id(String(item.data.id));
      const neighbors = node?.neighborhood("node");
      if (node && neighbors?.length) {
        const anchor = neighbors.nodes().first().position();
        node.position({ x: anchor.x + 64 + index * 8, y: anchor.y + index * 28 });
      }
    });
    if (!hasLaidOut.current && definitions.length) {
      cy.current.layout(layoutOptions(layout)).run();
      hasLaidOut.current = true;
    }
  }, [graph, layout]);

  useEffect(() => {
    cy.current?.layout(layoutOptions(layout)).run();
  }, [layout, relayoutToken]);

  useEffect(() => {
    if (!cy.current || !selectedId) return;
    cy.current.$id(selectedId).select();
  }, [selectedId]);

  return <div className="graph-canvas" ref={host} aria-label="Temporal context graph" />;
}
