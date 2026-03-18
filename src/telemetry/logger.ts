export interface LogContext {
	reqId?: string;
	provider?: string;
	model?: string;
	[key: string]: unknown;
}

function formatLog(
	level: string,
	message: string,
	context?: LogContext,
): string {
	return JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg: message,
		...context,
	});
}

export const logger = {
	info(message: string, context?: LogContext) {
		console.log(formatLog("info", message, context));
	},
	warn(message: string, context?: LogContext) {
		console.warn(formatLog("warn", message, context));
	},
	error(message: string, context?: LogContext) {
		console.error(formatLog("error", message, context));
	},
	debug(message: string, context?: LogContext) {
		if (process.env.LOG_LEVEL === "debug") {
			console.log(formatLog("debug", message, context));
		}
	},
};
