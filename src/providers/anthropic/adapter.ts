import type {
	ClassifiedError,
	ProviderAdapter,
	ProviderConfig,
	ProxyRequest,
} from "../../types/index.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export const anthropicAdapter: ProviderAdapter = {
	name: "anthropic",

	translate(req: ProxyRequest, config: ProviderConfig, clientHeaders: Record<string, string> = {}) {
		const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
		const url = `${baseUrl}/v1/messages`;

		const headers: Record<string, string> = {
			"content-type": "application/json",
			"x-api-key": config.apiKey ?? "",
			"anthropic-version": clientHeaders["anthropic-version"] ?? API_VERSION,
		};
		if (clientHeaders["anthropic-beta"]) {
			headers["anthropic-beta"] = clientHeaders["anthropic-beta"];
		}

		// Pass the request body through as-is — it already matches the Anthropic API shape
		const body = JSON.stringify(req);

		return { url, headers, body };
	},

	classifyError(status: number, body?: string): ClassifiedError {
		let message = `Upstream error: ${status}`;
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
				return {
					status,
					category: "throttled",
					message,
					retryable: true,
				};
			case status === 401 || status === 403:
				return { status, category: "auth", message, retryable: false };
			case status === 400:
				return { status, category: "fatal", message, retryable: false };
			case status >= 500:
				return {
					status,
					category: "retryable",
					message,
					retryable: true,
				};
			default:
				return { status, category: "fatal", message, retryable: false };
		}
	},
};
