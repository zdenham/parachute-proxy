import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.ts";

export interface ProviderHealth {
	provider: string;
	healthy: boolean;
	circuitState: "closed" | "open" | "half-open";
	successCount: number;
	failureCount: number;
}

export class HealthTracker {
	private breakers = new Map<string, CircuitBreaker>();
	private successCounts = new Map<string, number>();
	private failureCounts = new Map<string, number>();
	private circuitConfig?: Partial<CircuitBreakerConfig>;

	constructor(circuitConfig?: Partial<CircuitBreakerConfig>) {
		this.circuitConfig = circuitConfig;
	}

	private getBreaker(provider: string): CircuitBreaker {
		let breaker = this.breakers.get(provider);
		if (!breaker) {
			breaker = new CircuitBreaker(provider, this.circuitConfig);
			this.breakers.set(provider, breaker);
		}
		return breaker;
	}

	isHealthy(provider: string): boolean {
		return this.getBreaker(provider).allowRequest();
	}

	recordSuccess(provider: string): void {
		this.getBreaker(provider).recordSuccess();
		this.successCounts.set(
			provider,
			(this.successCounts.get(provider) ?? 0) + 1,
		);
	}

	recordFailure(provider: string): void {
		this.getBreaker(provider).recordFailure();
		this.failureCounts.set(
			provider,
			(this.failureCounts.get(provider) ?? 0) + 1,
		);
	}

	getHealth(provider: string): ProviderHealth {
		const breaker = this.getBreaker(provider);
		return {
			provider,
			healthy: breaker.allowRequest(),
			circuitState: breaker.getState(),
			successCount: this.successCounts.get(provider) ?? 0,
			failureCount: this.failureCounts.get(provider) ?? 0,
		};
	}

	getAllHealth(): ProviderHealth[] {
		return Array.from(this.breakers.keys()).map((p) => this.getHealth(p));
	}
}
