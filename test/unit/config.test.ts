import { describe, expect, test } from "bun:test";
import { configSchema } from "../../src/config/schema.ts";

describe("configSchema", () => {
	test("accepts empty object with defaults", () => {
		const result = configSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.server.host).toBe("127.0.0.1");
			expect(result.data.server.port).toBe(3080);
			expect(result.data.retry.maxRetries).toBe(2);
		}
	});

	test("accepts full config", () => {
		const result = configSchema.safeParse({
			server: { host: "0.0.0.0", port: 8080 },
			providers: {
				anthropic: {
					enabled: true,
					apiKey: "sk-test",
					baseUrl: "https://api.anthropic.com",
				},
			},
			retry: { maxRetries: 3, minTimeoutMs: 100, maxTimeoutMs: 3000 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.server.port).toBe(8080);
			expect(result.data.providers.anthropic.apiKey).toBe("sk-test");
		}
	});

	test("rejects invalid port", () => {
		const result = configSchema.safeParse({
			server: { port: 99999 },
		});
		expect(result.success).toBe(false);
	});

	test("rejects invalid base URL", () => {
		const result = configSchema.safeParse({
			providers: { anthropic: { baseUrl: "not-a-url" } },
		});
		expect(result.success).toBe(false);
	});
});
