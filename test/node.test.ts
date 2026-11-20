import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchange, parseAddress, resolveTarget, survey } from "../src/client.ts";
import type * as NodeModule from "../src/node.ts";
import { type AskOutcome, endpointFor, type LocalMain, node, PeerNode, WAKE_BUDGET } from "../src/node.ts";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, type Sender, truncateUtf8, type WireRequest } from "../src/protocol.ts";

const DIR = join(mkdtempSync(join(tmpdir(), "omp-peers-node-")), "peers");
const peers = new PeerNode(DIR);

const FROM = { pid: 1, sessionId: "asker", cwd: "/tmp" } satisfies Extract<WireRequest, { kind: "ask" }>["from"];

type FakeMain = LocalMain & { asked: string[]; delivered: string[]; askSenders: Sender[]; deliverySenders: Sender[] };

function fakeMain(agentId: string, sessionId: string, answer: (question: string, signal: AbortSignal) => Promise<AskOutcome>): FakeMain {
	const asked: string[] = [];
	const delivered: string[] = [];
	const askSenders: Sender[] = [];
	const deliverySenders: Sender[] = [];
	return {
		agentId,
		sessionId: () => sessionId,
		title: () => `title of ${sessionId}`,
		cwd: () => "/work",
		idle: () => true,
		ask: (question, from, signal) => {
			asked.push(question);
			askSenders.push(from);
			return answer(question, signal);
		},
		deliver: (message, from) => {
			delivered.push(message);
			deliverySenders.push(from);
			return "idle";
		},
		stop: () => {},
		asked,
		delivered,
		askSenders,
		deliverySenders,
	};
}

const answering = (text: string) => async (): Promise<AskOutcome> => ({ kind: "answer", text, truncated: false });

let warnings: string[] = [];
const warn = (message: string, error: unknown): void => {
	warnings.push(`${message}: ${String(error)}`);
};

let added: string[] = [];
async function add(main: LocalMain): Promise<void> {
	added.push(main.agentId);
	await peers.add(main, warn);
}

afterEach(async () => {
	for (const agentId of added) await peers.remove(agentId);
	added = [];
	expect(warnings).toEqual([]);
	warnings = [];
});

describe("node lifecycle", () => {
	test("the endpoint is open while a main session is registered and closes with the last one", async () => {
		await add(fakeMain("Main", "s-1", answering("x")));
		await add(fakeMain("acp:2", "s-2", answering("y")));
		const both = await survey(DIR);
		expect(both).toEqual([
			{
				pid: process.pid,
				sessions: {
					kind: "listed",
					list: [
						{ sessionId: "s-1", title: "title of s-1", cwd: "/work", idle: true },
						{ sessionId: "s-2", title: "title of s-2", cwd: "/work", idle: true },
					],
				},
			},
		]);

		await peers.remove("Main");
		const one = await survey(DIR);
		expect(one[0]?.sessions).toEqual({ kind: "listed", list: [{ sessionId: "s-2", title: "title of s-2", cwd: "/work", idle: true }] });

		await peers.remove("acp:2");
		expect(await survey(DIR)).toEqual([]);
		const after = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "list" }, 1_000);
		expect(after.kind).toBe("unreachable");
	});

	test("an endpoint file without a listener is not a peer", async () => {
		mkdirSync(DIR, { recursive: true });
		writeFileSync(join(DIR, "999999.sock"), "");
		expect(await survey(DIR)).toEqual([]);
	});

	test.skipIf(process.platform === "win32")("a parent directory other users can enter is refused and no endpoint opens", async () => {
		const open = mkdtempSync(join(tmpdir(), "omp-peers-open-"));
		chmodSync(open, 0o755);
		const dir = join(open, "peers");
		const exposed = new PeerNode(dir);
		const refusals: string[] = [];
		await exposed.add(fakeMain("Main", "s-1", answering("x")), (message, error) => refusals.push(`${message}: ${String(error)}`));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("must be a directory owned by uid");
		expect(existsSync(endpointFor(dir, process.pid))).toBe(false);
		await exposed.remove("Main");
	});

	test("every evaluation of the node module in one process shares one node", async () => {
		const again: typeof NodeModule = await import(`../src/node.ts?evaluation=${Date.now()}`);
		expect(again.node).toBe(node);
	});
});

