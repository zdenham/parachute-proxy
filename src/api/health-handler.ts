export function healthHandler(): Response {
	return new Response(JSON.stringify({ status: "ok" }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
