import { createHmac, createHash } from "node:crypto";

export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface SignedRequest {
	headers: Record<string, string>;
}

/**
 * Minimal AWS SigV4 signer for Bedrock requests.
 * Implements the essential signing algorithm without pulling in the full AWS SDK.
 */
export function signRequest(
	method: string,
	url: string,
	headers: Record<string, string>,
	body: string,
	credentials: AwsCredentials,
	region: string,
	service = "bedrock",
): SignedRequest {
	const parsedUrl = new URL(url);
	const now = new Date();
	const dateStamp = formatDate(now);
	const amzDate = formatAmzDate(now);

	const signedHeaders: Record<string, string> = {
		...headers,
		host: parsedUrl.host,
		"x-amz-date": amzDate,
	};

	if (credentials.sessionToken) {
		signedHeaders["x-amz-security-token"] = credentials.sessionToken;
	}

	const bodyHash = sha256(body);
	signedHeaders["x-amz-content-sha256"] = bodyHash;

	// Canonical headers (sorted, lowercase)
	const sortedHeaderKeys = Object.keys(signedHeaders)
		.map((k) => k.toLowerCase())
		.sort();
	const canonicalHeaders = sortedHeaderKeys
		.map((k) => `${k}:${signedHeaders[Object.keys(signedHeaders).find((h) => h.toLowerCase() === k)!]!.trim()}`)
		.join("\n");
	const signedHeadersList = sortedHeaderKeys.join(";");

	// Canonical request
	const canonicalRequest = [
		method,
		parsedUrl.pathname,
		parsedUrl.searchParams.toString(),
		canonicalHeaders + "\n",
		signedHeadersList,
		bodyHash,
	].join("\n");

	// String to sign
	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256(canonicalRequest),
	].join("\n");

	// Signing key
	const signingKey = getSigningKey(
		credentials.secretAccessKey,
		dateStamp,
		region,
		service,
	);

	// Signature
	const signature = hmacHex(signingKey, stringToSign);

	// Authorization header
	signedHeaders.authorization = [
		`AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}`,
		`SignedHeaders=${signedHeadersList}`,
		`Signature=${signature}`,
	].join(", ");

	return { headers: signedHeaders };
}

function sha256(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

function hmacHex(key: Buffer | string, data: string): string {
	return createHmac("sha256", key).update(data).digest("hex");
}

function getSigningKey(
	secretKey: string,
	dateStamp: string,
	region: string,
	service: string,
): Buffer {
	const kDate = hmac(`AWS4${secretKey}`, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	return hmac(kService, "aws4_request");
}

function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatAmzDate(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
