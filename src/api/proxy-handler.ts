import retry from "async-retry";
import { logger } from "../telemetry/logger.ts";
import { getRequestId } from "../http/request-id.ts";
import { proxyRequestSchema } from "../http/validation.ts";
import type { Config, ErrorResponse, ProviderAdapter, ProviderConfig, ProxyRequest } from "../types/index.ts";
import { Router } from "../router/selector.ts";

export function createProxyHandler(config: Config, router: Router) {
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

		// Forward Anthropic-specific client headers to upstream providers
		const clientHeaders: Record<string, string> = {};
		for (const key of ["anthropic-version", "anthropic-beta"]) {
			const val = req.headers.get(key);
			if (val) clientHeaders[key] = val;
		}

		// Check for explicit provider override via query parameter
		const url = new URL(req.url);
		const providerOverride = url.searchParams.get("provider");

		logger.info("Proxy request", {
			...logCtx,
			model: proxyReq.model,
			stream: isStream,
			...(providerOverride && { providerOverride }),
		});

		if (providerOverride) {
			// Explicit provider — skip routing, no failover
			const explicit = router.getAdapter(providerOverride);
			if (!explicit) {
				const registered = router.getRegisteredNames();
				return jsonError(
					400,
					"invalid_request_error",
					`Unknown provider "${providerOverride}". Available: ${registered.join(", ")}`,
					reqId,
				);
			}

			const providerConfig = getProviderConfig(config, explicit.name);
			if (!providerConfig) {
				return jsonError(
					400,
					"invalid_request_error",
					`Provider "${providerOverride}" is not configured`,
					reqId,
				);
			}

			const { url: upstreamUrl, headers: upstreamHeaders, body: upstreamBody } = explicit.adapter.translate(
				proxyReq,
				providerConfig,
				clientHeaders,
			);

			logger.info("Forwarding to explicit provider", { reqId, provider: explicit.name });

			const result = isStream
				? await executeStreamingRequest(
						upstreamUrl,
						upstreamHeaders,
						upstreamBody,
						reqId,
						config,
						explicit.adapter,
						explicit.name,
						router,
						proxyReq.model,
					)
				: await executeWithRetry(
						upstreamUrl,
						upstreamHeaders,
						upstreamBody,
						reqId,
						config,
						explicit.adapter,
						explicit.name,
						router,
						proxyReq.model,
					);

			return result.response;
		}

		// Select provider via router
		const selected = router.select();
		if (!selected) {
			return jsonError(503, "overloaded_error", "No healthy providers available", reqId);
		}

		// Try the selected provider, then failover if needed
		let currentProvider = selected;
		while (currentProvider) {
			const providerConfig = getProviderConfig(config, currentProvider.name);
			if (!providerConfig?.apiKey) {
				logger.warn("No API key for provider, trying next", {
					reqId,
					provider: currentProvider.name,
				});
				currentProvider = router.selectNext(currentProvider.name) ?? null;
				continue;
			}

			const { url, headers, body: upstreamBody } = currentProvider.adapter.translate(
				proxyReq,
				providerConfig,
				clientHeaders,
			);

			logger.info("Forwarding to provider", {
				reqId,
				provider: currentProvider.name,
			});

			const result = isStream
				? await executeStreamingRequest(
						url,
						headers,
						upstreamBody,
						reqId,
						config,
						currentProvider.adapter,
						currentProvider.name,
						router,
						proxyReq.model,
					)
				: await executeWithRetry(
						url,
						headers,
						upstreamBody,
						reqId,
						config,
						currentProvider.adapter,
						currentProvider.name,
						router,
						proxyReq.model,
					);

			if (result.failover) {
				// Try next provider
				const next = router.selectNext(currentProvider.name);
				if (next) {
					logger.info("Failing over", {
						reqId,
						from: currentProvider.name,
						to: next.name,
					});
					currentProvider = next;
					continue;
				}
				// No more providers — return the last error
				return result.response;
			}

			return result.response;
		}

		return jsonError(503, "overloaded_error", "All providers exhausted", reqId);
	};
}

interface ExecuteResult {
	response: Response;
	failover: boolean;
}

