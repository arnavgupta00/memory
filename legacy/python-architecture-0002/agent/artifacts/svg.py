from __future__ import annotations

import html
import math

from agents.current.contracts.models import GraphState


def render_graph_svg(graph: GraphState) -> str:
    width, height = 1400, 900
    entities = list(graph.entities.values())
    positions: dict[str, tuple[float, float]] = {}
    radius = min(width, height) * 0.34
    for index, entity in enumerate(entities):
        angle = 2 * math.pi * index / max(len(entities), 1) - math.pi / 2
        positions[entity.id] = (
            width / 2 + radius * math.cos(angle),
            height / 2 + radius * math.sin(angle),
        )
    lines: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#0B1118"/>',
        '<g stroke="#33465A" stroke-width="2" fill="none">',
    ]
    for relation in graph.relations.values():
        if relation.source_id in positions and relation.target_id in positions:
            x1, y1 = positions[relation.source_id]
            x2, y2 = positions[relation.target_id]
            lines.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"/>')
    lines.append("</g>")
    for entity in entities:
        x, y = positions[entity.id]
        name = html.escape(entity.canonical_name)
        kind = html.escape(entity.kind)
        lines.extend(
            [
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="46" fill="#131D28" '
                'stroke="#62B0E8" stroke-width="3"/>',
                f'<text x="{x:.1f}" y="{y - 4:.1f}" text-anchor="middle" '
                f'fill="#EAF0F7" font-family="sans-serif" font-size="14">{name[:22]}</text>',
                f'<text x="{x:.1f}" y="{y + 17:.1f}" text-anchor="middle" '
                f'fill="#5AD0B0" font-family="monospace" font-size="10">{kind[:24]}</text>',
            ]
        )
    lines.append("</svg>")
    return "\n".join(lines)
