import { describe, expect, test } from "bun:test";
import { Router } from "../../src/router/selector.ts";
import { HealthTracker } from "../../src/router/health.ts";
import type { ProviderAdapter, ClassifiedError } from "../../src/types/index.ts";

function makeAdapter(name: string): ProviderAdapter {
	return {
		name,
		translate(req, config) {
			return { url: `https://${name}.test/v1/messages`, headers: {}, body: "{}" };
		},
		classifyError(status) {
			return { status, category: "fatal", message: "test", retryable: false };
		},
	};
}

describe("Router", () => {
	test("selects first healthy provider", () => {
		const router = new Router({ providerOrder: ["a", "b"] });
		router.registerAdapter(makeAdapter("a"));
		router.registerAdapter(makeAdapter("b"));

		const selected = router.select();
		expect(selected).not.toBeNull();
		expect(selected!.name).toBe("a");
	});

	test("skips unregistered providers", () => {
		const router = new Router({ providerOrder: ["x", "b"] });
		router.registerAdapter(makeAdapter("b"));

		const selected = router.select();
		expect(selected!.name).toBe("b");
	});

	test("returns null when no healthy providers", () => {
		const router = new Router({
			providerOrder: ["a"],
			circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
		});
		router.registerAdapter(makeAdapter("a"));

		// Trip the breaker
		router.recordFailure("a");

		const selected = router.select();
		expect(selected).toBeNull();
	});

	test("selectNext returns next healthy provider", () => {
		const router = new Router({ providerOrder: ["a", "b", "c"] });
		router.registerAdapter(makeAdapter("a"));
		router.registerAdapter(makeAdapter("b"));
		router.registerAdapter(makeAdapter("c"));

		const next = router.selectNext("a");
		expect(next).not.toBeNull();
		expect(next!.name).toBe("b");
	});

	test("selectNext skips unhealthy providers", () => {
		const router = new Router({
			providerOrder: ["a", "b", "c"],
			circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
		});
		router.registerAdapter(makeAdapter("a"));
		router.registerAdapter(makeAdapter("b"));
		router.registerAdapter(makeAdapter("c"));

		router.recordFailure("b");

		const next = router.selectNext("a");
		expect(next!.name).toBe("c");
	});

	test("selectNext returns null when no more providers", () => {
		const router = new Router({ providerOrder: ["a", "b"] });
		router.registerAdapter(makeAdapter("a"));
		router.registerAdapter(makeAdapter("b"));

		const next = router.selectNext("b");
		expect(next).toBeNull();
	});
});

describe("HealthTracker", () => {
	test("new providers start healthy", () => {
		const tracker = new HealthTracker();
		expect(tracker.isHealthy("test")).toBe(true);
	});

	test("tracks success/failure counts", () => {
		const tracker = new HealthTracker();
		tracker.recordSuccess("p");
		tracker.recordSuccess("p");
		tracker.recordFailure("p");

		const health = tracker.getHealth("p");
		expect(health.successCount).toBe(2);
		expect(health.failureCount).toBe(1);
	});

	test("getAllHealth returns all tracked providers", () => {
		const tracker = new HealthTracker();
		tracker.recordSuccess("a");
		tracker.recordSuccess("b");

		const all = tracker.getAllHealth();
		expect(all).toHaveLength(2);
		expect(all.map((h) => h.provider).sort()).toEqual(["a", "b"]);
	});
});
