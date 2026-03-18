import { describe, expect, test } from "bun:test";
import {
	openaiAdapter,
	translateMessages,
	translateTools,
	translateToolChoice,
	translateOpenAIResponse,
	createStreamTranslator,
} from "../../src/providers/openai/adapter.ts";
import type { ProviderConfig, ProxyRequest, Message, Tool, ToolChoice, ContentBlock } from "../../src/types/index.ts";

const testConfig: ProviderConfig = {
	enabled: true,
	apiKey: "sk-test-openai-key",
};

const minimalRequest: ProxyRequest = {
	model: "claude-sonnet-4-20250514",
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 1024,
};

// --- Helpers ---

function mockStream(data: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(data));
			controller.close();
		},
	});
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let result = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
	}
	return result;
}

function parseSSEEvents(raw: string): { event: string; data: unknown }[] {
	const events: { event: string; data: unknown }[] = [];
	const blocks = raw.split("\n\n").filter(Boolean);
	for (const block of blocks) {
		const lines = block.split("\n");
		let event = "";
		let data = "";
		for (const line of lines) {
			if (line.startsWith("event: ")) event = line.slice(7);
			if (line.startsWith("data: ")) data = line.slice(6);
		}
		if (event && data) {
			events.push({ event, data: JSON.parse(data) });
		}
	}
	return events;
}

// --- Request Translation ---

describe("openaiAdapter.translate", () => {
	test("produces correct URL", () => {
		const { url } = openaiAdapter.translate(minimalRequest, testConfig);
		expect(url).toBe("https://api.openai.com/v1/chat/completions");
	});

	test("uses custom base URL", () => {
		const { url } = openaiAdapter.translate(minimalRequest, {
			...testConfig,
			baseUrl: "https://custom.openai.com",
		});
		expect(url).toBe("https://custom.openai.com/v1/chat/completions");
	});

	test("sets authorization header", () => {
		const { headers } = openaiAdapter.translate(minimalRequest, testConfig);
		expect(headers.authorization).toBe("Bearer sk-test-openai-key");
		expect(headers["content-type"]).toBe("application/json");
	});

	test("maps model via modelMap", () => {
		const config: ProviderConfig = {
			...testConfig,
			modelMap: { "claude-sonnet-4-20250514": "gpt-4.1" },
		};
		const { body } = openaiAdapter.translate(minimalRequest, config);
		const parsed = JSON.parse(body);
		expect(parsed.model).toBe("gpt-4.1");
	});

	test("passes model through when no modelMap", () => {
		const { body } = openaiAdapter.translate(minimalRequest, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.model).toBe("claude-sonnet-4-20250514");
	});

	test("maps max_tokens to max_completion_tokens", () => {
		const { body } = openaiAdapter.translate(minimalRequest, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.max_completion_tokens).toBe(1024);
		expect(parsed.max_tokens).toBeUndefined();
	});

	test("maps stop_sequences to stop", () => {
		const req: ProxyRequest = { ...minimalRequest, stop_sequences: ["END", "STOP"] };
		const { body } = openaiAdapter.translate(req, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.stop).toEqual(["END", "STOP"]);
	});

	test("passes through temperature and top_p", () => {
		const req: ProxyRequest = { ...minimalRequest, temperature: 0.7, top_p: 0.9 };
		const { body } = openaiAdapter.translate(req, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.temperature).toBe(0.7);
		expect(parsed.top_p).toBe(0.9);
	});

	test("drops top_k silently", () => {
		const req: ProxyRequest = { ...minimalRequest, top_k: 40 };
		const { body } = openaiAdapter.translate(req, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.top_k).toBeUndefined();
	});

	test("adds stream_options when streaming", () => {
		const req: ProxyRequest = { ...minimalRequest, stream: true };
		const { body } = openaiAdapter.translate(req, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.stream).toBe(true);
		expect(parsed.stream_options).toEqual({ include_usage: true });
	});

	test("does not set stream when not streaming", () => {
		const { body } = openaiAdapter.translate(minimalRequest, testConfig);
		const parsed = JSON.parse(body);
		expect(parsed.stream).toBeUndefined();
		expect(parsed.stream_options).toBeUndefined();
	});
});

