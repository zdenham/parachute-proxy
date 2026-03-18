import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createProxyHandler } from "../../src/api/proxy-handler.ts";
import { Router } from "../../src/router/selector.ts";
import type { Config, ProviderAdapter, ProviderConfig } from "../../src/types/index.ts";

/**
 * Integration tests that use mock HTTP servers to verify retry,
 * failover, and circuit breaker behavior end-to-end.
 */

// --- Mock provider server helpers ---

interface MockServer {
	server: ReturnType<typeof Bun.serve>;
	port: number;
	url: string;
	/** Reset request log and handler */
	reset: (handler: MockHandler) => void;
	/** All requests received */
	requests: { method: string; path: string; body: string }[];
	stop: () => void;
}

type MockHandler = (req: Request) => Response | Promise<Response>;

function createMockServer(handler: MockHandler): MockServer {
	const requests: MockServer["requests"] = [];
	let currentHandler = handler;

	const server = Bun.serve({
		port: 0, // random available port
		hostname: "127.0.0.1",
		async fetch(req) {
			const body = await req.text();
			requests.push({
				method: req.method,
				path: new URL(req.url).pathname,
				body,
			});
			return currentHandler(req);
		},
	});

	return {
		server,
		port: server.port,
		url: `http://127.0.0.1:${server.port}`,
		requests,
		reset(h: MockHandler) {
			requests.length = 0;
			currentHandler = h;
		},
		stop() {
			server.stop(true);
		},
	};
}

function sseResponse(text: string): Response {
	const body = [
		`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
		`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
		`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`,
		`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
		`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
		`event: message_stop\ndata: {"type":"message_stop"}\n\n`,
	].join("");

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function jsonMessageResponse(text: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_test",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text }],
			model: "claude-sonnet-4-20250514",
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{
			status: 200,
			headers: { "content-type": "application/json" },
		},
	);
}

function errorResponse(status: number, message: string): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "api_error", message },
		}),
		{
			status,
			headers: { "content-type": "application/json" },
		},
	);
}

// --- Adapter factory that points at a mock server ---

function createMockAdapter(name: string, serverUrl: string): ProviderAdapter {
	return {
		name,
		translate(req, config) {
			return {
				url: `${serverUrl}/v1/messages`,
				headers: {
					"content-type": "application/json",
					"x-api-key": config.apiKey ?? "",
				},
				body: JSON.stringify(req),
			};
		},
		classifyError(status, body) {
			let message = `Upstream error: ${status}`;
			if (body) {
				try {
					const parsed = JSON.parse(body);
					message = parsed?.error?.message ?? message;
				} catch {
					// ignore
				}
			}
			if (status === 429) return { status, category: "throttled", message, retryable: true };
			if (status === 401 || status === 403) return { status, category: "auth", message, retryable: false };
			if (status === 400) return { status, category: "fatal", message, retryable: false };
			if (status >= 500) return { status, category: "retryable", message, retryable: true };
			return { status, category: "fatal", message, retryable: false };
		},
	};
}

function makeConfig(overrides: {
	providerOrder: string[];
	providers: Record<string, Partial<ProviderConfig>>;
	maxRetries?: number;
	circuitBreaker?: { failureThreshold?: number; cooldownMs?: number; failureWindowMs?: number };
}): Config {
	const providers: Record<string, ProviderConfig> = {};
	for (const [name, cfg] of Object.entries(overrides.providers)) {
		providers[name] = {
			enabled: true,
			apiKey: cfg.apiKey ?? "test-key",
			baseUrl: cfg.baseUrl,
			...cfg,
		} as ProviderConfig;
	}
	return {
		server: { host: "127.0.0.1", port: 0 },
		providers: { anthropic: providers.anthropic ?? { enabled: false }, vertex: providers.vertex ?? { enabled: false }, bedrock: providers.bedrock ?? { enabled: false }, ...providers },
		routing: { providerOrder: overrides.providerOrder },
		circuitBreaker: {
			failureThreshold: overrides.circuitBreaker?.failureThreshold ?? 2,
			failureWindowMs: overrides.circuitBreaker?.failureWindowMs ?? 60_000,
			cooldownMs: overrides.circuitBreaker?.cooldownMs ?? 30_000,
		},
		retry: {
			maxRetries: overrides.maxRetries ?? 1,
			minTimeoutMs: 10,
			maxTimeoutMs: 50,
			requestTimeoutMs: 30_000,
		},
	} as Config;
}

function makeRequest(stream: boolean): Request {
	return new Request("http://localhost/proxy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "Hello" }],
			max_tokens: 128,
			stream,
		}),
	});
}

// --- Tests ---

