import { randomUUID } from "node:crypto";

import type { JsonObject, TokenUsage } from "../types.js";
import type { ArtifactStore } from "./artifacts.js";

export type ProviderModelLimit = {
  provider: "openai" | "gemini";
  model: string;
  maxConcurrency: number;
  tokenBudget: number;
  windowSeconds: number;
};

export type RateLimitRequest = {
  artifactScope: string;
  role: string;
  callKey: string;
  attempt: number;
  estimatedInputTokens: number;
  outputTokenCeiling: number;
};

export type RateLimitDispatch = {
  schema_version: 1;
  event_type: "model_attempt_dispatched";
  lease_id: string;
  artifact_scope: string;
  role: string;
  call_key: string;
  attempt: number;
  provider: "openai" | "gemini";
  model: string;
  queued_at: string;
  dispatched_at: string;
  wait_ms: number;
  estimator: "utf8_bytes_div_3_plus_output_ceiling_v1";
  estimated_input_tokens: number;
  output_token_ceiling: number;
  reserved_tokens: number;
  window_seconds: number;
  token_budget: number;
  reserved_before: number;
  reserved_after: number;
  concurrency_limit: number;
  active_after: number;
};

export type RateLimitCompletion = {
  schema_version: 1;
  event_type: "model_attempt_completed";
  lease_id: string;
  completed_at: string;
  outcome: "success" | "retryable_error" | "terminal_error";
  usage: TokenUsage | null;
  active_after: number;
};

export type RateLimitScheduleEvent = RateLimitDispatch | RateLimitCompletion;

export type RateLimiterClock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export type RateScheduleSink = (event: RateLimitScheduleEvent) => Promise<void>;

type Reservation = {
  leaseId: string;
  dispatchedAt: number;
  tokens: number;
};

type Pending = {
  request: RateLimitRequest;
  queuedAt: number;
  resolve: (lease: RateLimitLease) => void;
  reject: (error: Error) => void;
};

export type RateLimitLease = {
  leaseId: string;
  dispatch: RateLimitDispatch;
};

const SYSTEM_CLOCK: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function providerModelKey(provider: "openai" | "gemini", model: string): string {
  return `${provider}\u0000${model}`;
}

export class RateScheduleRecorder {
  readonly #store: ArtifactStore;

  constructor(store: ArtifactStore) {
    this.#store = store;
  }

  async events(): Promise<RateLimitScheduleEvent[]> {
    return (await this.#store.readJsonl("rate-limits/schedule")).map((event) =>
      event as unknown as RateLimitScheduleEvent
    );
  }

  async record(event: RateLimitScheduleEvent): Promise<void> {
    await this.#store.append("rate-limits/schedule", event as unknown as JsonObject);
  }
}

export class ProviderModelRateLimiter {
  readonly #limit: ProviderModelLimit;
  readonly #clock: RateLimiterClock;
  readonly #sink: RateScheduleSink;
  readonly #reservations: Reservation[] = [];
  readonly #queue: Pending[] = [];
  #active = 0;
  #draining = false;

