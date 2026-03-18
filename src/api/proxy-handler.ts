import retry from "async-retry";
import { anthropicAdapter } from "../providers/anthropic/adapter.ts";
import { logger } from "../telemetry/logger.ts";
import { getRequestId } from "../http/request-id.ts";
import { proxyRequestSchema } from "../http/validation.ts";
import type { Config, ErrorResponse, ProxyRequest } from "../types/index.ts";

export function createProxyHandler(config: Config) {
	return async (req: Request): Promise<Response> => {
		const reqId = getRequestId(req.headers);
		const logCtx = { reqId };

		// Parse body
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return jsonError(400, "invalid_request_error", "Invalid JSON body", reqId);
		}

		// Validate
		const parsed = proxyRequestSchema.safeParse(body);
		if (!parsed.success) {
			const msg = parsed.error.issues.map((i) => i.message).join("; ");
			return jsonError(400, "invalid_request_error", msg, reqId);
		}

		const proxyReq: ProxyRequest = parsed.data as ProxyRequest;
		const isStream = proxyReq.stream === true;

		logger.info("Proxy request", {
			...logCtx,
			model: proxyReq.model,
			stream: isStream,
		});

		// Check API key
		const providerConfig = config.providers.anthropic;
		if (!providerConfig.apiKey) {
			return jsonError(401, "authentication_error", "No API key configured for anthropic", reqId);
		}

		const { url, headers, body: upstreamBody } = anthropicAdapter.translate(proxyReq, providerConfig);

		// For streaming, we cannot retry once bytes are sent
		if (isStream) {
			return executeStreamingRequest(url, headers, upstreamBody, reqId, config);
		}

		// Non-streaming: retry on retryable errors
		return executeWithRetry(url, headers, upstreamBody, reqId, config);
	};
}

async function executeStreamingRequest(
	url: string,
	headers: Record<string, string>,
	body: string,
	reqId: string,
	config: Config,
): Promise<Response> {
	let lastError: Response | undefined;

	// Retry before streaming starts
	for (let attempt = 0; attempt <= config.retry.maxRetries; attempt++) {
		if (attempt > 0) {
			const delay = Math.min(
				config.retry.minTimeoutMs * 2 ** (attempt - 1),
				config.retry.maxTimeoutMs,
			);
			logger.info("Retrying streaming request", { reqId, attempt, delay });
			await new Promise((r) => setTimeout(r, delay));
		}

		const upstream = await fetch(url, { method: "POST", headers, body });

		if (upstream.ok && upstream.body) {
			logger.info("Streaming started", { reqId, status: upstream.status });

			return new Response(upstream.body, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
					"x-request-id": reqId,
				},
			});
		}

		const errorBody = await upstream.text();
		const classified = anthropicAdapter.classifyError(upstream.status, errorBody);

		if (!classified.retryable) {
			logger.warn("Non-retryable upstream error", {
				reqId,
				status: upstream.status,
				category: classified.category,
			});
			return new Response(errorBody, {
				status: upstream.status,
				headers: {
					"content-type": "application/json",
					"x-request-id": reqId,
				},
			});
		}

		logger.warn("Retryable upstream error", {
			reqId,
			status: upstream.status,
			attempt,
		});
		lastError = new Response(errorBody, {
			status: upstream.status,
			headers: {
				"content-type": "application/json",
				"x-request-id": reqId,
			},
		});
	}

	return lastError ?? jsonError(502, "api_error", "All retries exhausted", reqId);
}

async function executeWithRetry(
	url: string,
	headers: Record<string, string>,
	body: string,
	reqId: string,
	config: Config,
): Promise<Response> {
	try {
		const result = await retry(
			async (bail) => {
				const upstream = await fetch(url, {
					method: "POST",
					headers,
					body,
				});

				if (upstream.ok) {
					const responseBody = await upstream.text();
					return new Response(responseBody, {
						status: upstream.status,
						headers: {
							"content-type": "application/json",
							"x-request-id": reqId,
						},
					});
				}

				const errorBody = await upstream.text();
				const classified = anthropicAdapter.classifyError(upstream.status, errorBody);

				if (!classified.retryable) {
					const errResponse = new Response(errorBody, {
						status: upstream.status,
						headers: {
							"content-type": "application/json",
							"x-request-id": reqId,
						},
					});
					bail(Object.assign(new Error(classified.message), { response: errResponse }));
					// bail() throws, but TS doesn't know that
					return undefined as never;
				}

				throw Object.assign(new Error(classified.message), {
					status: upstream.status,
				});
			},
			{
				retries: config.retry.maxRetries,
				minTimeout: config.retry.minTimeoutMs,
				maxTimeout: config.retry.maxTimeoutMs,
				onRetry(err, attempt) {
					logger.warn("Retrying non-streaming request", {
						reqId,
						attempt,
						error: err.message,
					});
				},
			},
		);

		logger.info("Proxy response", { reqId, status: result.status });
		return result;
	} catch (err: unknown) {
		const error = err as { response?: Response; message?: string };
		if (error.response) {
			return error.response;
		}
		logger.error("All retries exhausted", { reqId, error: error.message });
		return jsonError(502, "api_error", error.message ?? "Upstream request failed", reqId);
	}
}

function jsonError(
	status: number,
	type: string,
	message: string,
	reqId: string,
): Response {
	const body: ErrorResponse = {
		type: "error",
		error: { type, message },
	};
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"x-request-id": reqId,
		},
	});
}
