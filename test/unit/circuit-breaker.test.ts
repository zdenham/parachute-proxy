import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../../src/router/circuit-breaker.ts";

describe("CircuitBreaker", () => {
	test("starts in closed state", () => {
		const cb = new CircuitBreaker("test");
		expect(cb.getState()).toBe("closed");
		expect(cb.allowRequest()).toBe(true);
	});

	test("stays closed below failure threshold", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 3 });
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.getState()).toBe("closed");
		expect(cb.allowRequest()).toBe(true);
	});

	test("opens after reaching failure threshold", () => {
		const cb = new CircuitBreaker("test", {
			failureThreshold: 3,
			failureWindowMs: 60_000,
		});
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.getState()).toBe("open");
		expect(cb.allowRequest()).toBe(false);
	});

	test("transitions to half-open after cooldown", () => {
		const cb = new CircuitBreaker("test", {
			failureThreshold: 1,
			cooldownMs: 10,
		});
		cb.recordFailure();
		expect(cb.getState()).toBe("open");

		// Wait for cooldown
		const start = Date.now();
		while (Date.now() - start < 15) {
			// spin
		}

		expect(cb.getState()).toBe("half-open");
		expect(cb.allowRequest()).toBe(true);
	});

	test("closes on success in half-open state", () => {
		const cb = new CircuitBreaker("test", {
			failureThreshold: 1,
			cooldownMs: 10,
		});
		cb.recordFailure();

		const start = Date.now();
		while (Date.now() - start < 15) {
			// spin
		}

		expect(cb.getState()).toBe("half-open");
		cb.recordSuccess();
		expect(cb.getState()).toBe("closed");
	});

	test("re-opens on failure in half-open state", () => {
		const cb = new CircuitBreaker("test", {
			failureThreshold: 1,
			cooldownMs: 10,
		});
		cb.recordFailure();

		const start = Date.now();
		while (Date.now() - start < 15) {
			// spin
		}

		expect(cb.getState()).toBe("half-open");
		cb.recordFailure();
		expect(cb.getState()).toBe("open");
		expect(cb.allowRequest()).toBe(false);
	});

	test("reset clears state", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 1 });
		cb.recordFailure();
		expect(cb.getState()).toBe("open");
		cb.reset();
		expect(cb.getState()).toBe("closed");
	});

	test("success in closed state is a no-op", () => {
		const cb = new CircuitBreaker("test");
		cb.recordSuccess();
		expect(cb.getState()).toBe("closed");
	});
});
