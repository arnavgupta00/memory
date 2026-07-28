import type { ContextDigest } from "../types.js";

/** Serialize a context digest into the {{context_digest}} fill-in. */
export function formatContextDigest(digest: ContextDigest): string {
  const sections: string[] = [];

  sections.push("## FACTS (normalized from the context package)");
  if (digest.facts.length === 0) {
    sections.push("(no facts extracted)");
  } else {
    sections.push(
      digest.facts
        .map((fact) => {
          const ref =
            fact.sessionId === null
              ? "session unknown"
              : `session ${fact.sessionId} | turn ${
                  fact.turnIndex === null ? "?" : String(fact.turnIndex)
                }`;
          return [
            `### ${fact.id}`,
            `date ${fact.date || "unknown"} | ${ref}`,
            fact.statement,
          ].join("\n");
        })
        .join("\n\n"),
    );
  }

  sections.push("## CONFLICTS (same entity, disagreeing claims — do not resolve)");
  if (digest.conflicts.length === 0) {
    sections.push("(none flagged)");
  } else {
    sections.push(
      digest.conflicts
        .map(
          (conflict, index) =>
            `### conflict ${String(index + 1)}\n`
            + `entity: ${conflict.entity}\n`
            + `factIds: ${conflict.factIds.join(", ")}\n`
            + `note: ${conflict.note}`,
        )
        .join("\n\n"),
    );
  }

  sections.push("## SET MEMBERS (candidate members for count/order questions)");
  if (digest.setMembers.length === 0) {
    sections.push("(none flagged)");
  } else {
    sections.push(
      digest.setMembers
        .map((member, index) => {
          const factRef = member.factId ? ` | factId ${member.factId}` : "";
          return (
            `${String(index + 1)}. ${member.member}`
            + ` (date ${member.date || "unknown"}${factRef})`
          );
        })
        .join("\n"),
    );
  }

  if (digest.omittedNote.trim().length > 0) {
    sections.push(`## OMITTED / UNCERTAIN\n${digest.omittedNote.trim()}`);
  }

  return sections.join("\n\n");
}
