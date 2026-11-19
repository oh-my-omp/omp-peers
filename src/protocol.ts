import { z } from "@oh-my-pi/pi-coding-agent";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_ANSWER_BYTES = 32 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

export function utf8Bytes(text: string): number {
	return utf8.encode(text).byteLength;
}

const utf8Decode = new TextDecoder();

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (text.length * 3 <= maxBytes) return { text, truncated: false };
	const buf = new Uint8Array(Math.min(maxBytes + 3, text.length * 3));
	const { written, read } = utf8.encodeInto(text, buf);
	if (written <= maxBytes) {
		if (read === text.length) return { text, truncated: false };
		return { text: utf8Decode.decode(buf.subarray(0, written)), truncated: true };
	}
	let end = maxBytes;
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: utf8Decode.decode(buf.subarray(0, end)), truncated: true };
}

const boundedText = z
	.string()
	.min(1)
	.refine((text) => utf8Bytes(text) <= MAX_TEXT_BYTES, { message: `longer than ${MAX_TEXT_BYTES} UTF-8 bytes` });

const wireSenderSchema = z.object({
	pid: z.number().int().positive(),
	sessionId: z.string().min(1),
	title: z.string().optional(),
	cwd: z.string(),
	subagent: z.string().min(1).optional(),
});
type WireSender = z.infer<typeof wireSenderSchema>;
const senderSchema = wireSenderSchema.transform(
	({ subagent, ...origin }): Sender =>
		subagent === undefined ? { kind: "main", ...origin } : { kind: "sub", agentId: subagent, ...origin },
);

interface Origin {
	pid: number;
	sessionId: string;
	title?: string;
	cwd: string;
}
export type Sender = ({ kind: "main" } & Origin) | ({ kind: "sub"; agentId: string } & Origin);

export function senderWire(sender: Sender): WireSender {
	switch (sender.kind) {
		case "main": {
			const { kind: _kind, ...origin } = sender;
			return origin;
		}
		case "sub": {
			const { kind: _kind, agentId, ...origin } = sender;
			return { ...origin, subagent: agentId };
		}
	}
}

const requestSchema = z.union([
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("list") }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("ask"), to: z.string().min(1), from: senderSchema, question: boundedText }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("irc"), to: z.string().min(1), from: senderSchema, message: boundedText }),
]);
export type Request = z.infer<typeof requestSchema>;
export type WireRequest =
	| Extract<Request, { kind: "list" }>
	| (Omit<Extract<Request, { kind: "ask" }>, "from"> & { from: WireSender })
	| (Omit<Extract<Request, { kind: "irc" }>, "from"> & { from: WireSender });

const sessionSchema = z.object({
	sessionId: z.string(),
	title: z.string().optional(),
	cwd: z.string(),
	idle: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;

export const ERROR_CODES = [
	"bad_request",
	"unsupported_version",
	"target_not_found",
	"ask_busy",
	"ask_unsupported",
	"ask_failed",
	"delivery_failed",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const responseSchema = z.union([
	z.object({ kind: z.literal("sessions"), pid: z.number().int(), sessions: z.array(sessionSchema) }),
	z.object({ kind: z.literal("answer"), text: z.string(), truncated: z.boolean() }),
	z.object({ kind: z.literal("accepted"), recipient: z.enum(["idle", "busy"]) }),
	z.object({ kind: z.literal("error"), code: z.enum(ERROR_CODES), message: z.string() }),
]);
export type Response = z.infer<typeof responseSchema>;

export type Parsed<T> = { kind: "ok"; value: T } | { kind: "invalid"; code: "bad_request" | "unsupported_version"; message: string };

function parseJson(line: string): { kind: "ok"; value: unknown } | { kind: "invalid"; message: string } {
	try {
		return { kind: "ok", value: JSON.parse(line) };
	} catch (error) {
		return { kind: "invalid", message: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function parseRequest(line: string): Parsed<Request> {
	const json = parseJson(line);
	if (json.kind === "invalid") return { kind: "invalid", code: "bad_request", message: json.message };
	const version = z.object({ v: z.number() }).safeParse(json.value);
	if (version.success && version.data.v !== PROTOCOL_VERSION) {
		return { kind: "invalid", code: "unsupported_version", message: `protocol ${version.data.v}; this peer speaks ${PROTOCOL_VERSION}` };
	}
	const request = requestSchema.safeParse(json.value);
	if (!request.success) return { kind: "invalid", code: "bad_request", message: request.error.message };
	return { kind: "ok", value: request.data };
}

export function parseResponse(line: string): Parsed<Response> {
	const json = parseJson(line);
	if (json.kind === "invalid") return { kind: "invalid", code: "bad_request", message: json.message };
	const response = responseSchema.safeParse(json.value);
	if (!response.success) return { kind: "invalid", code: "bad_request", message: response.error.message };
	return { kind: "ok", value: response.data };
}
