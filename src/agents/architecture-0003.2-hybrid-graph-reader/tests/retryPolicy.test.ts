import { APIConnectionError } from "openai";
import { describe, expect, test } from "vitest";

import { isRetryableProviderError } from "../src/services/retryPolicy.js";

describe("provider-neutral retry policy", () => {
  test("recognizes the OpenAI SDK connection error whose public name is only Error", () => {
    const error = new APIConnectionError({
      message: "Connection error.",
      cause: new TypeError("fetch failed"),
    });

    expect(error.name).toBe("Error");
    expect(isRetryableProviderError(error)).toBe(true);
  });

  test.each([
    Object.assign(new Error("upstream unavailable"), { status: 503 }),
    Object.assign(new Error("opaque transport failure"), { code: "ECONNRESET" }),
    Object.assign(new Error("outer failure"), {
      cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
    }),
    new DOMException("operation aborted", "AbortError"),
    new TypeError("fetch failed"),
  ])("recognizes transient status, code, name, message, and cause signals", (error) => {
    expect(isRetryableProviderError(error)).toBe(true);
  });

  test.each([
    Object.assign(new Error("invalid request"), { status: 400 }),
    Object.assign(new Error("authentication failed"), {
      status: 401,
      cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    }),
    Object.assign(new Error("invalid schema"), { code: "VALIDATION_ERROR" }),
    new TypeError("cannot read properties of undefined"),
    "Connection error.",
    null,
  ])("does not retry terminal or non-error failures", (error) => {
    expect(isRetryableProviderError(error)).toBe(false);
  });

  test("handles hostile getters and cyclic causes without throwing", () => {
    const cyclic: { cause?: unknown; message?: string } = { message: "ordinary failure" };
    cyclic.cause = cyclic;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "status", {
      get(): never {
        throw new Error("getter failure");
      },
    });
    hostile.cause = cyclic;

    expect(isRetryableProviderError(hostile)).toBe(false);
  });
});
