import type {
	ClassifiedError,
	ProviderAdapter,
	ProviderConfig,
	ProxyRequest,
} from "../../types/index.ts";
import { signRequest, type AwsCredentials } from "./signer.ts";

const ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * AWS Bedrock adapter for Claude models.
 *
 * Endpoint:
 *   POST https://bedrock-runtime.{REGION}.amazonaws.com/model/{MODEL_ID}/invoke
 *   POST .../invoke-with-response-stream
 *
 * Auth: AWS SigV4 signing with credentials from config or environment.
 * Request body uses the Anthropic Messages API format with `anthropic_version` in the body.
 */
export const bedrockAdapter: ProviderAdapter = {
	name: "bedrock",

	translate(req: ProxyRequest, config: ProviderConfig) {
		const region = config.region ?? "us-east-1";
		const isStream = req.stream === true;
		const action = isStream ? "invoke-with-response-stream" : "invoke";

		// Bedrock model IDs use a different format: anthropic.claude-sonnet-4-20250514-v1:0
		// The config can specify a defaultModel override, or we use the model as-is
		const modelId = req.model;

		const baseUrl =
			config.baseUrl ??
			`https://bedrock-runtime.${region}.amazonaws.com`;

		const url = `${baseUrl}/model/${modelId}/${action}`;

		// Build the body — same as Anthropic but with anthropic_version in body, model excluded
		const { model: _model, ...rest } = req;
		const body = JSON.stringify({
			...rest,
			anthropic_version: ANTHROPIC_VERSION,
		});

		// Resolve credentials from config or environment
		const credentials = resolveCredentials(config);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: isStream ? "application/vnd.amazon.eventstream" : "application/json",
		};

		if (credentials) {
			const signed = signRequest("POST", url, headers, body, credentials, region);
			return { url, headers: signed.headers, body };
		}

		// No credentials available — send without signing (will fail at AWS but lets the error propagate)
		return { url, headers, body };
	},

	classifyError(status: number, body?: string): ClassifiedError {
		let message = `Bedrock error: ${status}`;
		if (body) {
			try {
				const parsed = JSON.parse(body);
				message = parsed?.message ?? parsed?.Message ?? message;
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

function resolveCredentials(config: ProviderConfig): AwsCredentials | null {
	// Try environment variables first (standard AWS SDK convention)
	const envAccessKey = process.env.AWS_ACCESS_KEY_ID;
	const envSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
	if (envAccessKey && envSecretKey) {
		return {
			accessKeyId: envAccessKey,
			secretAccessKey: envSecretKey,
			sessionToken: process.env.AWS_SESSION_TOKEN,
		};
	}

	// The apiKey field in config can hold "ACCESS_KEY_ID:SECRET_ACCESS_KEY" format
	if (config.apiKey?.includes(":")) {
		const [accessKeyId, secretAccessKey] = config.apiKey.split(":", 2);
		if (accessKeyId && secretAccessKey) {
			return { accessKeyId, secretAccessKey };
		}
	}

	// Try loading from ~/.aws/credentials profile
	const profileCreds = loadAwsProfile(config.profile ?? process.env.AWS_PROFILE ?? "default");
	if (profileCreds) {
		return profileCreds;
	}

	return null;
}

/**
 * Load AWS credentials from ~/.aws/credentials INI file.
 */
function loadAwsProfile(profile: string): AwsCredentials | null {
	const homedir = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE
		?? `${homedir}/.aws/credentials`;

	try {
		const content = require("node:fs").readFileSync(credentialsPath, "utf-8") as string;
		return parseAwsCredentials(content, profile);
	} catch {
		return null;
	}
}

/** Parse an INI-format AWS credentials file and extract credentials for the given profile. */
export function parseAwsCredentials(content: string, profile: string): AwsCredentials | null {
	const lines = content.split("\n");
	const sectionHeader = `[${profile}]`;
	let inSection = false;
	let accessKeyId: string | undefined;
	let secretAccessKey: string | undefined;
	let sessionToken: string | undefined;

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (line.startsWith("[")) {
			inSection = line.toLowerCase() === sectionHeader.toLowerCase();
			continue;
		}

		if (!inSection) continue;
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;

		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;

		const key = line.slice(0, eqIdx).trim().toLowerCase();
		const value = line.slice(eqIdx + 1).trim();

		if (key === "aws_access_key_id") accessKeyId = value;
		else if (key === "aws_secret_access_key") secretAccessKey = value;
		else if (key === "aws_session_token") sessionToken = value;
	}

	if (accessKeyId && secretAccessKey) {
		return { accessKeyId, secretAccessKey, sessionToken };
	}
	return null;
}
