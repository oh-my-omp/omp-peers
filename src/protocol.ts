// Wire protocol between omp-peers nodes: one JSON request line per connection, answered by one
// JSON response line, then the connection closes. Both sides parse what they receive here once,
// at the boundary, into the request and response unions below.
import { z } from "@oh-my-pi/pi-coding-agent";

export const PROTOCOL_VERSION = 1;
/** UTF-8 byte cap of a question or an IRC message. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** UTF-8 byte cap of an answer sent back to the asker. */
export const MAX_ANSWER_BYTES = 32 * 1024;
/** Largest line either side accepts; a request is bounded by MAX_TEXT_BYTES plus small metadata. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

export function utf8Bytes(text: string): number {
	return utf8.encode(text).byteLength;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = utf8.encode(text);
	if (bytes.byteLength <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	// Back up over continuation bytes (10xxxxxx) so the cut never splits a character.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

const boundedText = z
	.string()
	.min(1)
	.refine((text) => utf8Bytes(text) <= MAX_TEXT_BYTES, { message: `longer than ${MAX_TEXT_BYTES} UTF-8 bytes` });

/** The main session that sent a request, as it described itself when sending. */
const senderSchema = z.object({
	pid: z.number().int().positive(),
	sessionId: z.string().min(1),
	title: z.string().optional(),
	cwd: z.string(),
});
export type Sender = z.infer<typeof senderSchema>;

const requestSchema = z.union([
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("list") }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("ask"), to: z.string().min(1), from: senderSchema, question: boundedText }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("irc"), to: z.string().min(1), from: senderSchema, message: boundedText }),
]);
export type Request = z.infer<typeof requestSchema>;

/** One main session a node serves, read live when a list request arrives. */
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
	/** `recipient` is the target's state when the message was injected: idle starts a turn, busy reads it at the next step. */
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
