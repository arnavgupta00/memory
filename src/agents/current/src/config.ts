import { z } from "zod";

import { ProviderRoleConfigSchema, type ProviderRoleConfig } from "./types.js";

export const ProviderModelLimitSchema = z.strictObject({
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(1),
  max_concurrency: z.number().int().positive().max(256),
  token_budget: z.number().int().positive(),
  window_seconds: z.number().int().positive().max(3600),
});
export type ProviderModelLimitConfig = z.infer<typeof ProviderModelLimitSchema>;

/** Defaults match the best offline recall cell: W2/S1/K48/80k. */
export const ArchitectureOptionsSchema = z.strictObject({
  window_turns: z.number().int().positive().max(64).default(2),
  window_stride: z.number().int().positive().max(64).default(1),
  top_k: z.number().int().positive().max(256).default(48),
  char_budget: z.number().int().positive().max(500_000).default(80_000),
  max_turn_chars: z.number().int().positive().max(50_000).default(4_000),
  temporal_boost: z.number().min(0).max(2).default(0.15),
  /**
   * BM25 indexes user-turn text only (assistant turns still packaged).
   * Phase-1 rank-gate winner on canary-1 answerable.
   */
  index_user_turns_only: z.boolean().default(true),
  answer_prompt: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default("answer-v2-evidence"),
  select_enabled: z.boolean().default(false),
  select_prompt: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default("select-v2"),
  package_max_turns: z.number().int().positive().max(64).default(40),
  package_char_budget: z.number().int().positive().max(200_000).default(40_000),
  package_supporting_enabled: z.boolean().default(true),
  /** For aggregate/order: pull entity-overlapping sibling sessions into SUPPORTING. */
  package_sibling_sessions_enabled: z.boolean().default(true),
  package_sibling_session_max: z.number().int().positive().max(32).default(12),
  /**
   * When true, any turn of a session that contributed at least one BM25 span is
   * resolvable / expandable — not only turns inside matched windows.
   */
  package_full_session_enabled: z.boolean().default(true),
  /** Cap supporting turns pulled from each allowed session under full-session mode. */
  package_session_turn_max: z.number().int().positive().max(64).default(24),
  /**
   * U-FLOOR: always attach top-N BM25 span turns as SUPPORTING, even when Call-1
   * under-picks or returns none_found. Deterministic lexical guard; never enters
   * as selected.
   */
  package_lexical_floor_enabled: z.boolean().default(false),
  package_lexical_floor_max: z.number().int().positive().max(64).default(12),
  /** Call 1 session-routing index over the full haystack (Architecture 0006). */
  session_index_enabled: z.boolean().default(false),
  session_expand_max: z.number().int().positive().max(16).default(8),
  /** Pull haystack sessions that share an ID series prefix with BM25 hits. */
  series_expand_enabled: z.boolean().default(false),
  series_expand_max: z.number().int().positive().max(32).default(16),
  /** Call-1.5: normalize the ContextPackage into a dated fact digest. */
  format_enabled: z.boolean().default(false),
  format_prompt: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default("format-v1"),
  /**
   * How Call-2 consumes the digest:
   * - replacement: digest only (raw package omitted)
   * - additive: digest first, then the unchanged raw package
   */
  format_mode: z.enum(["replacement", "additive"]).default("additive"),
});
export type ArchitectureOptions = z.infer<typeof ArchitectureOptionsSchema>;

export const HostInitializationSchema = z
  .strictObject({
    runId: z.string().min(1),
    runRoot: z.string().min(1),
    roles: z.strictObject({
      answer: ProviderRoleConfigSchema,
      select: ProviderRoleConfigSchema.optional(),
      format: ProviderRoleConfigSchema.optional(),
    }),
    providerModelLimits: z.array(ProviderModelLimitSchema).min(1),
    options: ArchitectureOptionsSchema,
    captureModelIo: z.boolean().default(false),
    autoExportFinalSvg: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const keys = value.providerModelLimits.map(
      (limit) => `${limit.provider}\u0000${limit.model}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["providerModelLimits"],
        message: "provider/model rate limits must use unique provider and model pairs",
      });
    }
    const available = new Set(keys);
    for (const [role, config] of Object.entries(value.roles)) {
      if (!config) continue;
      if (!available.has(`${config.provider}\u0000${config.model}`)) {
        context.addIssue({
          code: "custom",
          path: ["roles", role],
          message: `role is missing provider/model rate limit for ${config.provider}/${config.model}`,
        });
      }
    }
    if (value.options.select_enabled && value.roles.select === undefined) {
      context.addIssue({
        code: "custom",
        path: ["roles", "select"],
        message: "select_enabled requires a select role configuration",
      });
    }
    if (value.options.format_enabled && value.roles.format === undefined) {
      context.addIssue({
        code: "custom",
        path: ["roles", "format"],
        message: "format_enabled requires a format role configuration",
      });
    }
    if (value.options.format_enabled && !value.options.select_enabled) {
      context.addIssue({
        code: "custom",
        path: ["options", "format_enabled"],
        message: "format_enabled requires select_enabled (Call-1.5 needs a ContextPackage)",
      });
    }
  });
export type HostInitialization = z.infer<typeof HostInitializationSchema>;

export type RoleName = "answer" | "select" | "format";
export type RoleConfigs = {
  answer: ProviderRoleConfig;
  select?: ProviderRoleConfig;
  format?: ProviderRoleConfig;
};
