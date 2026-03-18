import type {
	ClassifiedError,
	ContentBlock,
	Message,
	ProviderAdapter,
	ProviderConfig,
	ProxyRequest,
	Tool,
	ToolChoice,
} from "../../types/index.ts";
import { logger } from "../../telemetry/logger.ts";

const DEFAULT_BASE_URL = "https://api.openai.com";

export const openaiAdapter: ProviderAdapter = {
	name: "openai",

	translate(req: ProxyRequest, config: ProviderConfig, _clientHeaders: Record<string, string> = {}) {
		const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
		const url = `${baseUrl}/v1/chat/completions`;

		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${config.apiKey ?? ""}`,
		};

		const mappedModel = config.modelMap?.[req.model] ?? req.model;

		const openaiBody: Record<string, unknown> = {
			model: mappedModel,
			messages: translateMessages(req.messages, req.system),
			max_completion_tokens: req.max_tokens,
		};

		if (req.temperature !== undefined) openaiBody.temperature = req.temperature;
		if (req.top_p !== undefined) openaiBody.top_p = req.top_p;
		if (req.top_k !== undefined) {
			logger.warn("OpenAI does not support top_k, dropping parameter");
		}
		if (req.stop_sequences) openaiBody.stop = req.stop_sequences;
		if (req.stream) {
			openaiBody.stream = true;
			openaiBody.stream_options = { include_usage: true };
		}
		if (req.tools) openaiBody.tools = translateTools(req.tools);
		if (req.tool_choice) openaiBody.tool_choice = translateToolChoice(req.tool_choice);

		return { url, headers, body: JSON.stringify(openaiBody) };
	},

	translateResponse(responseBody: string, requestModel: string): string {
		try {
			const openai = JSON.parse(responseBody);
			return JSON.stringify(translateOpenAIResponse(openai, requestModel));
		} catch {
			return responseBody;
		}
	},

	translateStream(
		upstream: ReadableStream<Uint8Array>,
		requestModel: string,
	): ReadableStream<Uint8Array> {
		return createStreamTranslator(upstream, requestModel);
	},

	classifyError(status: number, body?: string): ClassifiedError {
		let message = `OpenAI error: ${status}`;
		if (body) {
			try {
				const parsed = JSON.parse(body);
				message = parsed?.error?.message ?? message;
			} catch {
				// ignore parse errors
			}
		}

		switch (true) {
			case status === 429:
				return { status, category: "throttled", message, retryable: true };
			case status === 401 || status === 403:
				return { status, category: "auth", message, retryable: false };
			case status === 400:
				return { status, category: "fatal", message, retryable: false };
			case status >= 500:
				return { status, category: "retryable", message, retryable: true };
			default:
				return { status, category: "fatal", message, retryable: false };
		}
	},
};

// --- Request Translation ---

interface OpenAIMessage {
	role: string;
	content?: string | null | OpenAIContentPart[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

interface OpenAIContentPart {
	type: string;
	text?: string;
	image_url?: { url: string };
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

function translateMessages(
	messages: Message[],
	system?: string | ContentBlock[],
): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];

	if (system) {
		if (typeof system === "string") {
			result.push({ role: "system", content: system });
		} else {
			const text = system
				.filter((b) => b.type === "text")
				.map((b) => b.text as string)
				.join("\n");
			if (text) result.push({ role: "system", content: text });
		}
	}

	for (const msg of messages) {
		if (msg.role === "user") {
			if (Array.isArray(msg.content)) {
				const toolResults = msg.content.filter((b) => b.type === "tool_result");
				const otherContent = msg.content.filter((b) => b.type !== "tool_result");

				// Each tool_result becomes a separate "tool" role message
				for (const tr of toolResults) {
					const content =
						typeof tr.content === "string"
							? tr.content
							: tr.content
								? JSON.stringify(tr.content)
								: "";
					result.push({
						role: "tool",
						tool_call_id: tr.tool_use_id as string,
						content,
					});
				}

				if (otherContent.length > 0) {
					result.push({
						role: "user",
						content: translateContentBlocks(otherContent),
					});
				}
			} else {
				result.push({ role: "user", content: msg.content });
			}
		} else if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				const textBlocks = msg.content.filter((b) => b.type === "text");
				const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

				const openaiMsg: OpenAIMessage = { role: "assistant" };

				const textContent = textBlocks.map((b) => b.text as string).join("");
				openaiMsg.content = textContent || null;

				if (toolUseBlocks.length > 0) {
					openaiMsg.tool_calls = toolUseBlocks.map((b) => ({
						id: b.id as string,
						type: "function" as const,
						function: {
							name: b.name as string,
							arguments: JSON.stringify(b.input),
						},
					}));
				}

				result.push(openaiMsg);
			} else {
				result.push({ role: "assistant", content: msg.content });
			}
		}
	}

	return result;
}

function translateContentBlocks(
	blocks: ContentBlock[],
): string | OpenAIContentPart[] {
	if (blocks.length === 1 && blocks[0].type === "text") {
		return blocks[0].text as string;
	}

	return blocks.map((block): OpenAIContentPart => {
		if (block.type === "text") {
			return { type: "text", text: block.text as string };
		}
		if (block.type === "image") {
			const source = block.source as {
				type: string;
				media_type?: string;
				data?: string;
				url?: string;
			};
			if (source.type === "base64") {
				return {
					type: "image_url",
					image_url: {
						url: `data:${source.media_type};base64,${source.data}`,
					},
				};
			}
			if (source.type === "url") {
				return {
					type: "image_url",
					image_url: { url: source.url! },
				};
			}
		}
		// Unsupported block type — serialize as text
		return { type: "text", text: JSON.stringify(block) };
	});
}

function translateTools(
	tools: Tool[],
): { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }[] {
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			...(tool.description && { description: tool.description }),
			parameters: tool.input_schema,
		},
	}));
}

function translateToolChoice(
	choice: ToolChoice,
): string | { type: "function"; function: { name: string } } {
	switch (choice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "tool":
			return { type: "function", function: { name: choice.name } };
	}
}

// --- Response Translation (non-streaming) ---

const STOP_REASON_MAP: Record<string, string> = {
	stop: "end_turn",
	length: "max_tokens",
	tool_calls: "tool_use",
};

function translateOpenAIResponse(
	openai: Record<string, unknown>,
	requestModel: string,
): Record<string, unknown> {
	const choices = openai.choices as { message: Record<string, unknown>; finish_reason: string }[] | undefined;
	const choice = choices?.[0];
	const message = choice?.message;
	const usage = openai.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

	const content: ContentBlock[] = [];

	if (message?.content) {
		content.push({ type: "text", text: message.content as string });
	}

	if (message?.tool_calls) {
		for (const tc of message.tool_calls as OpenAIToolCall[]) {
			let input: unknown;
			try {
				input = JSON.parse(tc.function.arguments);
			} catch {
				input = {};
			}
			content.push({
				type: "tool_use",
				id: tc.id,
				name: tc.function.name,
				input,
			});
		}
	}

	return {
		id: (openai.id as string) ?? `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content,
		model: requestModel,
		stop_reason: STOP_REASON_MAP[choice?.finish_reason ?? "stop"] ?? "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: usage?.prompt_tokens ?? 0,
			output_tokens: usage?.completion_tokens ?? 0,
		},
	};
}

