import { z } from "zod";

import { ProviderRoleConfigSchema, type ProviderRoleConfig } from "./types.js";

export const ProviderModelLimitSchema = z.strictObject({
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(1),
  max_concurrency: z.number().int().positive().max(64),
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
});
export type ArchitectureOptions = z.infer<typeof ArchitectureOptionsSchema>;

export const HostInitializationSchema = z
  .strictObject({
    runId: z.string().min(1),
    runRoot: z.string().min(1),
    roles: z.strictObject({
      answer: ProviderRoleConfigSchema,
      select: ProviderRoleConfigSchema.optional(),
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
  });
export type HostInitialization = z.infer<typeof HostInitializationSchema>;

export type RoleName = "answer" | "select";
export type RoleConfigs = {
  answer: ProviderRoleConfig;
  select?: ProviderRoleConfig;
};
