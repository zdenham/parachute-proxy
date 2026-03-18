import { spawnSync } from "node:child_process";
import type {
	ClassifiedError,
	ProviderAdapter,
	ProviderConfig,
	ProxyRequest,
} from "../../types/index.ts";

const ANTHROPIC_VERSION = "vertex-2023-10-16";

/** Cached ADC token with expiration (tokens last 60min, refresh at 50min) */
let cachedAdcToken: { token: string; expiresAt: number } | null = null;
const ADC_TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Vertex AI adapter for Claude models.
 *
 * Vertex uses the rawPredict/streamRawPredict endpoints:
 *   POST https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/publishers/anthropic/models/{MODEL}:rawPredict
 *   POST .../:streamRawPredict
 *
 * Auth: Bearer token from Application Default Credentials (ADC).
 * The request body is the same as Anthropic Messages API but with `anthropic_version` in the body.
 */
export const vertexAdapter: ProviderAdapter = {
	name: "vertex",

	translate(req: ProxyRequest, config: ProviderConfig) {
		const region = config.region ?? "us-east5";
		const projectId = config.projectId ?? "";
		const isStream = req.stream === true;
		const method = isStream ? "streamRawPredict" : "rawPredict";

		const baseUrl =
			config.baseUrl ??
			`https://${region}-aiplatform.googleapis.com`;

		const url = `${baseUrl}/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${req.model}:${method}`;

		// Resolve auth: explicit apiKey or ADC
		const token = config.apiKey || resolveAdcToken();

		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${token ?? ""}`,
		};

		// Vertex expects the Anthropic-compatible body with anthropic_version field
		const { model: _model, ...rest } = req;
		const body = JSON.stringify({
			...rest,
			anthropic_version: ANTHROPIC_VERSION,
		});

		return { url, headers, body };
	},

	classifyError(status: number, body?: string): ClassifiedError {
		let message = `Vertex error: ${status}`;
		if (body) {
			try {
				const parsed = JSON.parse(body);
				message = parsed?.error?.message ?? message;
			} catch {
				// ignore parse errors
			}
		}

		switch (true) {
			case status === 429:
				return { status, category: "throttled", message, retryable: true };
			case status === 401 || status === 403:
				return { status, category: "auth", message, retryable: false };
			case status === 400:
				return { status, category: "fatal", message, retryable: false };
			case status >= 500:
				return { status, category: "retryable", message, retryable: true };
			default:
				return { status, category: "fatal", message, retryable: false };
		}
	},
};

/**
 * Resolve an access token from Google Application Default Credentials.
 * Uses `gcloud auth application-default print-access-token` with caching.
 * Returns null if gcloud is not available or ADC is not configured.
 */
export function resolveAdcToken(): string | null {
	// Return cached token if still valid
	if (cachedAdcToken && Date.now() < cachedAdcToken.expiresAt) {
		return cachedAdcToken.token;
	}

	try {
		const result = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], {
			timeout: 5000,
			env: process.env,
		});

		if (result.status !== 0) return null;

		const token = result.stdout?.toString().trim();
		if (!token) return null;

		cachedAdcToken = { token, expiresAt: Date.now() + ADC_TOKEN_TTL_MS };
		return token;
	} catch {
		return null;
	}
}

/** Reset the cached ADC token (for testing). */
export function resetAdcTokenCache(): void {
	cachedAdcToken = null;
}