describe("transport limits", () => {
	test("a request line over the frame cap closes the connection before it is parsed", async () => {
		const main = fakeMain("Main", "s-1", answering("x"));
		await add(main);
		const huge = "x".repeat(MAX_FRAME_BYTES + 1);
		const result = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from: FROM, question: huge }, 5_000);
		expect(result.kind).toBe("closed");
		expect(main.asked).toEqual([]);
	});
});

describe("requests", () => {
	test("ask and irc reach the session named by id, and only that one", async () => {
		const first = fakeMain("Main", "s-1", answering("first answer"));
		const second = fakeMain("acp:2", "s-2", answering("second answer"));
		await add(first);
		await add(second);

		const asked = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-2", from: FROM, question: "q?" }, 1_000);
		expect(asked).toEqual({ kind: "response", response: { kind: "answer", text: "second answer", truncated: false } });
		expect(second.asked).toEqual(["q?"]);
		expect(first.asked).toEqual([]);

		const sent = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "s-1", from: FROM, message: "hello" }, 1_000);
		expect(sent).toEqual({ kind: "response", response: { kind: "accepted", recipient: "idle" } });
		expect(first.delivered).toEqual(["hello"]);
		expect(second.delivered).toEqual([]);

		const missing = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "gone", from: FROM, message: "hello" }, 1_000);
		expect(missing.kind === "response" && missing.response.kind === "error" && missing.response.code).toBe("target_not_found");
	});

	test("a caller that hangs up aborts the side question", async () => {
		const { promise: aborted, resolve } = Promise.withResolvers<boolean>();
		await add(
			fakeMain("Main", "s-1", (_question, signal) => {
				signal.addEventListener("abort", () => resolve(true), { once: true });
				return new Promise<AskOutcome>(() => {});
			}),
		);
		const result = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from: FROM, question: "slow?" }, 200);
		expect(result).toEqual({ kind: "timeout", ms: 200 });
		expect(await aborted).toBe(true);
	});
});

describe("wake budget", () => {
	test("one source process gets its first messages delivered, the next refused, and side questions still answered", async () => {
		const main = fakeMain("Main", "s-1", answering("still here"));
		await add(main);
		const from = { ...FROM, pid: 424242 };
		for (let i = 0; i < WAKE_BUDGET; i++) {
			const sent = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "s-1", from, message: `m${i}` }, 1_000);
			expect(sent).toEqual({ kind: "response", response: { kind: "accepted", recipient: "idle" } });
		}
		const over = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "s-1", from, message: "one more" }, 1_000);
		expect(over.kind === "response" && over.response.kind === "error" && over.response.code).toBe("budget_exceeded");
		expect(main.delivered).toHaveLength(WAKE_BUDGET);
		expect(main.delivered).not.toContain("one more");

		const other = await exchange(
			DIR,
			process.pid,
			{ v: PROTOCOL_VERSION, kind: "irc", to: "s-1", from: { ...FROM, pid: 434343 }, message: "x" },
			1_000,
		);
		expect(other).toEqual({ kind: "response", response: { kind: "accepted", recipient: "idle" } });
		const asked = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from, question: "q?" }, 1_000);
		expect(asked).toEqual({ kind: "response", response: { kind: "answer", text: "still here", truncated: false } });
	});
});

