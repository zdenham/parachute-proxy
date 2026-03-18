import { describe, expect, test } from "bun:test";
import { signRequest, type AwsCredentials } from "../../src/providers/bedrock/signer.ts";

const testCredentials: AwsCredentials = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("SigV4 signer", () => {
	test("produces Authorization header with correct format", () => {
		const { headers } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{ "content-type": "application/json" },
			'{"test": true}',
			testCredentials,
			"us-east-1",
		);

		expect(headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=.+, Signature=[a-f0-9]{64}$/,
		);
	});

	test("includes x-amz-date header", () => {
		const { headers } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{},
			"",
			testCredentials,
			"us-east-1",
		);

		expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
	});

	test("includes x-amz-content-sha256 header", () => {
		const { headers } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{},
			"test body",
			testCredentials,
			"us-east-1",
		);

		expect(headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
	});

	test("includes host header", () => {
		const { headers } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{},
			"",
			testCredentials,
			"us-east-1",
		);

		expect(headers.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
	});

	test("includes session token when provided", () => {
		const creds: AwsCredentials = {
			...testCredentials,
			sessionToken: "FwoGZXIvYX...",
		};

		const { headers } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{},
			"",
			creds,
			"us-east-1",
		);

		expect(headers["x-amz-security-token"]).toBe("FwoGZXIvYX...");
	});

	test("different bodies produce different signatures", () => {
		const { headers: h1 } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{},
			"body1",
			testCredentials,
			"us-east-1",
		);
		const { headers: h2 } = signRequest(
			"POST",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
			{},
			"body2",
			testCredentials,
			"us-east-1",
		);

		const sig1 = h1.authorization!.split("Signature=")[1];
		const sig2 = h2.authorization!.split("Signature=")[1];
		expect(sig1).not.toBe(sig2);
	});
});