describe("failover integration tests", () => {
	let primary: MockServer;
	let fallback: MockServer;

	beforeAll(() => {
		primary = createMockServer(() => jsonMessageResponse("from primary"));
		fallback = createMockServer(() => jsonMessageResponse("from fallback"));
	});

	afterAll(() => {
		primary.stop();
		fallback.stop();
	});

	describe("non-streaming", () => {
		test("success on primary — no failover", async () => {
			primary.reset(() => jsonMessageResponse("primary ok"));
			fallback.reset(() => jsonMessageResponse("fallback ok"));

			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(false));
			const body = await res.json();

			expect(res.status).toBe(200);
			expect(body.content[0].text).toBe("primary ok");
			expect(primary.requests).toHaveLength(1);
			expect(fallback.requests).toHaveLength(0);
		});

		test("5xx on primary retries then fails over to fallback", async () => {
			primary.reset(() => errorResponse(503, "overloaded"));
			fallback.reset(() => jsonMessageResponse("fallback ok"));

			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
				maxRetries: 1,
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(false));
			const body = await res.json();

			expect(res.status).toBe(200);
			expect(body.content[0].text).toBe("fallback ok");
			// Primary should have been hit 1 (initial) + 1 (retry) = 2 times
			expect(primary.requests.length).toBeGreaterThanOrEqual(2);
			expect(fallback.requests).toHaveLength(1);
		});

		test("400 on primary does not retry or failover", async () => {
			primary.reset(() => errorResponse(400, "bad request"));
			fallback.reset(() => jsonMessageResponse("fallback ok"));

			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(false));

			expect(res.status).toBe(400);
			expect(primary.requests).toHaveLength(1);
			expect(fallback.requests).toHaveLength(0);
		});

		test("all providers down returns 502", async () => {
			primary.reset(() => errorResponse(503, "down"));
			fallback.reset(() => errorResponse(503, "also down"));

			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
				maxRetries: 0,
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(false));

			expect(res.status).toBe(502);
			expect(primary.requests).toHaveLength(1);
			expect(fallback.requests).toHaveLength(1);
		});
	});

	describe("streaming", () => {
		test("success on primary — streams back without failover", async () => {
			primary.reset(() => sseResponse("hello from primary"));
			fallback.reset(() => sseResponse("hello from fallback"));

			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(true));

			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/event-stream");

			const body = await res.text();
			expect(body).toContain("hello from primary");
			expect(fallback.requests).toHaveLength(0);
		});

		test("5xx on primary retries then fails over to fallback stream", async () => {
			primary.reset(() => errorResponse(502, "gateway error"));
			fallback.reset(() => sseResponse("fallback stream"));

			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
				maxRetries: 1,
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(true));

			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("fallback stream");
			expect(primary.requests.length).toBeGreaterThanOrEqual(2);
			expect(fallback.requests).toHaveLength(1);
		});
	});

	describe("circuit breaker integration", () => {
		test("repeated failures open circuit breaker, subsequent requests skip provider", async () => {
			let primaryCallCount = 0;
			primary.reset(() => {
				primaryCallCount++;
				return errorResponse(503, "overloaded");
			});
			fallback.reset(() => jsonMessageResponse("fallback ok"));

			// Low failure threshold to trip quickly
			const config = makeConfig({
				providerOrder: ["primary", "fallback"],
				providers: {
					primary: { apiKey: "k1", baseUrl: primary.url },
					fallback: { apiKey: "k2", baseUrl: fallback.url },
				},
				maxRetries: 0,
				circuitBreaker: { failureThreshold: 1, failureWindowMs: 60_000, cooldownMs: 60_000 },
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));
			router.registerAdapter(createMockAdapter("fallback", fallback.url));

			const handler = createProxyHandler(config, router);

			// First request: hits primary (fails), then falls over to fallback
			const res1 = await handler(makeRequest(false));
			expect(res1.status).toBe(200);
			const body1 = await res1.json();
			expect(body1.content[0].text).toBe("fallback ok");

			// Record primary call count after first request
			const primaryCallsAfterFirst = primaryCallCount;

			// Reset fallback requests for clarity
			fallback.reset(() => jsonMessageResponse("fallback ok again"));

			// Second request: primary circuit should be open, goes directly to fallback
			const res2 = await handler(makeRequest(false));
			expect(res2.status).toBe(200);
			const body2 = await res2.json();
			expect(body2.content[0].text).toBe("fallback ok again");

			// Primary should NOT have been called again (circuit is open)
			expect(primaryCallCount).toBe(primaryCallsAfterFirst);
		});
	});

	describe("no providers configured", () => {
		test("returns 503 when no providers have API keys", async () => {
			const config = makeConfig({
				providerOrder: ["primary"],
				providers: {
					primary: { apiKey: undefined as unknown as string },
				},
			});
			const router = new Router({ providerOrder: config.routing.providerOrder, circuitBreaker: config.circuitBreaker });
			router.registerAdapter(createMockAdapter("primary", primary.url));

			const handler = createProxyHandler(config, router);
			const res = await handler(makeRequest(false));

			// Should be 503 because no API key means it skips the provider
			expect(res.status).toBe(503);
		});
	});
});
