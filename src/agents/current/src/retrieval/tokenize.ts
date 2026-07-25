const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "many",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

const EXPLICIT_TEMPORAL_TERMS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "today",
  "yesterday",
  "tomorrow",
]);

function stemEnglish(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function normalizeRetrievalText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, "\"")
    .replaceAll(/[–—]/g, "-");
}

export function tokenizeRetrievalText(text: string): string[] {
  return (normalizeRetrievalText(text).match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(stemEnglish)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function explicitTemporalTerms(text: string): Set<string> {
  return new Set(
    tokenizeRetrievalText(text).filter(
      (token) => EXPLICIT_TEMPORAL_TERMS.has(token) || /\d/u.test(token),
    ),
  );
}