describe("peer addresses", () => {
	test("parse <pid> and <pid>/<sessionId>, nothing else", () => {
		expect(parseAddress("123", "")).toEqual({ pid: 123, sessionId: undefined });
		expect(parseAddress("123", "/s%2F1")).toEqual({ pid: 123, sessionId: "s/1" });
		for (const [host, path] of [
			["", ""],
			["0", ""],
			["12a", ""],
			["0123", ""],
			["123", "/a/b"],
			["123", "/%E0%A4%A"],
		]) {
			expect(parseAddress(host ?? "", path ?? "")).toBeUndefined();
		}
	});

	test("<pid> reaches a process's only main session; several sessions make it ambiguous and <pid>/<sessionId> picks one", async () => {
		await add(fakeMain("Main", "s-1", answering("x")));
		const single = await resolveTarget(DIR, { pid: process.pid, sessionId: undefined });
		expect(single.kind === "found" && single.target.address).toBe(String(process.pid));

		await add(fakeMain("acp:2", "s-2", answering("y")));
		expect(await resolveTarget(DIR, { pid: process.pid, sessionId: undefined })).toEqual({
			kind: "ambiguous",
			candidates: [`${process.pid}/s-1`, `${process.pid}/s-2`],
		});
		const picked = await resolveTarget(DIR, { pid: process.pid, sessionId: "s-2" });
		expect(picked.kind === "found" && picked.target.address).toBe(`${process.pid}/s-2`);

		expect(await resolveTarget(DIR, { pid: process.pid, sessionId: "gone" })).toEqual({
			kind: "not_found",
			online: [`${process.pid}/s-1`, `${process.pid}/s-2`],
		});
		expect(await resolveTarget(DIR, { pid: 999_999_999, sessionId: undefined })).toEqual({
			kind: "not_found",
			online: [`${process.pid}/s-1`, `${process.pid}/s-2`],
		});
	});
});

describe("request parsing at the endpoint", () => {
	test("legacy senders parse as main and subagent senders retain their identity through ask and irc delivery", async () => {
		const main = fakeMain("Main", "s-1", answering("answer"));
		await add(main);
		const subagent = { ...FROM, subagent: "AreaManager" };
		for (const from of [FROM, subagent]) {
			expect(await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from, question: "identity?" }, 1_000)).toEqual(
				{ kind: "response", response: { kind: "answer", text: "answer", truncated: false } },
			);
			expect(await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "s-1", from, message: "identity" }, 1_000)).toEqual({
				kind: "response",
				response: { kind: "accepted", recipient: "idle" },
			});
		}
		const expected: Sender[] = [
			{ kind: "main", address: String(FROM.pid), ...FROM },
			{ kind: "sub", agentId: "AreaManager", ...FROM },
		];
		expect(main.askSenders).toEqual(expected);
		expect(main.deliverySenders).toEqual(expected);
	});

	test("a request from another protocol version or with a missing field is refused, not served", async () => {
		const main = fakeMain("Main", "s-1", answering("x"));
		await add(main);
		const later = await exchange(DIR, process.pid, { v: 2, kind: "list" } as never, 1_000);
		expect(later.kind === "response" && later.response.kind === "error" && later.response.code).toBe("unsupported_version");
		const missing = await exchange(DIR, process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from: FROM } as never, 1_000);
		expect(missing.kind === "response" && missing.response.kind === "error" && missing.response.code).toBe("bad_request");
		expect(main.asked).toEqual([]);
	});
});

describe("truncateUtf8", () => {
	test("cuts on a character boundary and reports the cut", () => {
		expect(truncateUtf8("éé", 3)).toEqual({ text: "é", truncated: true });
		expect(truncateUtf8("éé", 4)).toEqual({ text: "éé", truncated: false });
	});

	test("a cut landing inside a character decodes to the replacement char, like the whole-string cut did", () => {
		expect(truncateUtf8("é", 1)).toEqual({ text: "", truncated: true });
		expect(truncateUtf8("é中", 2)).toEqual({ text: "é", truncated: true });
	});

	test("a four-byte character too wide for the cap truncates to the prefix before it", () => {
		expect(truncateUtf8("a🜛", 4)).toEqual({ text: "a", truncated: true });
		expect(truncateUtf8("🜛", 3)).toEqual({ text: "", truncated: true });
	});

	test("a character starting exactly at the cut is left to the tail, structurally", () => {
		expect(truncateUtf8("a中", 4)).toEqual({ text: "a中", truncated: false });
		expect(truncateUtf8("中a中", 6)).toEqual({ text: "中a", truncated: true });
	});

	test("a lone surrogate and a leading BOM behave like an encode round trip", () => {
		expect(truncateUtf8("\uD800", 4)).toEqual({ text: "\uD800", truncated: false });
		expect(truncateUtf8("\uD800", 5)).toEqual({ text: "\uD800", truncated: false });
		expect(truncateUtf8("\uFEFFx", 3)).toEqual({ text: "", truncated: true });
		expect(truncateUtf8("\uFEFFx", 2)).toEqual({ text: "", truncated: true });
		expect(truncateUtf8("\uFEFFx", 1)).toEqual({ text: "", truncated: true });
	});
});
