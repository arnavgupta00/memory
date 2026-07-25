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

export const ArchitectureOptionsSchema = z
  .strictObject({
    graph_batch_size: z.number().int().positive().max(64).default(3),
    summary_batch_size: z.number().int().positive().max(128).default(9),
    latest_raw_sessions: z.number().int().positive().max(128).default(9),
    allow_graph_replacement: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (value.summary_batch_size < value.graph_batch_size) {
      context.addIssue({
        code: "custom",
        path: ["summary_batch_size"],
        message: "summary_batch_size must be greater than or equal to graph_batch_size",
      });
    }
    if (value.summary_batch_size % value.graph_batch_size !== 0) {
      context.addIssue({
        code: "custom",
        path: ["summary_batch_size"],
        message: "summary_batch_size must be divisible by graph_batch_size",
      });
    }
    if (value.latest_raw_sessions < value.summary_batch_size - 1) {
      context.addIssue({
        code: "custom",
        path: ["latest_raw_sessions"],
        message: "latest_raw_sessions must cover the largest incomplete summary remainder",
      });
    }
  });
export type ArchitectureOptions = z.infer<typeof ArchitectureOptionsSchema>;

export const HostInitializationSchema = z.strictObject({
  runId: z.string().min(1),
  runRoot: z.string().min(1),
  roles: z.strictObject({
    contexto: ProviderRoleConfigSchema,
    shino: ProviderRoleConfigSchema,
    reader: ProviderRoleConfigSchema,
    answer: ProviderRoleConfigSchema,
  }),
  providerModelLimits: z.array(ProviderModelLimitSchema).min(1),
  options: ArchitectureOptionsSchema,
  captureModelIo: z.boolean().default(false),
  autoExportFinalSvg: z.boolean().default(true),
}).superRefine((value, context) => {
  const keys = value.providerModelLimits.map((limit) => `${limit.provider}\u0000${limit.model}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["providerModelLimits"],
      message: "provider/model rate limits must use unique provider and model pairs",
    });
  }
  const available = new Set(keys);
  for (const [role, config] of Object.entries(value.roles)) {
    if (!available.has(`${config.provider}\u0000${config.model}`)) {
      context.addIssue({
        code: "custom",
        path: ["roles", role],
        message: `role is missing provider/model rate limit for ${config.provider}/${config.model}`,
      });
    }
  }
});
export type HostInitialization = z.infer<typeof HostInitializationSchema>;

export type RoleName = "contexto" | "shino" | "reader" | "answer";
export type RoleConfigs = Record<RoleName, ProviderRoleConfig>;
