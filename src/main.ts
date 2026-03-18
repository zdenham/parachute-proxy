import { loadConfig } from "./config/loader.ts";
import { createProxyHandler } from "./api/proxy-handler.ts";
import { createHealthHandler } from "./api/health-handler.ts";
import { logger } from "./telemetry/logger.ts";
import { Router } from "./router/selector.ts";
import { anthropicAdapter } from "./providers/anthropic/adapter.ts";
import { vertexAdapter } from "./providers/vertex/adapter.ts";
import { bedrockAdapter } from "./providers/bedrock/adapter.ts";

const config = loadConfig();

// Build the router with registered provider adapters
const router = new Router({
	providerOrder: config.routing.providerOrder,
	circuitBreaker: config.circuitBreaker,
});
router.registerAdapter(anthropicAdapter);
router.registerAdapter(vertexAdapter);
router.registerAdapter(bedrockAdapter);

const proxyHandler = createProxyHandler(config, router);
const healthHandler = createHealthHandler(router);

const server = Bun.serve({
	hostname: config.server.host,
	port: config.server.port,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "POST" && url.pathname === "/proxy") {
			return proxyHandler(req);
		}

		if (req.method === "GET" && url.pathname === "/health") {
			return healthHandler();
		}

		return new Response(JSON.stringify({ type: "error", error: { type: "not_found", message: "Not found" } }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	},
});

logger.info("Proxy listening", {
	host: config.server.host,
	port: config.server.port,
	url: `http://${server.hostname}:${server.port}`,
});

// Graceful shutdown
function shutdown(signal: string) {
	logger.info("Shutting down", { signal });
	server.stop(true); // close keep-alive connections
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
