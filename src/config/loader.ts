import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { configSchema } from "./schema.ts";
import { logger } from "../telemetry/logger.ts";
import type { Config } from "../types/index.ts";

const CONFIG_DIR = join(homedir(), ".config", "parachute-proxy");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
	let raw: Record<string, unknown> = {};

	if (existsSync(CONFIG_PATH)) {
		const content = readFileSync(CONFIG_PATH, "utf-8");
		raw = JSON.parse(content);
		logger.info("Loaded config", { path: CONFIG_PATH });
	} else {
		logger.warn("No config file found, using defaults", {
			path: CONFIG_PATH,
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
