import { HealthTracker } from "./health.ts";
import { logger } from "../telemetry/logger.ts";
import type { ProviderAdapter } from "../types/index.ts";

export interface RoutingConfig {
	/** Ordered provider chain — first healthy provider wins */
	providerOrder: string[];
	circuitBreaker?: {
		failureThreshold?: number;
		failureWindowMs?: number;
		cooldownMs?: number;
	};
}

export interface SelectedProvider {
	name: string;
	adapter: ProviderAdapter;
}

export class Router {
	private adapters = new Map<string, ProviderAdapter>();
	private healthTracker: HealthTracker;
	private providerOrder: string[];

	constructor(config: RoutingConfig) {
		this.providerOrder = config.providerOrder;
		this.healthTracker = new HealthTracker(config.circuitBreaker);
	}

	registerAdapter(adapter: ProviderAdapter): void {
		this.adapters.set(adapter.name, adapter);
	}

	/**
	 * Select the first healthy provider from the ordered chain.
	 * Returns null if no healthy provider is available.
	 */
	select(): SelectedProvider | null {
		for (const name of this.providerOrder) {
			const adapter = this.adapters.get(name);
			if (!adapter) continue;

			if (this.healthTracker.isHealthy(name)) {
				logger.debug("Router selected provider", { provider: name });
				return { name, adapter };
			}

			logger.debug("Router skipping unhealthy provider", {
				provider: name,
			});
		}

		logger.warn("No healthy providers available");
		return null;
	}

	/**
	 * Select the next healthy provider after the given one (for failover).
	 */
	selectNext(afterProvider: string): SelectedProvider | null {
		const idx = this.providerOrder.indexOf(afterProvider);
		if (idx === -1) return null;

		for (let i = idx + 1; i < this.providerOrder.length; i++) {
			const name = this.providerOrder[i]!;
			const adapter = this.adapters.get(name);
			if (!adapter) continue;

			if (this.healthTracker.isHealthy(name)) {
				logger.info("Failing over to provider", {
					from: afterProvider,
					to: name,
				});
				return { name, adapter };
			}
		}

		return null;
	}

	recordSuccess(provider: string): void {
		this.healthTracker.recordSuccess(provider);
	}

	recordFailure(provider: string): void {
		this.healthTracker.recordFailure(provider);
	}

	getHealthTracker(): HealthTracker {
		return this.healthTracker;
	}
}
