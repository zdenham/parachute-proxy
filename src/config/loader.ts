import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { configSchema } from "./schema.ts";
import { logger } from "../telemetry/logger.ts";
import type { Config } from "../types/index.ts";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "parachute-proxy", "config.json");

export function loadConfig(): Config {
	const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
	let raw: Record<string, unknown> = {};

	if (existsSync(configPath)) {
		const content = readFileSync(configPath, "utf-8");
		raw = JSON.parse(content);
		logger.info("Loaded config", { path: configPath });
	} else {
		logger.warn("No config file found, using defaults", {
			path: configPath,
		});
	}

	// Apply env var overrides
	const anthropicKey =
		process.env.ANTHROPIC_API_KEY ??
		(raw.providers as Record<string, Record<string, unknown>> | undefined)
			?.anthropic?.apiKey;
	if (anthropicKey) {
		raw.providers = {
			...(raw.providers as Record<string, unknown> | undefined),
			anthropic: {
				...((raw.providers as Record<string, Record<string, unknown>> | undefined)?.anthropic),
				apiKey: anthropicKey,
			},
		};
	}

	// Vertex env var overrides
	const vertexProjectId = process.env.VERTEX_PROJECT_ID;
	if (vertexProjectId) {
		raw.providers = {
			...(raw.providers as Record<string, unknown> | undefined),
			vertex: {
				...((raw.providers as Record<string, Record<string, unknown>> | undefined)?.vertex),
				projectId: vertexProjectId,
				enabled: true,
			},
		};
	}

	// OpenAI env var override
	const openaiKey = process.env.OPENAI_API_KEY;
	if (openaiKey) {
		raw.providers = {
			...(raw.providers as Record<string, unknown> | undefined),
			openai: {
				...((raw.providers as Record<string, Record<string, unknown>> | undefined)?.openai),
				apiKey: openaiKey,
				enabled: true,
			},
		};
	}

	// Provider order override (comma-separated)
	const providerOrderOverride = process.env.PROVIDER_ORDER;
	if (providerOrderOverride) {
		raw.routing = {
			...(raw.routing as Record<string, unknown> | undefined),
			providerOrder: providerOrderOverride.split(",").map((s) => s.trim()),
		};
	}

	const portOverride = process.env.PROXY_PORT;
	if (portOverride) {
		raw.server = {
			...(raw.server as Record<string, unknown> | undefined),
			port: Number.parseInt(portOverride, 10),
		};
	}

	const result = configSchema.safeParse(raw);
	if (!result.success) {
		logger.error("Invalid config", {
			errors: result.error.issues.map((i) => i.message),
		});
		throw new Error(`Invalid config: ${result.error.issues.map((i) => i.message).join(", ")}`);
	}

	return result.data;
}
