import { loadConfig } from "./config/loader.ts";
import { createProxyHandler } from "./api/proxy-handler.ts";
import { healthHandler } from "./api/health-handler.ts";
import { logger } from "./telemetry/logger.ts";

const config = loadConfig();
const proxyHandler = createProxyHandler(config);

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
