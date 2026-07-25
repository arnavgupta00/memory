import { describe, expect, test } from "vitest";

import {
  ProviderModelRateLimiter,
  type RateLimitDispatch,
  type RateLimitScheduleEvent,
  type RateLimiterClock,
} from "../src/services/providerModelRateLimiter.js";

class FakeClock implements RateLimiterClock {
  milliseconds = Date.parse("2026-07-23T00:00:00.000Z");

  now(): number {
    return this.milliseconds;
  }

  sleep(milliseconds: number): Promise<void> {
    this.milliseconds += milliseconds;
    return Promise.resolve();
  }
}

const request = (callKey: string, estimatedInputTokens: number, outputTokenCeiling = 0) => ({
  artifactScope: `case/${callKey}`,
  role: "contexto",
  callKey,
  attempt: 1,
  estimatedInputTokens,
  outputTokenCeiling,
});

describe("provider/model sliding-window limiter", () => {
  test("waits for the token window and never exceeds the configured concurrency or budget", async () => {
    const clock = new FakeClock();
    const events: RateLimitScheduleEvent[] = [];
    const limiter = new ProviderModelRateLimiter(
      {
        provider: "openai",
        model: "gpt-fixture",
        maxConcurrency: 2,
        tokenBudget: 100,
        windowSeconds: 60,
      },
      { clock, sink: (event) => { events.push(event); return Promise.resolve(); } },
    );
    const first = await limiter.acquire(request("first", 60));
    const secondPromise = limiter.acquire(request("second", 40));
    const second = await secondPromise;
    const thirdPromise = limiter.acquire(request("third", 50));
    await limiter.complete(first, "success", {
      input_tokens: 60,
      output_tokens: 0,
      total_tokens: 60,
    });
    await limiter.complete(second, "success", {
      input_tokens: 40,
      output_tokens: 0,
      total_tokens: 40,
    });
    const third = await thirdPromise;
    expect(Date.parse(third.dispatch.dispatched_at) - Date.parse(first.dispatch.dispatched_at))
      .toBe(60_000);
    const dispatches = events.filter(
      (event): event is RateLimitDispatch => event.event_type === "model_attempt_dispatched",
    );
    expect(dispatches.every((event) => event.active_after <= 2)).toBe(true);
    expect(dispatches.every((event) => event.reserved_after <= 100)).toBe(true);
  });

  test("hydrates recent reservations, ignores expired reservations, and rejects oversized calls", async () => {
    const clock = new FakeClock();
    const recentTime = new Date(clock.now() - 30_000).toISOString();
    const expiredTime = new Date(clock.now() - 61_000).toISOString();
    const dispatch = (lease: string, dispatchedAt: string): RateLimitDispatch => ({
      schema_version: 1,
      event_type: "model_attempt_dispatched",
      lease_id: lease,
      artifact_scope: "case/q",
      role: "answer",
      call_key: "answer:final",
      attempt: 1,
      provider: "openai",
      model: "gpt-fixture",
      queued_at: dispatchedAt,
      dispatched_at: dispatchedAt,
      wait_ms: 0,
      estimator: "utf8_bytes_div_3_plus_output_ceiling_v1",
      estimated_input_tokens: 60,
      output_token_ceiling: 0,
      reserved_tokens: 60,
      window_seconds: 60,
      token_budget: 100,
      reserved_before: 0,
      reserved_after: 60,
      concurrency_limit: 2,
      active_after: 1,
    });
    const limiter = new ProviderModelRateLimiter(
      {
        provider: "openai",
        model: "gpt-fixture",
        maxConcurrency: 2,
        tokenBudget: 100,
        windowSeconds: 60,
      },
      {
        clock,
        hydratedDispatches: [
          dispatch("recent", recentTime),
          dispatch("expired", expiredTime),
        ],
      },
    );
    const lease = await limiter.acquire(request("after-resume", 50));
    expect(Date.parse(lease.dispatch.dispatched_at) - clock.milliseconds).toBe(0);
    expect(lease.dispatch.wait_ms).toBe(30_000);
    await expect(limiter.acquire(request("oversized", 101))).rejects.toThrow(
      "exceeds openai/gpt-fixture token budget",
    );
  });
});
