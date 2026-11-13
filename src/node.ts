// The process-level node: one IPC endpoint per omp process, `ipcEndpoint(<peers dir>, <pid>)`, serving every
// main session of the process that registered with it. The endpoint is open exactly while at least one
// main session is registered; `reconcile` moves the listener to that state after every change.
//
// omp evaluates this module again for each ACP session, so module scope is not process scope: the node
// lives on `globalThis.ompPeersNode`, and every evaluation in the process shares it.
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { errorText } from "./errors.ts";
import { MAX_FRAME_BYTES, parseRequest, type Request, type Response, type Sender, type SessionInfo } from "./protocol.ts";

/**
 * The directory every endpoint of this user is scoped to, per user and profile-independent.
 *
 * POSIX: `/tmp/omp-<uid>/peers`, holding the `<pid>.sock` files and emptied at boot like every endpoint in
 * it (no endpoint outlives its process, and no process outlives the boot). `/tmp/omp-<uid>` is also where
 * the host's `ipcEndpoint` puts sockets whose path is too long.
 *
 * Windows: `<user temp>\omp-peers`, under the user's profile. Endpoints are named pipes outside the file
 * system, `\\.\pipe\omp-<pid>-<hash of this path>`, so the path only scopes the pipe names to the user. It
 * is the real path of the temp directory, so a process that sees it under its 8.3 short name computes the
 * same names.
 */
export function peersDir(): string {
	if (process.platform === "win32") return path.join(realpathSync.native(os.tmpdir()), "omp-peers");
	return path.join("/tmp", `omp-${os.userInfo().uid}`, "peers");
}

export function endpointFor(dir: string, pid: number): string {
	return ipcEndpoint(dir, String(pid));
}

/**
 * POSIX only. Create the parent of `dir` if missing and refuse it unless this user owns it with mode 0700:
 * under the world-writable `/tmp`, another user could create it first and then remove or replace endpoints
 * in it. Windows has no endpoint files to protect, and its uid and mode bits do not describe ownership.
 */
async function claimPrivateParent(dir: string): Promise<void> {
	const parent = path.dirname(dir);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(parent);
	const uid = os.userInfo().uid;
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(
			`${parent} must be a directory owned by uid ${uid} with mode 0700; found uid ${stat.uid}, mode ${(stat.mode & 0o777).toString(8)}`,
		);
	}
}

export type AskOutcome =
	| { kind: "answer"; text: string; truncated: boolean }
	| { kind: "busy" }
	| { kind: "unsupported" }
	| { kind: "failed"; message: string };

/** A main session of this process. Identity and state are read live, so `/new` and resume need no re-registration. */
export interface LocalMain {
	/** Registry id, stable for the lifetime of the session runtime: `Main`, or `acp:<id>` under ACP. */
	readonly agentId: string;
	sessionId(): string;
	title(): string | undefined;
	cwd(): string;
	idle(): boolean;
	/** Answer a side question without touching the main turn or transcript. */
	ask(question: string, from: Sender, signal: AbortSignal): Promise<AskOutcome>;
	/** Inject an IRC message into the main session; returns its state at injection. */
	deliver(message: string, from: Sender): "idle" | "busy";
	/** Abort an in-flight side question; called when the session leaves the node. */
	stop(): void;
}

export type Warn = (message: string, error: unknown) => void;

/** One process's endpoint and its registered main sessions. Tests build their own on a private directory. */
export class PeerNode {
	readonly #dir: string;
	readonly #mains = new Map<string, LocalMain>();
	#server: IpcServer | undefined;
	#reconciling: Promise<void> = Promise.resolve();
	#warn: Warn = () => {};

	constructor(dir: string) {
		this.#dir = dir;
	}

	/** Register a main session (replacing one with the same agent id) and open the endpoint if needed. */
	add(main: LocalMain, warn: Warn): Promise<void> {
		this.#warn = warn;
		this.#mains.get(main.agentId)?.stop();
		this.#mains.set(main.agentId, main);
		return this.#schedule();
	}

