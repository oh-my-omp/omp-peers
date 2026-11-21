import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { errorText } from "./errors.ts";
import { endpointFor, peerAddress } from "./node.ts";
import { MAX_FRAME_BYTES, parseResponse, type Response, type SessionInfo, type WireRequest } from "./protocol.ts";

const CONNECT_TIMEOUT_MS = 1_000;
export const LIST_TIMEOUT_MS = 2_000;
export const DELIVER_TIMEOUT_MS = 5_000;
export const ASK_TIMEOUT_MS = 300_000;

export type Exchange =
	| { kind: "response"; response: Response }
	| { kind: "unreachable"; reason: string }
	| { kind: "timeout"; ms: number }
	| { kind: "cancelled" }
	| { kind: "closed"; reason: string }
	| { kind: "malformed"; message: string };

export type ExchangeFailure = Exclude<Exchange, { kind: "response" }>;

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

async function endpointPids(dir: string): Promise<number[]> {
	if (process.platform === "win32") return pipePids(dir);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
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

async function pipePids(dir: string): Promise<number[]> {
	const scope = path.win32.basename(endpointFor(dir, 0)).slice("omp-0".length).toLowerCase();
	const pids: number[] = [];
	for (const name of await fs.readdir("\\\\.\\pipe\\")) {
		const match = /^omp-(\d+)(-[0-9a-f]{16})$/i.exec(name);
		if (match?.[1] !== undefined && match[2]?.toLowerCase() === scope) pids.push(Number(match[1]));
	}
	return pids;
}

export type PeerProcess = {
	pid: number;
	sessions: { kind: "listed"; list: readonly SessionInfo[] } | { kind: "unlisted"; reason: string };
};

export async function survey(dir: string): Promise<PeerProcess[]> {
	const pids = await endpointPids(dir);
	const observed = await Promise.all(pids.map((pid) => observe(dir, pid)));
	return observed.filter((peer) => peer !== undefined).sort((a, b) => a.pid - b.pid);
}

function sessionsOf(response: Response): PeerProcess["sessions"] {
	if (response.kind === "sessions") return { kind: "listed", list: response.sessions };
	if (response.kind === "error") return { kind: "unlisted", reason: `${response.code}: ${response.message}` };
	return { kind: "unlisted", reason: `unexpected ${response.kind} response` };
}

/** A survey hides endpoints nobody listens on (a `kill -9` leaves its socket file behind) and lists the rest. */
async function observe(dir: string, pid: number): Promise<PeerProcess | undefined> {
	const result = await exchange(dir, pid, { v: 1, kind: "list" }, LIST_TIMEOUT_MS);
	switch (result.kind) {
		case "unreachable":
			return undefined;
		case "response":
			return { pid, sessions: sessionsOf(result.response) };
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

/** A parsed `peer://` address: `<pid>`, or `<pid>/<sessionId>` for one of several main sessions in that process. */
export type PeerAddress = { pid: number; sessionId: string | undefined };

export function parseAddress(host: string, path: string): PeerAddress | undefined {
	if (!/^[1-9]\d*$/.test(host)) return undefined;
	const pid = Number(host);
	if (!Number.isSafeInteger(pid)) return undefined;
	const segments = path.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) return { pid, sessionId: undefined };
	const [only, ...rest] = segments;
	if (only === undefined || rest.length > 0) return undefined;
	try {
		return { pid, sessionId: decodeURIComponent(only) };
	} catch {
		return undefined;
	}
}

export type AddressedSession = { address: string; pid: number; session: SessionInfo };

export function addressedSessions(peer: { pid: number; list: readonly SessionInfo[] }): AddressedSession[] {
	return peer.list.map((session) => ({ address: peerAddress(peer.pid, session.sessionId, peer.list.length), pid: peer.pid, session }));
}

export type Target =
	| { kind: "found"; target: AddressedSession }
	| { kind: "not_found"; online: readonly string[] }
	| { kind: "ambiguous"; candidates: readonly string[] }
	| { kind: "unlisted"; reason: string }
	| { kind: "failed"; failure: ExchangeFailure };

/**
 * Ask the addressed process which main sessions it hosts now, so `<pid>` follows `/new` and resume.
 * A pid without an endpoint is not found; an endpoint that does not answer reports how the exchange failed.
 */
export async function resolveTarget(dir: string, address: PeerAddress, signal?: AbortSignal): Promise<Target> {
	if (!(await endpointPids(dir)).includes(address.pid)) return { kind: "not_found", online: await onlineAddresses(dir) };
	const listed = await exchange(dir, address.pid, { v: 1, kind: "list" }, LIST_TIMEOUT_MS, signal);
	if (listed.kind !== "response") return { kind: "failed", failure: listed };
	const known = sessionsOf(listed.response);
	if (known.kind === "unlisted") return known;
	const sessions = addressedSessions({ pid: address.pid, list: known.list });
	if (address.sessionId !== undefined) {
		const exact = sessions.find((candidate) => candidate.session.sessionId === address.sessionId);
		return exact === undefined ? { kind: "not_found", online: await onlineAddresses(dir) } : { kind: "found", target: exact };
	}
	const [only, ...rest] = sessions;
	if (only === undefined) return { kind: "not_found", online: await onlineAddresses(dir) };
	if (rest.length > 0) return { kind: "ambiguous", candidates: sessions.map((candidate) => candidate.address) };
	return { kind: "found", target: only };
}

async function onlineAddresses(dir: string): Promise<string[]> {
	const addresses: string[] = [];
	for (const peer of await survey(dir)) {
		if (peer.sessions.kind === "listed")
			addresses.push(...addressedSessions({ pid: peer.pid, list: peer.sessions.list }).map((s) => s.address));
	}
	return addresses;
}