async function executeStreamingRequest(
	url: string,
	headers: Record<string, string>,
	body: string,
	reqId: string,
	config: Config,
	adapter: ProviderAdapter,
	providerName: string,
	router: Router,
	requestModel: string,
): Promise<ExecuteResult> {
	for (let attempt = 0; attempt <= config.retry.maxRetries; attempt++) {
		if (attempt > 0) {
			const delay = Math.min(
				config.retry.minTimeoutMs * 2 ** (attempt - 1),
				config.retry.maxTimeoutMs,
			);
			logger.info("Retrying streaming request", { reqId, attempt, delay, provider: providerName });
			await new Promise((r) => setTimeout(r, delay));
		}

		let upstream: Response;
		try {
			logger.debug("Upstream request", { reqId, url, provider: providerName, body: body.slice(0, 2000) });
			upstream = await fetch(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(config.retry.requestTimeoutMs),
			});
		} catch (err) {
			const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
			logger.warn("Upstream request failed", {
				reqId,
				attempt,
				provider: providerName,
				reason: isTimeout ? "timeout" : "network",
			});
			continue; // retry
		}

		if (upstream.ok && upstream.body) {
			logger.info("Streaming started", { reqId, status: upstream.status, provider: providerName });
			// Record success for the initial connection, but monitor for mid-stream failures
			router.recordSuccess(providerName);

			const translatedBody = adapter.translateStream
				? adapter.translateStream(upstream.body, requestModel)
				: upstream.body;

			const monitoredBody = createMonitoredStream(
				translatedBody,
				reqId,
				providerName,
				router,
			);

			return {
				response: new Response(monitoredBody, {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
						"x-request-id": reqId,
					},
				}),
				failover: false,
			};
		}

		const errorBody = await upstream.text();
		const classified = adapter.classifyError(upstream.status, errorBody);

		if (!classified.retryable) {
			// Non-retryable errors like auth/validation — don't failover
			logger.warn("Non-retryable upstream error", {
				reqId,
				status: upstream.status,
				category: classified.category,
				provider: providerName,
				errorBody,
			});

			if (classified.category === "auth") {
				// Auth errors might be provider-specific — try failover
				router.recordFailure(providerName);
				return {
					response: new Response(errorBody, {
						status: upstream.status,
						headers: { "content-type": "application/json", "x-request-id": reqId },
					}),
					failover: true,
				};
			}

			return {
				response: new Response(errorBody, {
					status: upstream.status,
					headers: { "content-type": "application/json", "x-request-id": reqId },
				}),
				failover: false,
			};
		}

		logger.warn("Retryable upstream error", {
			reqId,
			status: upstream.status,
			attempt,
			provider: providerName,
		});
	}

	// All retries exhausted — trigger failover
	router.recordFailure(providerName);
	return {
		response: jsonError(502, "api_error", "All retries exhausted", reqId),
		failover: true,
	};
}

async function executeWithRetry(
	url: string,
	headers: Record<string, string>,
	body: string,
	reqId: string,
	config: Config,
	adapter: ProviderAdapter,
	providerName: string,
	router: Router,
	requestModel: string,
): Promise<ExecuteResult> {
	try {
		const result = await retry(
			async (bail) => {
				const upstream = await fetch(url, {
					method: "POST",
					headers,
					body,
					signal: AbortSignal.timeout(config.retry.requestTimeoutMs),
				});

				if (upstream.ok) {
					const responseBody = await upstream.text();
					const translatedBody = adapter.translateResponse
						? adapter.translateResponse(responseBody, requestModel)
						: responseBody;
					router.recordSuccess(providerName);
					return new Response(translatedBody, {
						status: upstream.status,
						headers: {
							"content-type": "application/json",
							"x-request-id": reqId,
						},
					});
				}

				const errorBody = await upstream.text();
				const classified = adapter.classifyError(upstream.status, errorBody);

				if (!classified.retryable) {
					const errResponse = new Response(errorBody, {
						status: upstream.status,
						headers: {
							"content-type": "application/json",
							"x-request-id": reqId,
						},
					});
					bail(Object.assign(new Error(classified.message), { response: errResponse, classified }));
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
						provider: providerName,
					});
				},
			},
		);

		logger.info("Proxy response", { reqId, status: result.status, provider: providerName });
		return { response: result, failover: false };
	} catch (err: unknown) {
		const error = err as { response?: Response; classified?: { category: string }; message?: string };

		if (error.response) {
			// Non-retryable error — check if auth (failover-eligible)
			if (error.classified?.category === "auth") {
				router.recordFailure(providerName);
				return { response: error.response, failover: true };
			}
			return { response: error.response, failover: false };
		}

		// Retries exhausted — trigger failover
		logger.error("All retries exhausted", { reqId, error: error.message, provider: providerName });
		router.recordFailure(providerName);
		return {
			response: jsonError(502, "api_error", error.message ?? "Upstream request failed", reqId),
			failover: true,
		};
	}
}

function getProviderConfig(config: Config, name: string): ProviderConfig | undefined {
	const providers = config.providers as Record<string, ProviderConfig | undefined>;
	return providers[name];
}

/**
 * Wraps a readable stream to detect mid-stream failures.
 * If the upstream disconnects or errors after bytes have been sent,
 * records a failure in the health tracker so the circuit breaker
 * can account for it in future routing decisions.
 */
function createMonitoredStream(
	upstream: ReadableStream<Uint8Array>,
	reqId: string,
	providerName: string,
	router: Router,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sawErrorEvent = false;

	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					logger.info("Stream completed", { reqId, provider: providerName });
					controller.close();
					return;
				}

				// Scan for SSE error events
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("event: error")) {
						sawErrorEvent = true;
					} else if (sawErrorEvent && line.startsWith("data: ")) {
						if (classifySSEError(line.slice(6))) {
							logger.warn("Mid-stream SSE error event detected", {
								reqId,
								provider: providerName,
								data: line.slice(6),
							});
							router.recordFailure(providerName);
						}
						sawErrorEvent = false;
					} else if (line === "") {
						sawErrorEvent = false;
					}
				}

				controller.enqueue(value);
			} catch (err) {
				logger.warn("Mid-stream failure detected", {
					reqId,
					provider: providerName,
					error: String(err),
				});
				router.recordFailure(providerName);
				controller.error(err);
			}
		},
		cancel() {
			reader.cancel();
		},
	});
}

/**
 * Returns true if this SSE error data indicates a provider health issue
 * (and should count toward the circuit breaker), false if it's a client error.
 */
function classifySSEError(data: string): boolean {
	try {
		const parsed = JSON.parse(data);
		const errorType = parsed?.error?.type;
		return errorType !== "invalid_request_error";
	} catch {
		return true;
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
