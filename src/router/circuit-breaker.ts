import { logger } from "../telemetry/logger.ts";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
	/** Number of failures within the window to trip the breaker */
	failureThreshold: number;
	/** Time window in ms for counting failures */
	failureWindowMs: number;
	/** How long to stay open before probing */
	cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 5,
	failureWindowMs: 300_000,
	cooldownMs: 600_000,
};

export class CircuitBreaker {
	readonly provider: string;
	private state: CircuitState = "closed";
	private failures: number[] = [];
	private openedAt = 0;
	private config: CircuitBreakerConfig;

	constructor(provider: string, config?: Partial<CircuitBreakerConfig>) {
		this.provider = provider;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	getState(): CircuitState {
		if (this.state === "open") {
			// Check if cooldown has elapsed → transition to half-open
			if (Date.now() - this.openedAt >= this.config.cooldownMs) {
				this.state = "half-open";
				logger.info("Circuit breaker half-open", { provider: this.provider });
			}
		}
		return this.state;
	}

	/** Returns true if requests are allowed (closed or half-open) */
	allowRequest(): boolean {
		const state = this.getState();
		return state === "closed" || state === "half-open";
	}

	recordSuccess(): void {
		if (this.state === "half-open") {
			this.state = "closed";
			this.failures = [];
			logger.info("Circuit breaker closed (recovered)", {
				provider: this.provider,
			});
		}
	}

	recordFailure(): void {
		const now = Date.now();

		if (this.state === "half-open") {
			// Probe failed — re-open
			this.state = "open";
			this.openedAt = now;
			logger.warn("Circuit breaker re-opened (probe failed)", {
				provider: this.provider,
			});
			return;
		}

		// Prune old failures outside the window
		this.failures = this.failures.filter(
			(ts) => now - ts < this.config.failureWindowMs,
		);
		this.failures.push(now);

		if (this.failures.length >= this.config.failureThreshold) {
			this.state = "open";
			this.openedAt = now;
			this.failures = [];
			logger.warn("Circuit breaker opened", {
				provider: this.provider,
				failureCount: this.config.failureThreshold,
			});
		}
	}

	/** Force reset for testing */
	reset(): void {
		this.state = "closed";
		this.failures = [];
		this.openedAt = 0;
	}
}