describe("translateMessages", () => {
	test("simple text message", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		const result = translateMessages(messages);
		expect(result).toEqual([{ role: "user", content: "Hello" }]);
	});

	test("system prompt as string", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		const result = translateMessages(messages, "You are helpful");
		expect(result[0]).toEqual({ role: "system", content: "You are helpful" });
		expect(result[1]).toEqual({ role: "user", content: "Hello" });
	});

	test("system prompt as content blocks", () => {
		const system: ContentBlock[] = [
			{ type: "text", text: "Line 1" },
			{ type: "text", text: "Line 2" },
		];
		const result = translateMessages([], system);
		expect(result[0]).toEqual({ role: "system", content: "Line 1\nLine 2" });
	});

	test("assistant message with tool_use blocks", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me look that up." },
					{
						type: "tool_use",
						id: "call_1",
						name: "search",
						input: { q: "test" },
					},
				],
			},
		];
		const result = translateMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("assistant");
		expect(result[0].content).toBe("Let me look that up.");
		expect(result[0].tool_calls).toHaveLength(1);
		expect(result[0].tool_calls![0]).toEqual({
			id: "call_1",
			type: "function",
			function: { name: "search", arguments: '{"q":"test"}' },
		});
	});

	test("user message with tool_result blocks", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: "search result here",
					},
				],
			},
		];
		const result = translateMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: "search result here",
		});
	});

	test("user message with mixed content and tool_result", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Here are the results:" },
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: "result",
					},
				],
			},
		];
		const result = translateMessages(messages);
		// tool_result becomes a tool message, text becomes a user message
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: "result",
		});
		expect(result[1]).toEqual({
			role: "user",
			content: "Here are the results:",
		});
	});

	test("image block with base64", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "iVBOR...",
						},
					},
				],
			},
		];
		const result = translateMessages(messages);
		expect(result[0].content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,iVBOR..." },
			},
		]);
	});

	test("image block with URL", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "url",
							url: "https://example.com/image.png",
						},
					},
				],
			},
		];
		const result = translateMessages(messages);
		expect(result[0].content).toEqual([
			{
				type: "image_url",
				image_url: { url: "https://example.com/image.png" },
			},
		]);
	});

	test("assistant message with only tool_use (no text)", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "search",
						input: { q: "test" },
					},
				],
			},
		];
		const result = translateMessages(messages);
		expect(result[0].content).toBeNull();
		expect(result[0].tool_calls).toHaveLength(1);
	});
});

describe("translateTools", () => {
	test("maps Anthropic tool schema to OpenAI function format", () => {
		const tools: Tool[] = [
			{
				name: "search",
				description: "Search the web",
				input_schema: {
					type: "object",
					properties: { q: { type: "string" } },
					required: ["q"],
				},
			},
		];
		const result = translateTools(tools);
		expect(result).toEqual([
			{
				type: "function",
				function: {
					name: "search",
					description: "Search the web",
					parameters: {
						type: "object",
						properties: { q: { type: "string" } },
						required: ["q"],
					},
				},
			},
		]);
	});

	test("omits description when not provided", () => {
		const tools: Tool[] = [
			{
				name: "search",
				input_schema: { type: "object", properties: {} },
			},
		];
		const result = translateTools(tools);
		expect(result[0].function.description).toBeUndefined();
	});
});

describe("translateToolChoice", () => {
	test("auto → 'auto'", () => {
		expect(translateToolChoice({ type: "auto" })).toBe("auto");
	});

	test("any → 'required'", () => {
		expect(translateToolChoice({ type: "any" })).toBe("required");
	});

	test("specific tool → function object", () => {
		expect(translateToolChoice({ type: "tool", name: "search" })).toEqual({
			type: "function",
			function: { name: "search" },
		});
	});
});

// --- Response Translation ---

