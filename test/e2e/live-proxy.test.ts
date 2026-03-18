import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const LIVE = process.env.LIVE_TEST === "1";
const PORT = 13080; // Use non-default port for tests

describe.if(LIVE)("live e2e proxy", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		const bunPath = Bun.which("bun") ?? process.execPath;
		proc = Bun.spawn([bunPath, "run", "src/main.ts"], {
			env: {
				...process.env,
				PROXY_PORT: String(PORT),
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		// Wait for server to be ready
		const maxWait = 5000;
		const start = Date.now();
		while (Date.now() - start < maxWait) {
			try {
				const res = await fetch(`http://127.0.0.1:${PORT}/health`);
				if (res.ok) break;
			} catch {
				// server not ready yet
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	});

	afterAll(() => {
		proc?.kill();
	});

	test("GET /health returns 200", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	test("POST /proxy streaming returns SSE events", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/proxy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				messages: [{ role: "user", content: "Say exactly: hello world" }],
				max_tokens: 64,
				stream: true,
			}),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");

		const text = await res.text();
		expect(text).toContain("event: message_start");
		expect(text).toContain("event: content_block_start");
		expect(text).toContain("event: content_block_delta");
		expect(text).toContain("event: message_stop");
	}, 30_000);

	test("POST /proxy non-streaming returns JSON", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/proxy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				messages: [{ role: "user", content: "Say exactly: hello world" }],
				max_tokens: 64,
				stream: false,
			}),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");

		const body = await res.json();
		expect(body.type).toBe("message");
		expect(body.role).toBe("assistant");
		expect(body.content).toBeArray();
		expect(body.content.length).toBeGreaterThan(0);
		expect(body.usage).toBeDefined();
	}, 30_000);

	test("POST /proxy with invalid body returns 400", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/proxy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "test" }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});
});