	/** Unregister a main session; the last one out closes the endpoint. Idempotent. */
	remove(agentId: string): Promise<void> {
		const main = this.#mains.get(agentId);
		if (main === undefined) return this.#reconciling;
		main.stop();
		this.#mains.delete(agentId);
		return this.#schedule();
	}

	#schedule(): Promise<void> {
		this.#reconciling = this.#reconciling.then(() => this.#reconcile());
		return this.#reconciling;
	}

	async #reconcile(): Promise<void> {
		try {
			if (this.#mains.size > 0 && this.#server === undefined) {
				if (process.platform !== "win32") await claimPrivateParent(this.#dir);
				const server = await IpcServer.listen(
					endpointFor(this.#dir, process.pid),
					{ framing: "lines", maxFrameBytes: MAX_FRAME_BYTES },
					(connection) => this.#accept(connection),
				);
				// The endpoint never keeps omp alive; omp's own exit path closes it.
				server.unref();
				this.#server = server;
			} else if (this.#mains.size === 0 && this.#server !== undefined) {
				const server = this.#server;
				this.#server = undefined;
				await server.close();
			}
		} catch (error) {
			this.#warn("omp-peers endpoint change failed", error);
		}
	}

	#accept(connection: IpcConnection): void {
		connection.unref();
		const closed = new AbortController();
		let answered = false;
		connection.start(
			(line) => {
				if (answered) return;
				answered = true;
				void this.#respond(line, closed.signal).then((response) => {
					connection.send(JSON.stringify(response));
					connection.end();
				});
			},
			() => closed.abort(),
		);
	}

	async #respond(line: string, closed: AbortSignal): Promise<Response> {
		const parsed = parseRequest(line);
		if (parsed.kind === "invalid") return { kind: "error", code: parsed.code, message: parsed.message };
		try {
			return await this.#serve(parsed.value, closed);
		} catch (error) {
			this.#warn("omp-peers request failed", error);
			return { kind: "error", code: parsed.value.kind === "irc" ? "delivery_failed" : "ask_failed", message: errorText(error) };
		}
	}

	async #serve(request: Request, closed: AbortSignal): Promise<Response> {
		switch (request.kind) {
			case "list":
				return { kind: "sessions", pid: process.pid, sessions: [...this.#mains.values()].map(sessionInfo) };
			case "ask": {
				const main = this.#target(request.to);
				if (main === undefined) return notFound(request.to);
				const outcome = await main.ask(request.question, request.from, closed);
				switch (outcome.kind) {
					case "answer":
						return { kind: "answer", text: outcome.text, truncated: outcome.truncated };
					case "busy":
						return { kind: "error", code: "ask_busy", message: "this session is already answering another side question" };
					case "unsupported":
						return { kind: "error", code: "ask_unsupported", message: "this omp provides no side turns (runEphemeralTurn)" };
					case "failed":
						return { kind: "error", code: "ask_failed", message: outcome.message };
				}
				return assertNever(outcome);
			}
			case "irc": {
				const main = this.#target(request.to);
				if (main === undefined) return notFound(request.to);
				return { kind: "accepted", recipient: main.deliver(request.message, request.from) };
			}
		}
		return assertNever(request);
	}

	#target(sessionId: string): LocalMain | undefined {
		for (const main of this.#mains.values()) if (main.sessionId() === sessionId) return main;
		return undefined;
	}
}

function sessionInfo(main: LocalMain): SessionInfo {
	return { sessionId: main.sessionId(), title: main.title(), cwd: main.cwd(), idle: main.idle() };
}

function notFound(sessionId: string): Response {
	return { kind: "error", code: "target_not_found", message: `no main session ${sessionId} in pid ${process.pid}` };
}

function assertNever(value: never): never {
	throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

declare global {
	/** omp-peers' process node, shared by every evaluation of this module in the process. */
	var ompPeersNode: PeerNode | undefined;
}

globalThis.ompPeersNode ??= new PeerNode(peersDir());

/** The one node of this process, whichever evaluation of this module created it. */
export const node: PeerNode = globalThis.ompPeersNode;
