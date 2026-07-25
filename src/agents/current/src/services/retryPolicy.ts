const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set([
  "eai_again",
  "econnaborted",
  "econnrefused",
  "econnreset",
  "ehostdown",
  "ehostunreach",
  "enetdown",
  "enetreset",
  "enetunreach",
  "epipe",
  "etimedout",
  "resource_exhausted",
  "und_err_body_timeout",
  "und_err_connect_timeout",
  "und_err_headers_timeout",
  "und_err_socket",
]);

const RETRYABLE_ERROR_NAME =
  /^(?:api)?(?:connection|network|fetch|socket|request)?(?:abort|timeout|connection|network|fetch|socket)error$/i;
const RETRYABLE_ERROR_MESSAGE =
  /\b(?:connection (?:error|failed|refused|reset)|fetch failed|network (?:error|request failed)|rate limit(?:ed| exceeded)?|request (?:timed out|timeout)|service unavailable|socket hang up|temporarily unavailable|timed out|timeout|too many requests)\b/i;

type RetryDecision = "retryable" | "terminal" | "unknown";

function objectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeProperty(value: object, property: PropertyKey): unknown {
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function safeStringProperty(value: object, property: PropertyKey): string | null {
  const candidate = safeProperty(value, property);
  return typeof candidate === "string" ? candidate : null;
}

function safeNumberProperty(value: object, property: PropertyKey): number | null {
  const candidate = safeProperty(value, property);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function constructorName(value: object): string | null {
  const constructor = safeProperty(value, "constructor");
  return objectLike(constructor) ? safeStringProperty(constructor, "name") : null;
}

function statusDecision(value: object): RetryDecision {
  const status =
    safeNumberProperty(value, "status") ?? safeNumberProperty(value, "statusCode");
  if (status === null) return "unknown";
  if (RETRYABLE_HTTP_STATUSES.has(status) || status >= 500) return "retryable";
  if (status >= 400 && status < 500) return "terminal";
  return "unknown";
}

function directDecision(value: object): RetryDecision {
  const status = statusDecision(value);
  if (status !== "unknown") return status;

  const code = safeStringProperty(value, "code")?.toLowerCase();
  if (code && RETRYABLE_ERROR_CODES.has(code)) return "retryable";

  const names = [safeStringProperty(value, "name"), constructorName(value)];
  if (names.some((name) => name !== null && RETRYABLE_ERROR_NAME.test(name))) {
    return "retryable";
  }

  const message = safeStringProperty(value, "message");
  return message && RETRYABLE_ERROR_MESSAGE.test(message) ? "retryable" : "unknown";
}

/**
 * Classifies transient provider and transport failures without depending on a
 * particular SDK's error classes. Inspection is bounded, cycle-safe, and
 * limited to common error metadata so arbitrary provider payloads are not
 * traversed.
 */
export function isRetryableProviderError(error: unknown): boolean {
  if (!objectLike(error)) return false;

  const seen = new Set<object>();
  let current: object | null = error;
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);

    const decision = directDecision(current);
    if (decision === "retryable") return true;
    if (decision === "terminal") return false;

    const cause = safeProperty(current, "cause");
    current = objectLike(cause) ? cause : null;
  }
  return false;
}
