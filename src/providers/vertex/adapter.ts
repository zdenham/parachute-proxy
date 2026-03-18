import type {
	ClassifiedError,
	ProviderAdapter,
	ProviderConfig,
	ProxyRequest,
} from "../../types/index.ts";

const ANTHROPIC_VERSION = "vertex-2023-10-16";

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

		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${config.apiKey ?? ""}`,
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
