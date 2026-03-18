import { describe, expect, test } from "bun:test";
import { parseAwsCredentials } from "../../src/providers/bedrock/adapter.ts";

describe("parseAwsCredentials", () => {
	const sampleFile = `[default]
aws_access_key_id = AKIADEFAULTKEY123
aws_secret_access_key = defaultSecretKey456

[staging]
aws_access_key_id = AKIASTAGINGKEY789
aws_secret_access_key = stagingSecretKey012
aws_session_token = stagingSessionToken345

# Comment line
[production]
aws_access_key_id = AKIAPRODKEY111
aws_secret_access_key = prodSecretKey222
`;

	test("parses default profile", () => {
		const creds = parseAwsCredentials(sampleFile, "default");
		expect(creds).toEqual({
			accessKeyId: "AKIADEFAULTKEY123",
			secretAccessKey: "defaultSecretKey456",
			sessionToken: undefined,
		});
	});

	test("parses named profile with session token", () => {
		const creds = parseAwsCredentials(sampleFile, "staging");
		expect(creds).toEqual({
			accessKeyId: "AKIASTAGINGKEY789",
			secretAccessKey: "stagingSecretKey012",
			sessionToken: "stagingSessionToken345",
		});
	});

	test("parses production profile", () => {
		const creds = parseAwsCredentials(sampleFile, "production");
		expect(creds).toEqual({
			accessKeyId: "AKIAPRODKEY111",
			secretAccessKey: "prodSecretKey222",
			sessionToken: undefined,
		});
	});

	test("returns null for unknown profile", () => {
		const creds = parseAwsCredentials(sampleFile, "nonexistent");
		expect(creds).toBeNull();
	});

	test("returns null for empty file", () => {
		const creds = parseAwsCredentials("", "default");
		expect(creds).toBeNull();
	});

	test("handles profile with spaces around values", () => {
		const content = `[test]
aws_access_key_id =   AKIA_SPACED_KEY
aws_secret_access_key =   spacedSecret
`;
		const creds = parseAwsCredentials(content, "test");
		expect(creds).toEqual({
			accessKeyId: "AKIA_SPACED_KEY",
			secretAccessKey: "spacedSecret",
			sessionToken: undefined,
		});
	});

	test("ignores comment lines within profiles", () => {
		const content = `[default]
# this is a comment
aws_access_key_id = AKIAKEY
; this is also a comment
aws_secret_access_key = SECRET
`;
		const creds = parseAwsCredentials(content, "default");
		expect(creds).toEqual({
			accessKeyId: "AKIAKEY",
			secretAccessKey: "SECRET",
			sessionToken: undefined,
		});
	});

	test("returns null when only access key is present", () => {
		const content = `[default]
aws_access_key_id = AKIAKEY
`;
		const creds = parseAwsCredentials(content, "default");
		expect(creds).toBeNull();
	});

	test("is case-insensitive for profile names", () => {
		const content = `[MyProfile]
aws_access_key_id = AKIAKEY
aws_secret_access_key = SECRET
`;
		const creds = parseAwsCredentials(content, "myprofile");
		expect(creds).toEqual({
			accessKeyId: "AKIAKEY",
			secretAccessKey: "SECRET",
			sessionToken: undefined,
		});
	});
});
