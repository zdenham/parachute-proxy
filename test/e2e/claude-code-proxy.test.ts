import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const LIVE = process.env.LIVE_TEST === "1";
const PORT = 13081; // Unique port to avoid conflicts with other e2e tests

describe.if(LIVE)("Claude Code live proxy test", () => {
	let proxyProcess: Subprocess;

	beforeAll(async () => {
		const bunPath = Bun.which("bun") ?? process.execPath;
		proxyProcess = Bun.spawn([bunPath, "run", "src/main.ts"], {
			env: {
				...process.env,
				PROXY_PORT: String(PORT),
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		// Wait for proxy to be ready
		const maxWait = 10_000;
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
		proxyProcess?.kill();
	});

	test(
		"claude code works through the proxy end-to-end",
		async () => {
			// Verify claude CLI is available
			const claudePath = Bun.which("claude");
			if (!claudePath) {
				throw new Error(
					"claude CLI not found in PATH. Install it first: npm install -g @anthropic-ai/claude-code",
				);
			}

			const result = Bun.spawn(
				["claude", "-p", "Respond with exactly the text: PROXY_TEST_OK"],
				{
					env: {
						...process.env,
						ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const exitCode = await result.exited;
			const stdout = await new Response(result.stdout).text();
			const stderr = await new Response(result.stderr).text();

			if (exitCode !== 0) {
				console.error("claude stderr:", stderr);
			}

			expect(exitCode).toBe(0);
			expect(stdout).toContain("PROXY_TEST_OK");
		},
		120_000, // Claude Code can be slow to start
	);
});
