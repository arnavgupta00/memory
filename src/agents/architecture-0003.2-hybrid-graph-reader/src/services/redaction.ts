import type { JsonValue } from "../types.js";

const SECRET_VALUE = /(sk-[a-z0-9_-]{12,}|AIza[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,})/gi;
const SECRET_FIELD_SUFFIXES = [
  "api_key",
  "authorization",
  "authorization_header",
  "auth_header",
  "bearer",
  "secret",
  "password",
  "access_token",
  "refresh_token",
  "id_token",
] as const;

function normalizedFieldName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[- ]+/g, "_")
    .toLowerCase();
}

function isSecretField(key: string): boolean {
  const normalized = normalizedFieldName(key);
  return SECRET_FIELD_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`),
  );
}

function isJsonPointer(key: string): boolean {
  return key === "" || (key.startsWith("/") && !/(?:^|[^~])~(?:[^01]|$)/.test(key));
}

function configuredSecrets(): string[] {
  return [process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY].filter(
    (value): value is string => Boolean(value),
  );
}

export function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        !isJsonPointer(key) && isSecretField(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  let output = value;
  for (const secret of configuredSecrets()) output = output.replaceAll(secret, "[REDACTED]");
  return output.replace(SECRET_VALUE, "[REDACTED]");
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
  const redacted = redact(raw);
  return typeof redacted === "string" ? redacted : "unknown error";
}