describe("translateOpenAIResponse", () => {
	test("maps basic text response", () => {
		const openai = {
			id: "chatcmpl-123",
			choices: [
				{
					message: { role: "assistant", content: "Hello world" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		};
		const result = translateOpenAIResponse(openai, "claude-sonnet-4-20250514");
		expect(result.id).toBe("chatcmpl-123");
		expect(result.type).toBe("message");
		expect(result.role).toBe("assistant");
		expect(result.model).toBe("claude-sonnet-4-20250514");
		expect(result.stop_reason).toBe("end_turn");
		expect(result.stop_sequence).toBeNull();
		expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
	});

	test("maps tool call response", () => {
		const openai = {
			id: "chatcmpl-456",
			choices: [
				{
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: {
									name: "search",
									arguments: '{"q":"test"}',
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 20, completion_tokens: 15 },
		};
		const result = translateOpenAIResponse(openai, "claude-sonnet-4-20250514");
		expect(result.stop_reason).toBe("tool_use");
		expect(result.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "search",
				input: { q: "test" },
			},
		]);
	});

	test("maps mixed text + tool_calls response", () => {
		const openai = {
			id: "chatcmpl-789",
			choices: [
				{
					message: {
						role: "assistant",
						content: "Let me search.",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "search", arguments: '{"q":"test"}' },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 10 },
		};
		const result = translateOpenAIResponse(openai, "claude-sonnet-4-20250514");
		const content = result.content as ContentBlock[];
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({ type: "text", text: "Let me search." });
		expect(content[1].type).toBe("tool_use");
	});

	test("maps stop_reason: length → max_tokens", () => {
		const openai = {
			id: "chatcmpl-123",
			choices: [{ message: { content: "..." }, finish_reason: "length" }],
			usage: { prompt_tokens: 10, completion_tokens: 100 },
		};
		const result = translateOpenAIResponse(openai, "claude-sonnet-4-20250514");
		expect(result.stop_reason).toBe("max_tokens");
	});

	test("handles invalid tool call arguments gracefully", () => {
		const openai = {
			id: "chatcmpl-123",
			choices: [
				{
					message: {
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "search", arguments: "not json" },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		};
		const result = translateOpenAIResponse(openai, "claude-sonnet-4-20250514");
		const content = result.content as ContentBlock[];
		expect(content[0].input).toEqual({});
	});
});

// --- Streaming Translation ---

describe("createStreamTranslator", () => {
	test("translates text-only stream", async () => {
		const openaiSSE = [
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
			'data: {"id":"chatcmpl-123","usage":{"prompt_tokens":10,"completion_tokens":5}}',
			"data: [DONE]",
		].join("\n\n");

		const stream = createStreamTranslator(
			mockStream(openaiSSE),
			"claude-sonnet-4-20250514",
		);
		const output = await readStream(stream);
		const events = parseSSEEvents(output);

		// message_start
		expect(events[0].event).toBe("message_start");
		const msgStart = events[0].data as Record<string, unknown>;
		expect((msgStart.message as Record<string, unknown>).model).toBe("claude-sonnet-4-20250514");

		// content_block_start (text)
		expect(events[1].event).toBe("content_block_start");
		const blockStart = events[1].data as Record<string, unknown>;
		expect((blockStart.content_block as Record<string, unknown>).type).toBe("text");

		// content_block_delta (Hello)
		expect(events[2].event).toBe("content_block_delta");
		const delta1 = events[2].data as Record<string, unknown>;
		expect((delta1.delta as Record<string, string>).text).toBe("Hello");

		// content_block_delta ( world)
		expect(events[3].event).toBe("content_block_delta");
		const delta2 = events[3].data as Record<string, unknown>;
		expect((delta2.delta as Record<string, string>).text).toBe(" world");

		// content_block_stop
		expect(events[4].event).toBe("content_block_stop");

		// message_delta
		expect(events[5].event).toBe("message_delta");
		const msgDelta = events[5].data as Record<string, unknown>;
		expect((msgDelta.delta as Record<string, string>).stop_reason).toBe("end_turn");
		expect((msgDelta.usage as Record<string, number>).output_tokens).toBe(5);

		// message_stop
		expect(events[6].event).toBe("message_stop");
	});

	test("translates tool call stream", async () => {
		const openaiSSE = [
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test\\"}"}}]},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
			'data: {"id":"chatcmpl-123","usage":{"prompt_tokens":10,"completion_tokens":15}}',
			"data: [DONE]",
		].join("\n\n");

		const stream = createStreamTranslator(
			mockStream(openaiSSE),
			"claude-sonnet-4-20250514",
		);
		const output = await readStream(stream);
		const events = parseSSEEvents(output);

		// message_start
		expect(events[0].event).toBe("message_start");

		// content_block_start (tool_use)
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				(e.data as Record<string, unknown>).content_block &&
				((e.data as Record<string, unknown>).content_block as Record<string, unknown>).type === "tool_use",
		);
		expect(toolStart).toBeDefined();
		const toolBlock = (toolStart!.data as Record<string, unknown>).content_block as Record<string, unknown>;
		expect(toolBlock.id).toBe("call_1");
		expect(toolBlock.name).toBe("search");

		// input_json_delta events
		const jsonDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				((e.data as Record<string, unknown>).delta as Record<string, unknown>).type === "input_json_delta",
		);
		expect(jsonDeltas.length).toBeGreaterThanOrEqual(1);

		// message_delta with tool_use stop reason
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(
			((msgDelta!.data as Record<string, unknown>).delta as Record<string, string>).stop_reason,
		).toBe("tool_use");
	});

	test("translates mixed text + tool call stream", async () => {
		const openaiSSE = [
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Let me search."},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
			'data: {"id":"chatcmpl-123","usage":{"prompt_tokens":10,"completion_tokens":20}}',
			"data: [DONE]",
		].join("\n\n");

		const stream = createStreamTranslator(
			mockStream(openaiSSE),
			"claude-sonnet-4-20250514",
		);
		const output = await readStream(stream);
		const events = parseSSEEvents(output);

		// Should have: message_start, content_block_start(text), content_block_delta(text),
		// content_block_stop, content_block_start(tool_use), content_block_delta(json),
		// content_block_stop, message_delta, message_stop
		const blockStarts = events.filter((e) => e.event === "content_block_start");
		expect(blockStarts).toHaveLength(2);

		const firstBlock = (blockStarts[0].data as Record<string, unknown>).content_block as Record<string, unknown>;
		expect(firstBlock.type).toBe("text");
		expect((blockStarts[0].data as Record<string, unknown>).index).toBe(0);

		const secondBlock = (blockStarts[1].data as Record<string, unknown>).content_block as Record<string, unknown>;
		expect(secondBlock.type).toBe("tool_use");
		expect((blockStarts[1].data as Record<string, unknown>).index).toBe(1);
	});

	test("handles stream with no data gracefully", async () => {
		const stream = createStreamTranslator(
			mockStream(""),
			"claude-sonnet-4-20250514",
		);
		const output = await readStream(stream);
		expect(output).toBe("");
	});
});