// --- Streaming Translation (SSE rewriting) ---

function createStreamTranslator(
	upstream: ReadableStream<Uint8Array>,
	requestModel: string,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	let buffer = "";
	let messageStarted = false;
	let currentBlockIndex = -1;
	let currentBlockType: "text" | "tool_use" | null = null;
	const toolCalls = new Map<number, { id: string; name: string; blockIndex: number }>();
	let openaiId = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let finishReason: string | null = null;
	let finalized = false;

	function sse(event: string, data: unknown): string {
		return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	function emitMessageStart(): string {
		if (messageStarted) return "";
		messageStarted = true;
		return sse("message_start", {
			type: "message_start",
			message: {
				id: openaiId || `msg_${Date.now()}`,
				type: "message",
				role: "assistant",
				content: [],
				model: requestModel,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: 0 },
			},
		});
	}

	function closeCurrentBlock(): string {
		if (currentBlockType === null) return "";
		const out = sse("content_block_stop", {
			type: "content_block_stop",
			index: currentBlockIndex,
		});
		currentBlockType = null;
		return out;
	}

	function startBlock(
		type: "text" | "tool_use",
		extra?: { id: string; name: string },
	): string {
		currentBlockIndex++;
		currentBlockType = type;
		const block =
			type === "text"
				? { type: "text", text: "" }
				: { type: "tool_use", id: extra!.id, name: extra!.name, input: {} };
		return sse("content_block_start", {
			type: "content_block_start",
			index: currentBlockIndex,
			content_block: block,
		});
	}

	function finalize(): string {
		if (finalized) return "";
		finalized = true;
		let out = closeCurrentBlock();
		out += sse("message_delta", {
			type: "message_delta",
			delta: {
				stop_reason: STOP_REASON_MAP[finishReason ?? "stop"] ?? "end_turn",
			},
			usage: { output_tokens: outputTokens },
		});
		out += sse("message_stop", { type: "message_stop" });
		return out;
	}

	function processDataLine(payload: string): string {
		if (payload === "[DONE]") return finalize();

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(payload);
		} catch {
			return "";
		}

		let out = "";

		if (data.id) openaiId = data.id as string;
		const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
		if (usage) {
			inputTokens = usage.prompt_tokens ?? inputTokens;
			outputTokens = usage.completion_tokens ?? outputTokens;
		}

		const choices = data.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined;
		const choice = choices?.[0];
		if (!choice) return out;

		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = (choice.delta ?? {}) as Record<string, unknown>;

		out += emitMessageStart();

		// Text content
		if (delta.content != null && delta.content !== "") {
			if (currentBlockType !== "text") {
				out += closeCurrentBlock();
				out += startBlock("text");
			}
			out += sse("content_block_delta", {
				type: "content_block_delta",
				index: currentBlockIndex,
				delta: { type: "text_delta", text: delta.content },
			});
		}

		// Tool calls
		if (delta.tool_calls) {
			for (const tc of delta.tool_calls as {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}[]) {
				const tcIdx = tc.index ?? 0;

				if (tc.id) {
					// New tool call starting
					out += closeCurrentBlock();
					out += startBlock("tool_use", {
						id: tc.id,
						name: tc.function?.name ?? "",
					});
					toolCalls.set(tcIdx, {
						id: tc.id,
						name: tc.function?.name ?? "",
						blockIndex: currentBlockIndex,
					});
				}

				if (tc.function?.arguments) {
					const info = toolCalls.get(tcIdx);
					if (info) {
						out += sse("content_block_delta", {
							type: "content_block_delta",
							index: info.blockIndex,
							delta: {
								type: "input_json_delta",
								partial_json: tc.function.arguments,
							},
						});
					}
				}
			}
		}

		return out;
	}

	return new ReadableStream({
		async pull(controller) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					let out = "";
					if (buffer.trim()) {
						for (const line of buffer.split("\n")) {
							const trimmed = line.trim();
							if (trimmed.startsWith("data: ")) {
								out += processDataLine(trimmed.slice(6));
							}
						}
					}
					if (messageStarted && !finalized) {
						out += finalize();
					}
					if (out) controller.enqueue(encoder.encode(out));
					controller.close();
					return;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				let out = "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith("data: ")) {
						out += processDataLine(trimmed.slice(6));
					}
				}

				if (out) {
					controller.enqueue(encoder.encode(out));
					return;
				}
			}
		},
		cancel() {
			reader.cancel();
		},
	});
}

// Exported for testing
export {
	translateMessages,
	translateTools,
	translateToolChoice,
	translateOpenAIResponse,
	createStreamTranslator,
};
