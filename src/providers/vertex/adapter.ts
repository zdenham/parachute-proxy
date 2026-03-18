import { createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import type {
	ClassifiedError,
	ProviderAdapter,
	ProviderConfig,
	ProxyRequest,
} from "../../types/index.ts";

const ANTHROPIC_VERSION = "vertex-2023-10-16";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Cached access token with expiration */
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 50 * 60 * 1000; // refresh 10min before 60min expiry

/**
 * Vertex AI adapter for Claude models.
 *
 * Vertex uses the rawPredict/streamRawPredict endpoints:
 *   POST https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/publishers/anthropic/models/{MODEL}:rawPredict
 *   POST .../:streamRawPredict
 *
 * Auth: Bearer token from Application Default Credentials (ADC).
 * The request body is the same as Anthropic Messages API but with `anthropic_version` in the body.
 */
export const vertexAdapter: ProviderAdapter = {
	name: "vertex",

	translate(req: ProxyRequest, config: ProviderConfig, _clientHeaders: Record<string, string> = {}) {
		const region = config.region ?? "us-east5";
		const projectId = config.projectId ?? "";
		const isStream = req.stream === true;
		const method = isStream ? "streamRawPredict" : "rawPredict";

		const baseUrl =
			config.baseUrl ??
			`https://${region}-aiplatform.googleapis.com`;

		// Vertex uses @ instead of - before the date version (e.g. claude-sonnet-4@20250514)
		const vertexModel = toVertexModelId(req.model);

		const url = `${baseUrl}/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${vertexModel}:${method}`;

		// Resolve auth: explicit apiKey, service account JWT, or gcloud ADC
		const token = config.apiKey || resolveAccessToken();

		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${token ?? ""}`,
		};

		// Vertex expects the Anthropic-compatible body with anthropic_version field
		const { model: _model, ...rest } = req;
		const body = JSON.stringify({
			...rest,
			anthropic_version: ANTHROPIC_VERSION,
		});

		return { url, headers, body };
	},

	classifyError(status: number, body?: string): ClassifiedError {
		let message = `Vertex error: ${status}`;
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

/**
 * Resolve an access token, trying in order:
 * 1. Cached token (if still valid)
 * 2. Service account JWT exchange (GOOGLE_CREDENTIALS_JSON env var)
 * 3. gcloud CLI ADC fallback
 */
export function resolveAccessToken(): string | null {
	if (cachedToken && Date.now() < cachedToken.expiresAt) {
		return cachedToken.token;
	}

	// Try service account JWT first
	const saToken = resolveServiceAccountToken();
	if (saToken) return saToken;

	// Fall back to gcloud CLI
	return resolveGcloudToken();
}

/**
 * Exchange a service account JWT assertion for an access token.
 * Reads GOOGLE_CREDENTIALS_JSON env var containing the service account key JSON.
 */
function resolveServiceAccountToken(): string | null {
	const credJson = process.env.GOOGLE_CREDENTIALS_JSON;
	if (!credJson) return null;

	try {
		const cred = JSON.parse(credJson) as {
			client_email?: string;
			private_key?: string;
		};
		if (!cred.client_email || !cred.private_key) return null;

		// .env files often store PEM keys with literal \n instead of newlines
		const privateKey = cred.private_key.replace(/\\n/g, "\n");

		const now = Math.floor(Date.now() / 1000);
		const assertion = createJwtAssertion(cred.client_email, privateKey, now);

		// Synchronous token exchange via curl (translate() is sync)
		const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`;
		const curlResult = spawnSync(
			"curl",
			["-s", "-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "-d", body, GOOGLE_TOKEN_URL],
			{ timeout: 10_000 },
		);

		if (curlResult.status !== 0) return null;

		const resp = JSON.parse(curlResult.stdout?.toString() ?? "{}") as {
			access_token?: string;
			expires_in?: number;
		};
		if (!resp.access_token) return null;

		const ttl = Math.min((resp.expires_in ?? 3600) * 1000 - 600_000, TOKEN_TTL_MS);
		cachedToken = { token: resp.access_token, expiresAt: Date.now() + ttl };
		return resp.access_token;
	} catch {
		return null;
	}
}

/**
 * Create a signed JWT assertion for Google OAuth2 token exchange.
 */
export function createJwtAssertion(
	clientEmail: string,
	privateKey: string,
	nowSeconds: number,
): string {
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			iss: clientEmail,
			scope: CLOUD_PLATFORM_SCOPE,
			aud: GOOGLE_TOKEN_URL,
			iat: nowSeconds,
			exp: nowSeconds + 3600,
		}),
	);

	const signingInput = `${header}.${payload}`;
	const signer = createSign("RSA-SHA256");
	signer.update(signingInput);
	const signature = base64url(signer.sign(privateKey));

	return `${signingInput}.${signature}`;
}

function base64url(input: string | Buffer): string {
	const buf = typeof input === "string" ? Buffer.from(input) : input;
	return buf.toString("base64url");
}

/**
 * Resolve an access token from gcloud CLI ADC.
 */
function resolveGcloudToken(): string | null {
	try {
		const result = spawnSync(
			"gcloud",
			["auth", "application-default", "print-access-token"],
			{ timeout: 5000, env: process.env },
		);

		if (result.status !== 0) return null;

		const token = result.stdout?.toString().trim();
		if (!token) return null;

		cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
		return token;
	} catch {
		return null;
	}
}

/** Reset the cached token (for testing). */
export function resetTokenCache(): void {
	cachedToken = null;
}

/**
 * Convert Anthropic model ID to Vertex format.
 * Anthropic: claude-sonnet-4-20250514 → Vertex: claude-sonnet-4@20250514
 */
export function toVertexModelId(model: string): string {
	// Match a trailing date-like segment: -YYYYMMDD
	return model.replace(/-(\d{8})$/, "@$1");
}
