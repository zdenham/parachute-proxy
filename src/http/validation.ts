import { z } from "zod/v4";

const messageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
});

export const proxyRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(messageSchema).min(1),
	max_tokens: z.number().int().positive(),
	stream: z.boolean().optional(),
	system: z
		.union([z.string(), z.array(z.record(z.string(), z.unknown()))])
		.optional(),
	temperature: z.number().min(0).max(1).optional(),
	top_p: z.number().min(0).max(1).optional(),
	top_k: z.number().int().positive().optional(),
	stop_sequences: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	tools: z
		.array(
			z.object({
				name: z.string(),
				description: z.string().optional(),
				input_schema: z.record(z.string(), z.unknown()),
			}),
		)
		.optional(),
	tool_choice: z
		.union([
			z.object({ type: z.literal("auto") }),
			z.object({ type: z.literal("any") }),
			z.object({ type: z.literal("tool"), name: z.string() }),
		])
		.optional(),
});
