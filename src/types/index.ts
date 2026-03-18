import type { z } from "zod/v4";
import type { configSchema, providerConfigSchema } from "../config/schema.ts";

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export interface ProxyRequest {
	model: string;
	messages: Message[];
	max_tokens: number;
	stream?: boolean;
	system?: string | ContentBlock[];
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	metadata?: Record<string, unknown>;
	tools?: Tool[];
	tool_choice?: ToolChoice;
}

export interface Message {
	role: "user" | "assistant";
	content: string | ContentBlock[];
}

export interface ContentBlock {
	type: string;
	[key: string]: unknown;
}

export interface Tool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

export type ToolChoice =
	| { type: "auto" }
	| { type: "any" }
	| { type: "tool"; name: string };

export interface ProxyResponse {
	id: string;
	type: "message";
	role: "assistant";
	content: ContentBlock[];
	model: string;
	stop_reason: string | null;
	stop_sequence: string | null;
	usage: { input_tokens: number; output_tokens: number };
}

export interface ErrorResponse {
	type: "error";
	error: {
		type: string;
		message: string;
	};
}

export type ErrorCategory = "retryable" | "throttled" | "auth" | "fatal";

export interface ClassifiedError {
	status: number;
	category: ErrorCategory;
	message: string;
	retryable: boolean;
}

export interface ProviderAdapter {
	name: string;
	translate(
		req: ProxyRequest,
		config: ProviderConfig,
	): { url: string; headers: Record<string, string>; body: string };
	classifyError(status: number, body?: string): ClassifiedError;
}
