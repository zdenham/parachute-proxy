import { describe, expect, test } from "bun:test";
import { bedrockAdapter } from "../../src/providers/bedrock/adapter.ts";
import type { ProxyRequest, ProviderConfig } from "../../src/types/index.ts";

const baseReq: ProxyRequest = {
	model: "anthropic.claude-sonnet-4-20250514-v1:0",
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 128,
};

const baseConfig: ProviderConfig = {
	enabled: true,
	apiKey: "AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
};

describe("bedrockAdapter", () => {
	test("name is bedrock", () => {
		expect(bedrockAdapter.name).toBe("bedrock");
	});

	describe("translate", () => {
		test("builds correct invoke URL for non-streaming", () => {
			const { url } = bedrockAdapter.translate(baseReq, baseConfig);
			expect(url).toBe(
				"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-20250514-v1:0/invoke",
			);
		});

		test("builds correct invoke-with-response-stream URL for streaming", () => {
			const streamReq = { ...baseReq, stream: true };
			const { url } = bedrockAdapter.translate(streamReq, baseConfig);
			expect(url).toContain("/invoke-with-response-stream");
		});

		test("includes SigV4 Authorization header when credentials provided", () => {
			const { headers } = bedrockAdapter.translate(baseReq, baseConfig);
			expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
			expect(headers.authorization).toContain("Credential=AKIAIOSFODNN7EXAMPLE");
		});

		test("includes x-amz-date header", () => {
			const { headers } = bedrockAdapter.translate(baseReq, baseConfig);
			expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
		});

		test("body includes anthropic_version and excludes model", () => {
			const { body } = bedrockAdapter.translate(baseReq, baseConfig);
			const parsed = JSON.parse(body);
			expect(parsed.anthropic_version).toBe("bedrock-2023-05-31");
			expect(parsed.model).toBeUndefined();
			expect(parsed.messages).toEqual(baseReq.messages);
			expect(parsed.max_tokens).toBe(128);
		});

		test("uses custom baseUrl when provided", () => {
			const config = { ...baseConfig, baseUrl: "https://custom.bedrock.test" };
			const { url } = bedrockAdapter.translate(baseReq, config);
			expect(url).toStartWith("https://custom.bedrock.test/");
		});

		test("works without credentials (no apiKey, no env, no profile)", () => {
			const saved = {
				accessKey: process.env.AWS_ACCESS_KEY_ID,
				secretKey: process.env.AWS_SECRET_ACCESS_KEY,
				credFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
				profile: process.env.AWS_PROFILE,
			};
			try {
				delete process.env.AWS_ACCESS_KEY_ID;
				delete process.env.AWS_SECRET_ACCESS_KEY;
				delete process.env.AWS_PROFILE;
				process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/path";

				const config: ProviderConfig = { enabled: true, region: "us-west-2" };
				const { url, headers } = bedrockAdapter.translate(baseReq, config);
				expect(url).toContain("us-west-2");
				// No Authorization header without credentials
				expect(headers.authorization).toBeUndefined();
			} finally {
				for (const [key, val] of Object.entries(saved)) {
					const envKey = key === "accessKey" ? "AWS_ACCESS_KEY_ID"
						: key === "secretKey" ? "AWS_SECRET_ACCESS_KEY"
						: key === "credFile" ? "AWS_SHARED_CREDENTIALS_FILE"
						: "AWS_PROFILE";
					if (val !== undefined) process.env[envKey] = val;
					else delete process.env[envKey];
				}
			}
		});
	});

	describe("classifyError", () => {
		test("429 is throttled and retryable", () => {
			const result = bedrockAdapter.classifyError(429);
			expect(result.category).toBe("throttled");
			expect(result.retryable).toBe(true);
		});

		test("403 is auth and not retryable", () => {
			const result = bedrockAdapter.classifyError(403);
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
		});

		test("500 is retryable", () => {
			const result = bedrockAdapter.classifyError(500);
			expect(result.category).toBe("retryable");
			expect(result.retryable).toBe(true);
		});

		test("parses error message from AWS-style body", () => {
			const body = JSON.stringify({ message: "Rate exceeded" });
			const result = bedrockAdapter.classifyError(429, body);
			expect(result.message).toBe("Rate exceeded");
		});
	});
});