  constructor(
    limit: ProviderModelLimit,
    options: {
      clock?: RateLimiterClock;
      sink?: RateScheduleSink;
      hydratedDispatches?: RateLimitDispatch[];
    } = {},
  ) {
    if (!Number.isInteger(limit.maxConcurrency) || limit.maxConcurrency < 1) {
      throw new Error("provider/model concurrency must be positive");
    }
    if (!Number.isInteger(limit.tokenBudget) || limit.tokenBudget < 1) {
      throw new Error("provider/model token budget must be positive");
    }
    if (!Number.isInteger(limit.windowSeconds) || limit.windowSeconds < 1) {
      throw new Error("provider/model rate window must be positive");
    }
    this.#limit = limit;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#sink = options.sink ?? (() => Promise.resolve());
    const now = this.#clock.now();
    const cutoff = now - this.#windowMilliseconds();
    for (const dispatch of options.hydratedDispatches ?? []) {
      const dispatchedAt = Date.parse(dispatch.dispatched_at);
      if (
        dispatch.provider === limit.provider
        && dispatch.model === limit.model
        && Number.isFinite(dispatchedAt)
        && dispatchedAt > cutoff
      ) {
        this.#reservations.push({
          leaseId: dispatch.lease_id,
          dispatchedAt,
          tokens: dispatch.reserved_tokens,
        });
      }
    }
    this.#reservations.sort((left, right) => left.dispatchedAt - right.dispatchedAt);
  }

  async acquire(request: RateLimitRequest): Promise<RateLimitLease> {
    const reservedTokens = request.estimatedInputTokens + request.outputTokenCeiling;
    if (reservedTokens > this.#limit.tokenBudget) {
      throw new Error(
        `request reservation ${String(reservedTokens)} exceeds ${this.#limit.provider}/`
        + `${this.#limit.model} token budget ${String(this.#limit.tokenBudget)}`,
      );
    }
    return new Promise<RateLimitLease>((resolve, reject) => {
      this.#queue.push({
        request,
        queuedAt: this.#clock.now(),
        resolve,
        reject,
      });
      void this.#drain();
    });
  }

  async complete(
    lease: RateLimitLease,
    outcome: RateLimitCompletion["outcome"],
    usage: TokenUsage | null,
  ): Promise<void> {
    this.#active = Math.max(0, this.#active - 1);
    await this.#sink({
      schema_version: 1,
      event_type: "model_attempt_completed",
      lease_id: lease.leaseId,
      completed_at: iso(this.#clock.now()),
      outcome,
      usage,
      active_after: this.#active,
    });
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        this.#prune();
        if (this.#active >= this.#limit.maxConcurrency) return;
        const pending = this.#queue[0];
        if (!pending) return;
        const requested = pending.request.estimatedInputTokens + pending.request.outputTokenCeiling;
        const reservedBefore = this.#reservations.reduce((sum, item) => sum + item.tokens, 0);
        if (reservedBefore + requested > this.#limit.tokenBudget) {
          const oldest = this.#reservations[0];
          if (!oldest) {
            this.#queue.shift();
            pending.reject(new Error("rate limiter could not admit an otherwise valid reservation"));
            continue;
          }
          const wait = oldest.dispatchedAt + this.#windowMilliseconds() - this.#clock.now();
          if (wait > 0) {
            await this.#clock.sleep(wait);
            continue;
          }
          this.#prune();
          continue;
        }
        this.#queue.shift();
        const dispatchedAt = this.#clock.now();
        const leaseId = randomUUID();
        this.#active += 1;
        this.#reservations.push({ leaseId, dispatchedAt, tokens: requested });
        const dispatch: RateLimitDispatch = {
          schema_version: 1,
          event_type: "model_attempt_dispatched",
          lease_id: leaseId,
          artifact_scope: pending.request.artifactScope,
          role: pending.request.role,
          call_key: pending.request.callKey,
          attempt: pending.request.attempt,
          provider: this.#limit.provider,
          model: this.#limit.model,
          queued_at: iso(pending.queuedAt),
          dispatched_at: iso(dispatchedAt),
          wait_ms: Math.max(0, dispatchedAt - pending.queuedAt),
          estimator: "utf8_bytes_div_3_plus_output_ceiling_v1",
          estimated_input_tokens: pending.request.estimatedInputTokens,
          output_token_ceiling: pending.request.outputTokenCeiling,
          reserved_tokens: requested,
          window_seconds: this.#limit.windowSeconds,
          token_budget: this.#limit.tokenBudget,
          reserved_before: reservedBefore,
          reserved_after: reservedBefore + requested,
          concurrency_limit: this.#limit.maxConcurrency,
          active_after: this.#active,
        };
        try {
          await this.#sink(dispatch);
          pending.resolve({ leaseId, dispatch });
        } catch (error) {
          this.#active = Math.max(0, this.#active - 1);
          const index = this.#reservations.findIndex((item) => item.leaseId === leaseId);
          if (index >= 0) this.#reservations.splice(index, 1);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0 && this.#active < this.#limit.maxConcurrency) {
        void this.#drain();
      }
    }
  }

  #prune(): void {
    const cutoff = this.#clock.now() - this.#windowMilliseconds();
    while (this.#reservations[0] && this.#reservations[0].dispatchedAt <= cutoff) {
      this.#reservations.shift();
    }
  }

  #windowMilliseconds(): number {
    return this.#limit.windowSeconds * 1000;
  }
}
