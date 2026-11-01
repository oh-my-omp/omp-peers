// The asking side: dial a peer endpoint, send one request, read one response. A peer is alive
// exactly when its endpoint accepts the connection; everything after that is a request result.
import * as fs from "node:fs/promises";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { errorText } from "./errors.ts";
import { endpointFor } from "./node.ts";
import { MAX_FRAME_BYTES, parseResponse, type Response, type SessionInfo, type WireRequest } from "./protocol.ts";

const CONNECT_TIMEOUT_MS = 1_000;
export const LIST_TIMEOUT_MS = 2_000;
export const DELIVER_TIMEOUT_MS = 5_000;
export const ASK_TIMEOUT_MS = 300_000;

export type Exchange =
	| { kind: "response"; response: Response }
	/** Connect failed: no listener, so no live peer at this pid. */
	| { kind: "unreachable"; reason: string }
	| { kind: "timeout"; ms: number }
	| { kind: "cancelled" }
	| { kind: "closed"; reason: string }
	| { kind: "malformed"; message: string };

export async function exchange(dir: string, pid: number, request: WireRequest, timeoutMs: number, signal?: AbortSignal): Promise<Exchange> {
	if (signal?.aborted) return { kind: "cancelled" };
	let connection: IpcConnection;
	try {
		connection = await IpcConnection.connect(endpointFor(dir, pid), {
			framing: "lines",
			timeoutMs: CONNECT_TIMEOUT_MS,
			maxFrameBytes: MAX_FRAME_BYTES,
		});
	} catch (error) {
		return { kind: "unreachable", reason: errorText(error) };
	}
	const { promise, resolve } = Promise.withResolvers<Exchange>();
	let settled = false;
	const finish = (result: Exchange): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		connection.destroy();
		resolve(result);
	};
	const timer = setTimeout(() => finish({ kind: "timeout", ms: timeoutMs }), timeoutMs);
	const onAbort = (): void => finish({ kind: "cancelled" });
	signal?.addEventListener("abort", onAbort, { once: true });
	connection.start(
		(line) => {
			const parsed = parseResponse(line);
			finish(parsed.kind === "ok" ? { kind: "response", response: parsed.value } : { kind: "malformed", message: parsed.message });
		},
		(reason) => finish({ kind: "closed", reason: reason ?? "closed without a response" }),
	);
	connection.send(JSON.stringify(request));
	return await promise;
}

/** Pids with an endpoint file. A file is only a lead: a crashed peer leaves one behind until reboot or pid reuse. */
async function endpointPids(dir: string): Promise<number[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		// No peer has listened since boot.
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const pids: number[] = [];
	for (const name of names) {
		const match = /^(\d+)\.sock$/.exec(name);
		if (match?.[1] !== undefined) pids.push(Number(match[1]));
	}
	return pids;
}

export type PeerProcess = {
	pid: number;
	sessions: { kind: "listed"; list: readonly SessionInfo[] } | { kind: "unlisted"; reason: string };
};

/** Every live peer process in `dir`, each asked for its main sessions. Unreachable endpoints are left out. */
export async function survey(dir: string): Promise<PeerProcess[]> {
	const pids = await endpointPids(dir);
	const observed = await Promise.all(pids.map((pid) => observe(dir, pid)));
	return observed.filter((peer) => peer !== undefined).sort((a, b) => a.pid - b.pid);
}

async function observe(dir: string, pid: number): Promise<PeerProcess | undefined> {
	const result = await exchange(dir, pid, { v: 1, kind: "list" }, LIST_TIMEOUT_MS);
	switch (result.kind) {
		case "unreachable":
			return undefined;
		case "response": {
			const response = result.response;
			if (response.kind === "sessions") return { pid, sessions: { kind: "listed", list: response.sessions } };
			if (response.kind === "error") return { pid, sessions: { kind: "unlisted", reason: `${response.code}: ${response.message}` } };
			return { pid, sessions: { kind: "unlisted", reason: `unexpected ${response.kind} response` } };
		}
		case "timeout":
			return { pid, sessions: { kind: "unlisted", reason: `no answer within ${result.ms} ms` } };
		case "cancelled":
			return { pid, sessions: { kind: "unlisted", reason: "cancelled" } };
		case "closed":
			return { pid, sessions: { kind: "unlisted", reason: result.reason } };
		case "malformed":
			return { pid, sessions: { kind: "unlisted", reason: `malformed response: ${result.message}` } };
	}
}

export type Target =
	| { kind: "found"; pid: number; session: SessionInfo }
	| { kind: "not_found"; known: readonly string[] }
	| { kind: "ambiguous"; candidates: readonly { pid: number; sessionId: string }[] };

/** Resolve a session id, or a unique prefix of one, against the live peers in `dir` at this moment. */
export async function resolveTarget(dir: string, to: string): Promise<Target> {
	const peers = await survey(dir);
	const known: string[] = [];
	const exact: { pid: number; session: SessionInfo }[] = [];
	const prefixed: { pid: number; session: SessionInfo }[] = [];
	for (const peer of peers) {
		if (peer.sessions.kind !== "listed") continue;
		for (const session of peer.sessions.list) {
			known.push(session.sessionId);
			if (session.sessionId === to) exact.push({ pid: peer.pid, session });
			else if (session.sessionId.startsWith(to)) prefixed.push({ pid: peer.pid, session });
		}
	}
	const matches = exact.length > 0 ? exact : prefixed;
	const [only, ...rest] = matches;
	if (only === undefined) return { kind: "not_found", known };
	if (rest.length > 0)
		return { kind: "ambiguous", candidates: matches.map((match) => ({ pid: match.pid, sessionId: match.session.sessionId })) };
	return { kind: "found", pid: only.pid, session: only.session };
}
