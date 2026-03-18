import { z } from "zod/v4";

export const providerConfigSchema = z.object({
	enabled: z.boolean().optional().default(true),
	apiKey: z.string().optional(),
	baseUrl: z.string().url().optional(),
	defaultModel: z.string().optional(),
	region: z.string().optional(),
	projectId: z.string().optional(),
	/** AWS profile name for Bedrock credential loading from ~/.aws/credentials */
	profile: z.string().optional(),
	/** Model name mapping for providers that use different model identifiers (e.g. OpenAI) */
	modelMap: z.record(z.string(), z.string()).optional(),
});

const serverDefaults = { host: "127.0.0.1", port: 3080 };
const retryDefaults = { maxRetries: 1, minTimeoutMs: 500, maxTimeoutMs: 5000, requestTimeoutMs: 120_000 };
const providerDefaults = { enabled: true };
const circuitBreakerDefaults = {
	failureThreshold: 5,
	failureWindowMs: 300_000,
	cooldownMs: 600_000,
};
const routingDefaults = {
	providerOrder: ["anthropic", "vertex", "bedrock"] as string[],
};

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
			vertex: providerConfigSchema.default({ enabled: false }),
			bedrock: providerConfigSchema.default({ enabled: false }),
			openai: providerConfigSchema.default({ enabled: false }),
		})
		.default({
			anthropic: providerDefaults,
			vertex: { enabled: false },
			bedrock: { enabled: false },
			openai: { enabled: false },
		}),
	routing: z
		.object({
			providerOrder: z.array(z.string()).default(routingDefaults.providerOrder),
		})
		.default(routingDefaults),
	circuitBreaker: z
		.object({
			failureThreshold: z.number().int().min(1).default(circuitBreakerDefaults.failureThreshold),
			failureWindowMs: z.number().int().min(1000).default(circuitBreakerDefaults.failureWindowMs),
			cooldownMs: z.number().int().min(1000).default(circuitBreakerDefaults.cooldownMs),
		})
		.default(circuitBreakerDefaults),
	retry: z
		.object({
			maxRetries: z.number().int().min(0).max(10).default(retryDefaults.maxRetries),
			minTimeoutMs: z.number().int().min(0).default(retryDefaults.minTimeoutMs),
			maxTimeoutMs: z.number().int().min(0).default(retryDefaults.maxTimeoutMs),
			requestTimeoutMs: z.number().int().min(1000).default(retryDefaults.requestTimeoutMs),
		})
		.default(retryDefaults),
});
