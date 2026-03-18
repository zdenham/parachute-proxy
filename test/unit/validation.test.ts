import { describe, expect, test } from "bun:test";
import { proxyRequestSchema } from "../../src/http/validation.ts";

describe("proxyRequestSchema", () => {
	test("accepts minimal valid request", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "Hello" }],
			max_tokens: 1024,
		});
		expect(result.success).toBe(true);
	});

	test("accepts streaming request with all fields", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "Hello" }],
			max_tokens: 1024,
			stream: true,
			system: "You are helpful",
			temperature: 0.7,
			top_p: 0.9,
			top_k: 40,
			stop_sequences: ["\n\nHuman:"],
			metadata: { user_id: "u1" },
		});
		expect(result.success).toBe(true);
	});

	test("accepts array content blocks", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			max_tokens: 1024,
		});
		expect(result.success).toBe(true);
	});

	test("rejects missing model", () => {
		const result = proxyRequestSchema.safeParse({
			messages: [{ role: "user", content: "Hello" }],
			max_tokens: 1024,
		});
		expect(result.success).toBe(false);
	});

	test("rejects missing messages", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			max_tokens: 1024,
		});
		expect(result.success).toBe(false);
	});

	test("rejects missing max_tokens", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "Hello" }],
		});
		expect(result.success).toBe(false);
	});

	test("rejects empty messages array", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			messages: [],
			max_tokens: 1024,
		});
		expect(result.success).toBe(false);
	});

	test("rejects negative max_tokens", () => {
		const result = proxyRequestSchema.safeParse({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "Hello" }],
			max_tokens: -1,
		});
		expect(result.success).toBe(false);
	});
});
