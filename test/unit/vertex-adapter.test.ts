import { describe, expect, test } from "bun:test";
import { vertexAdapter } from "../../src/providers/vertex/adapter.ts";
import type { ProxyRequest, ProviderConfig } from "../../src/types/index.ts";

const baseReq: ProxyRequest = {
	model: "claude-sonnet-4-20250514",
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 128,
};

const baseConfig: ProviderConfig = {
	enabled: true,
	apiKey: "test-token",
	region: "us-east5",
	projectId: "my-project",
};

describe("vertexAdapter", () => {
	test("name is vertex", () => {
		expect(vertexAdapter.name).toBe("vertex");
	});

	describe("translate", () => {
		test("builds correct rawPredict URL for non-streaming", () => {
			const { url } = vertexAdapter.translate(baseReq, baseConfig);
			expect(url).toBe(
				"https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-20250514:rawPredict",
			);
		});

		test("builds correct streamRawPredict URL for streaming", () => {
			const streamReq = { ...baseReq, stream: true };
			const { url } = vertexAdapter.translate(streamReq, baseConfig);
			expect(url).toContain(":streamRawPredict");
		});

		test("sets Authorization Bearer header", () => {
			const { headers } = vertexAdapter.translate(baseReq, baseConfig);
			expect(headers.authorization).toBe("Bearer test-token");
		});

		test("body includes anthropic_version and excludes model", () => {
			const { body } = vertexAdapter.translate(baseReq, baseConfig);
			const parsed = JSON.parse(body);
			expect(parsed.anthropic_version).toBe("vertex-2023-10-16");
			expect(parsed.model).toBeUndefined();
			expect(parsed.messages).toEqual(baseReq.messages);
			expect(parsed.max_tokens).toBe(128);
		});

		test("uses custom baseUrl when provided", () => {
			const config = { ...baseConfig, baseUrl: "https://custom.vertex.test" };
			const { url } = vertexAdapter.translate(baseReq, config);
			expect(url).toStartWith("https://custom.vertex.test/");
		});

		test("uses default region when not specified", () => {
			const config = { ...baseConfig, region: undefined };
			const { url } = vertexAdapter.translate(baseReq, config);
			expect(url).toContain("us-east5-aiplatform");
		});
	});

	describe("classifyError", () => {
		test("429 is throttled and retryable", () => {
			const result = vertexAdapter.classifyError(429);
			expect(result.category).toBe("throttled");
			expect(result.retryable).toBe(true);
		});

		test("401 is auth and not retryable", () => {
			const result = vertexAdapter.classifyError(401);
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
		});

		test("500 is retryable", () => {
			const result = vertexAdapter.classifyError(500);
			expect(result.category).toBe("retryable");
			expect(result.retryable).toBe(true);
		});

		test("400 is fatal", () => {
			const result = vertexAdapter.classifyError(400);
			expect(result.category).toBe("fatal");
			expect(result.retryable).toBe(false);
		});

		test("parses error message from body", () => {
			const body = JSON.stringify({ error: { message: "Quota exceeded" } });
			const result = vertexAdapter.classifyError(429, body);
			expect(result.message).toBe("Quota exceeded");
		});
	});
});
