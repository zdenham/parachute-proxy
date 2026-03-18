import type { Router } from "../router/selector.ts";

export function createHealthHandler(router?: Router) {
	return (): Response => {
		if (!router) {
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		const providers = router.getHealthTracker().getAllHealth();
		const allHealthy = providers.length === 0 || providers.some((p) => p.healthy);
		const status = allHealthy ? "ok" : "degraded";

		return new Response(
			JSON.stringify({ status, providers }),
			{
				status: allHealthy ? 200 : 503,
				headers: { "content-type": "application/json" },
			},
		);
	};
}