// --- Error Classification ---

describe("openaiAdapter.classifyError", () => {
	test("429 is throttled and retryable", () => {
		const err = openaiAdapter.classifyError(429);
		expect(err.category).toBe("throttled");
		expect(err.retryable).toBe(true);
	});

	test("500 is retryable", () => {
		const err = openaiAdapter.classifyError(500);
		expect(err.category).toBe("retryable");
		expect(err.retryable).toBe(true);
	});

	test("401 is auth and not retryable", () => {
		const err = openaiAdapter.classifyError(401);
		expect(err.category).toBe("auth");
		expect(err.retryable).toBe(false);
	});

	test("403 is auth and not retryable", () => {
		const err = openaiAdapter.classifyError(403);
		expect(err.category).toBe("auth");
		expect(err.retryable).toBe(false);
	});

	test("400 is fatal and not retryable", () => {
		const err = openaiAdapter.classifyError(400);
		expect(err.category).toBe("fatal");
		expect(err.retryable).toBe(false);
	});

	test("extracts message from OpenAI error body", () => {
		const body = JSON.stringify({
			error: { message: "Invalid API key", type: "invalid_api_key" },
		});
		const err = openaiAdapter.classifyError(401, body);
		expect(err.message).toBe("Invalid API key");
	});
});

// --- translateResponse via adapter ---

describe("openaiAdapter.translateResponse", () => {
	test("translates valid OpenAI response", () => {
		const openaiResponse = JSON.stringify({
			id: "chatcmpl-test",
			choices: [
				{
					message: { role: "assistant", content: "Hi there" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 5, completion_tokens: 3 },
		});
		const result = JSON.parse(openaiAdapter.translateResponse!(openaiResponse, "claude-sonnet-4-20250514"));
		expect(result.type).toBe("message");
		expect(result.model).toBe("claude-sonnet-4-20250514");
		expect(result.content[0].text).toBe("Hi there");
	});

	test("returns raw body on parse error", () => {
		const result = openaiAdapter.translateResponse!("not json", "claude-sonnet-4-20250514");
		expect(result).toBe("not json");
	});
});
