import { describe, expect, test } from "bun:test";
import { anthropicAdapter } from "../../src/providers/anthropic/adapter.ts";
import type { ProviderConfig, ProxyRequest } from "../../src/types/index.ts";

const testConfig: ProviderConfig = {
	enabled: true,
	apiKey: "sk-test-key",
};

const minimalRequest: ProxyRequest = {
	model: "claude-sonnet-4-20250514",
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 1024,
};

describe("anthropicAdapter.translate", () => {
	test("produces correct URL", () => {
		const { url } = anthropicAdapter.translate(minimalRequest, testConfig);
		expect(url).toBe("https://api.anthropic.com/v1/messages");
	});

	test("uses custom base URL", () => {
		const { url } = anthropicAdapter.translate(minimalRequest, {
			...testConfig,
			baseUrl: "https://custom.api.com",
		});
		expect(url).toBe("https://custom.api.com/v1/messages");
	});

	test("sets required headers", () => {
		const { headers } = anthropicAdapter.translate(minimalRequest, testConfig);
		expect(headers["x-api-key"]).toBe("sk-test-key");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(headers["content-type"]).toBe("application/json");
	});

	test("prefers client anthropic-version header over default", () => {
		const { headers } = anthropicAdapter.translate(minimalRequest, testConfig, {
			"anthropic-version": "2025-01-01",
		});
		expect(headers["anthropic-version"]).toBe("2025-01-01");
	});

	test("forwards client anthropic-beta header", () => {
		const { headers } = anthropicAdapter.translate(minimalRequest, testConfig, {
			"anthropic-beta": "prompt-caching-2024-07-31",
		});
		expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
	});

	test("omits anthropic-beta when client does not send it", () => {
		const { headers } = anthropicAdapter.translate(minimalRequest, testConfig, {});
		expect(headers["anthropic-beta"]).toBeUndefined();
	});

	test("body is valid JSON of request", () => {
		const { body } = anthropicAdapter.translate(minimalRequest, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.model).toBe("claude-sonnet-4-20250514");
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.max_tokens).toBe(1024);
	});
});

describe("anthropicAdapter.classifyError", () => {
	test("429 is throttled and retryable", () => {
		const err = anthropicAdapter.classifyError(429);
		expect(err.category).toBe("throttled");
		expect(err.retryable).toBe(true);
	});

	test("500 is retryable", () => {
		const err = anthropicAdapter.classifyError(500);
		expect(err.category).toBe("retryable");
		expect(err.retryable).toBe(true);
	});

	test("502 is retryable", () => {
		const err = anthropicAdapter.classifyError(502);
		expect(err.retryable).toBe(true);
	});

	test("503 is retryable", () => {
		const err = anthropicAdapter.classifyError(503);
		expect(err.retryable).toBe(true);
	});

	test("401 is auth and not retryable", () => {
		const err = anthropicAdapter.classifyError(401);
		expect(err.category).toBe("auth");
		expect(err.retryable).toBe(false);
	});

	test("403 is auth and not retryable", () => {
		const err = anthropicAdapter.classifyError(403);
		expect(err.category).toBe("auth");
		expect(err.retryable).toBe(false);
	});

	test("400 is fatal and not retryable", () => {
		const err = anthropicAdapter.classifyError(400);
		expect(err.category).toBe("fatal");
		expect(err.retryable).toBe(false);
	});

	test("extracts message from error body", () => {
		const body = JSON.stringify({
			error: { type: "invalid_request_error", message: "max_tokens required" },
		});
		const err = anthropicAdapter.classifyError(400, body);
		expect(err.message).toBe("max_tokens required");
	});
});
