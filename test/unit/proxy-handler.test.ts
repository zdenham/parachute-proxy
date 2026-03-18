import { describe, expect, test, mock } from "bun:test";
import { createProxyHandler } from "../../src/api/proxy-handler.ts";
import { Router } from "../../src/router/selector.ts";
import type { Config, ProviderAdapter, ProviderConfig } from "../../src/types/index.ts";

function stubAdapter(name: string): ProviderAdapter {
	return {
		name,
		translate(req, config) {
			return {
				url: `http://stub-${name}/v1/messages`,
				headers: { "content-type": "application/json", "x-api-key": config.apiKey ?? "" },
				body: JSON.stringify(req),
			};
		},
		classifyError(status, body) {
			if (status === 429) return { status, category: "throttled", message: "throttled", retryable: true };
			if (status === 401) return { status, category: "auth", message: "auth error", retryable: false };
			if (status === 400) return { status, category: "fatal", message: "bad request", retryable: false };
			if (status >= 500) return { status, category: "retryable", message: "server error", retryable: true };
			return { status, category: "fatal", message: "unknown", retryable: false };
		},
	};
}

function testConfig(overrides?: Partial<Config>): Config {
	return {
		server: { host: "127.0.0.1", port: 0 },
		providers: {
			anthropic: { enabled: true, apiKey: "test-key" },
			vertex: { enabled: false },
			bedrock: { enabled: false },
		},
		routing: { providerOrder: ["anthropic"] },
		circuitBreaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 30_000 },
		retry: { maxRetries: 0, minTimeoutMs: 10, maxTimeoutMs: 50, requestTimeoutMs: 30_000 },
		...overrides,
	} as Config;
}

function validRequest(stream = false): Request {
	return new Request("http://localhost/proxy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "test" }],
			max_tokens: 10,
			stream,
		}),
	});
}

describe("proxy handler unit tests", () => {
	test("rejects invalid JSON body with 400", async () => {
		const config = testConfig();
		const router = new Router({ providerOrder: ["anthropic"], circuitBreaker: config.circuitBreaker });
		router.registerAdapter(stubAdapter("anthropic"));
		const handler = createProxyHandler(config, router);

		const req = new Request("http://localhost/proxy", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		const res = await handler(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain("Invalid JSON body");
	});

	test("rejects missing required fields with 400", async () => {
		const config = testConfig();
		const router = new Router({ providerOrder: ["anthropic"], circuitBreaker: config.circuitBreaker });
		router.registerAdapter(stubAdapter("anthropic"));
		const handler = createProxyHandler(config, router);

		const req = new Request("http://localhost/proxy", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "test" }),
		});
		const res = await handler(req);
		expect(res.status).toBe(400);
	});

	test("returns 503 when no healthy providers", async () => {
		const config = testConfig({ routing: { providerOrder: [] } });
		const router = new Router({ providerOrder: [], circuitBreaker: config.circuitBreaker });
		const handler = createProxyHandler(config, router);

		const res = await handler(validRequest());
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error.type).toBe("overloaded_error");
	});

	test("returns 503 when provider has no API key", async () => {
		const config = testConfig({
			providers: {
				anthropic: { enabled: true, apiKey: undefined } as unknown as ProviderConfig,
				vertex: { enabled: false },
				bedrock: { enabled: false },
			},
		});
		const router = new Router({ providerOrder: ["anthropic"], circuitBreaker: config.circuitBreaker });
		router.registerAdapter(stubAdapter("anthropic"));
		const handler = createProxyHandler(config, router);

		const res = await handler(validRequest());
		expect(res.status).toBe(503);
	});

	test("?provider= selects explicit provider, skipping router", async () => {
		const config = testConfig({
			routing: { providerOrder: ["anthropic", "vertex"] },
			providers: {
				anthropic: { enabled: true, apiKey: "anthropic-key" },
				vertex: { enabled: true, apiKey: "vertex-key" },
				bedrock: { enabled: false },
			},
		});
		const router = new Router({ providerOrder: ["anthropic", "vertex"], circuitBreaker: config.circuitBreaker });
		const vertexStub = stubAdapter("vertex");
		router.registerAdapter(stubAdapter("anthropic"));
		router.registerAdapter(vertexStub);
		const handler = createProxyHandler(config, router);

		// Mock fetch to return a successful response
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ type: "message", role: "assistant", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		try {
			const req = new Request("http://localhost/proxy?provider=vertex", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-20250514",
					messages: [{ role: "user", content: "test" }],
					max_tokens: 10,
				}),
			});
			const res = await handler(req);
			expect(res.status).toBe(200);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("?provider=unknown returns 400", async () => {
		const config = testConfig();
		const router = new Router({ providerOrder: ["anthropic"], circuitBreaker: config.circuitBreaker });
		router.registerAdapter(stubAdapter("anthropic"));
		const handler = createProxyHandler(config, router);

		const req = new Request("http://localhost/proxy?provider=unknown", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				messages: [{ role: "user", content: "test" }],
				max_tokens: 10,
			}),
		});
		const res = await handler(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain("Unknown provider");
		expect(body.error.message).toContain("unknown");
	});

	test("?provider= for adapter with no provider config returns 400", async () => {
		// Register an adapter in the router but don't add it to config.providers
		const config = testConfig({
			providers: {
				anthropic: { enabled: true, apiKey: "test-key" },
				vertex: { enabled: false },
				bedrock: { enabled: false },
			},
		});
		const router = new Router({ providerOrder: ["anthropic"], circuitBreaker: config.circuitBreaker });
		router.registerAdapter(stubAdapter("anthropic"));
		router.registerAdapter(stubAdapter("custom"));
		const handler = createProxyHandler(config, router);

		const req = new Request("http://localhost/proxy?provider=custom", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				messages: [{ role: "user", content: "test" }],
				max_tokens: 10,
			}),
		});
		const res = await handler(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain("not configured");
	});

	test("includes x-request-id in error responses", async () => {
		const config = testConfig();
		const router = new Router({ providerOrder: ["anthropic"], circuitBreaker: config.circuitBreaker });
		router.registerAdapter(stubAdapter("anthropic"));
		const handler = createProxyHandler(config, router);

		const req = new Request("http://localhost/proxy", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-request-id": "custom-id-123",
			},
			body: JSON.stringify({ model: "test" }),
		});
		const res = await handler(req);
		expect(res.headers.get("x-request-id")).toBe("custom-id-123");
	});
});
