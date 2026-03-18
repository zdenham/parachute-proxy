import { z } from "zod/v4";

export const providerConfigSchema = z.object({
	enabled: z.boolean().optional().default(true),
	apiKey: z.string().optional(),
	baseUrl: z.string().url().optional(),
	defaultModel: z.string().optional(),
});

const serverDefaults = { host: "127.0.0.1", port: 3080 };
const retryDefaults = { maxRetries: 2, minTimeoutMs: 500, maxTimeoutMs: 5000 };
const providerDefaults = { enabled: true };

export const configSchema = z.object({
	server: z
		.object({
			host: z.string().default(serverDefaults.host),
			port: z.number().int().min(1).max(65535).default(serverDefaults.port),
		})
		.default(serverDefaults),
	providers: z
		.object({
			anthropic: providerConfigSchema.default(providerDefaults),
		})
		.default({ anthropic: providerDefaults }),
	retry: z
		.object({
			maxRetries: z.number().int().min(0).max(10).default(retryDefaults.maxRetries),
			minTimeoutMs: z.number().int().min(0).default(retryDefaults.minTimeoutMs),
			maxTimeoutMs: z.number().int().min(0).default(retryDefaults.maxTimeoutMs),
		})
		.default(retryDefaults),
});
