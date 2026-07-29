import type { TimestampedSession } from "../types.js";
import type { TurnWindow } from "./types.js";

export function windowDocumentId(
  sessionId: string,
  startTurn: number,
  endTurn: number,
): string {
  return `${sessionId}#${String(startTurn)}-${String(endTurn)}`;
}

export function parseWindowDocumentId(documentId: string): {
  sessionId: string;
  startTurn: number;
  endTurn: number;
} {
  const separator = documentId.lastIndexOf("#");
  if (separator <= 0) throw new Error(`invalid window document ID: ${documentId}`);
  const sessionId = documentId.slice(0, separator);
  const range = documentId.slice(separator + 1);
  const [startRaw, endRaw] = range.split("-");
  const startTurn = Number(startRaw);
  const endTurn = Number(endRaw);
  if (
    !sessionId ||
    !Number.isInteger(startTurn) ||
    !Number.isInteger(endTurn) ||
    startTurn < 0 ||
    endTurn < startTurn
  ) {
    throw new Error(`invalid window document ID: ${documentId}`);
  }
  return { sessionId, startTurn, endTurn };
}

export type RenderWindowTextOptions = {
  indexUserTurnsOnly?: boolean;
  /** Session-wide expansion blob appended to every window. */
  sessionExpansion?: string;
  /** Turn-anchored expansion lines for turns inside this window. */
  turnExpansions?: string[];
};

export function renderWindowText(
  session: TimestampedSession,
  startTurn: number,
  endTurn: number,
  options: RenderWindowTextOptions = {},
): string {
  const indexUserTurnsOnly = options.indexUserTurnsOnly ?? false;
  const lines = [`[session_date] ${session.date}`];
  for (let index = startTurn; index <= endTurn; index += 1) {
    const turn = session.turns[index];
    if (!turn) throw new Error(`missing turn ${String(index)} in session ${session.session_id}`);
    if (indexUserTurnsOnly && turn.role !== "user") continue;
    lines.push(`[${turn.role}] ${turn.content}`);
  }
  if (options.sessionExpansion?.trim()) {
    lines.push(`[expansion] ${options.sessionExpansion.trim()}`);
  }
  for (const extra of options.turnExpansions ?? []) {
    if (extra.trim()) lines.push(`[expansion] ${extra.trim()}`);
  }
  return lines.join("\n");
}

export type BuildTurnWindowsOptions = {
  indexUserTurnsOnly?: boolean;
  expansionBySessionId?: Record<string, string>;
  expansionBySessionTurn?: Record<string, Record<string, string>>;
};

export function buildTurnWindows(
  sessions: TimestampedSession[],
  windowTurns: number,
  windowStride: number,
  options: BuildTurnWindowsOptions = {},
): TurnWindow[] {
  if (!Number.isInteger(windowTurns) || windowTurns < 1) {
    throw new Error("windowTurns must be a positive integer");
  }
  if (!Number.isInteger(windowStride) || windowStride < 1) {
    throw new Error("windowStride must be a positive integer");
  }

  const indexUserTurnsOnly = options.indexUserTurnsOnly ?? false;
  const windows: TurnWindow[] = [];
  for (const session of sessions) {
    const turnCount = session.turns.length;
    if (turnCount === 0) continue;
    const sessionExpansion = options.expansionBySessionId?.[session.session_id];
    const turnMap = options.expansionBySessionTurn?.[session.session_id];

    const pushWindow = (startTurn: number, endTurn: number): void => {
      const turnExpansions: string[] = [];
      if (turnMap) {
        for (let index = startTurn; index <= endTurn; index += 1) {
          const extra = turnMap[String(index)];
          if (extra) turnExpansions.push(extra);
        }
      }
      windows.push({
        document: {
          id: windowDocumentId(session.session_id, startTurn, endTurn),
          text: renderWindowText(session, startTurn, endTurn, {
            indexUserTurnsOnly,
            ...(sessionExpansion !== undefined ? { sessionExpansion } : {}),
            turnExpansions,
          }),
          sessionId: session.session_id,
          date: session.date,
          startTurn,
          endTurn,
        },
        turns: session.turns.slice(startTurn, endTurn + 1),
      });
    };

    if (turnCount <= windowTurns) {
      pushWindow(0, turnCount - 1);
      continue;
    }

    for (let startTurn = 0; startTurn < turnCount; startTurn += windowStride) {
      const endTurn = Math.min(startTurn + windowTurns - 1, turnCount - 1);
      pushWindow(startTurn, endTurn);
      if (endTurn === turnCount - 1) break;
    }
  }
  return windows;
}
