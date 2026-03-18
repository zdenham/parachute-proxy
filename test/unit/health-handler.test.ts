import { describe, expect, test } from "bun:test";
import { createHealthHandler } from "../../src/api/health-handler.ts";
import { Router } from "../../src/router/selector.ts";

describe("health handler", () => {
	test("returns ok with no router", async () => {
		const handler = createHealthHandler();
		const res = handler();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	test("returns ok with healthy providers", async () => {
		const router = new Router({
			providerOrder: ["anthropic"],
			circuitBreaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 30_000 },
		});
		router.registerAdapter({ name: "anthropic", translate: () => ({ url: "", headers: {}, body: "" }), classifyError: () => ({ status: 500, category: "retryable", message: "", retryable: true }) });
		router.recordSuccess("anthropic");

		const handler = createHealthHandler(router);
		const res = handler();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.providers).toBeArray();
		expect(body.providers[0].provider).toBe("anthropic");
		expect(body.providers[0].healthy).toBe(true);
		expect(body.providers[0].circuitState).toBe("closed");
	});

	test("returns degraded when all providers are unhealthy", async () => {
		const router = new Router({
			providerOrder: ["anthropic"],
			circuitBreaker: { failureThreshold: 1, failureWindowMs: 60_000, cooldownMs: 60_000 },
		});
		router.registerAdapter({ name: "anthropic", translate: () => ({ url: "", headers: {}, body: "" }), classifyError: () => ({ status: 500, category: "retryable", message: "", retryable: true }) });
		router.recordFailure("anthropic"); // trips circuit breaker

		const handler = createHealthHandler(router);
		const res = handler();
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.status).toBe("degraded");
		expect(body.providers[0].healthy).toBe(false);
		expect(body.providers[0].circuitState).toBe("open");
	});
});
