import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exchange, survey } from "../src/client.ts";
import { type AskOutcome, type LocalMain, node, peersDir } from "../src/node.ts";
import { PROTOCOL_VERSION, type Sender, truncateUtf8 } from "../src/protocol.ts";

const FROM: Sender = { pid: 1, sessionId: "asker", cwd: "/tmp" };

type FakeMain = LocalMain & { asked: string[]; delivered: string[] };

function fakeMain(agentId: string, sessionId: string, answer: (question: string, signal: AbortSignal) => Promise<AskOutcome>): FakeMain {
	const asked: string[] = [];
	const delivered: string[] = [];
	return {
		agentId,
		sessionId: () => sessionId,
		title: () => `title of ${sessionId}`,
		cwd: () => "/work",
		idle: () => true,
		ask: (question, _from, signal) => {
			asked.push(question);
			return answer(question, signal);
		},
		deliver: (message) => {
			delivered.push(message);
			return "idle";
		},
		stop: () => {},
		asked,
		delivered,
	};
}

const answering = (text: string) => async (): Promise<AskOutcome> => ({ kind: "answer", text, truncated: false });
const warn = (message: string, error: unknown): void => {
	throw new Error(`${message}: ${String(error)}`);
};

let added: string[] = [];
async function add(main: LocalMain): Promise<void> {
	added.push(main.agentId);
	await node.add(main, warn);
}

afterEach(async () => {
	for (const agentId of added) await node.remove(agentId);
	added = [];
});

describe("node lifecycle", () => {
	test("the endpoint is open while a main session is registered and closes with the last one", async () => {
		await add(fakeMain("Main", "s-1", answering("x")));
		await add(fakeMain("acp:2", "s-2", answering("y")));
		const both = await survey();
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

		await node.remove("Main");
		const one = await survey();
		expect(one[0]?.sessions).toEqual({ kind: "listed", list: [{ sessionId: "s-2", title: "title of s-2", cwd: "/work", idle: true }] });

		await node.remove("acp:2");
		expect(await survey()).toEqual([]);
		const after = await exchange(process.pid, { v: PROTOCOL_VERSION, kind: "list" }, 1_000);
		expect(after.kind).toBe("unreachable");
	});

	test("an endpoint file without a listener is not a peer", async () => {
		mkdirSync(peersDir(), { recursive: true });
		writeFileSync(join(peersDir(), "999999.sock"), "");
		expect(await survey()).toEqual([]);
	});
});

describe("requests", () => {
	test("ask and irc reach the session named by id, and only that one", async () => {
		const first = fakeMain("Main", "s-1", answering("first answer"));
		const second = fakeMain("acp:2", "s-2", answering("second answer"));
		await add(first);
		await add(second);

		const asked = await exchange(process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-2", from: FROM, question: "q?" }, 1_000);
		expect(asked).toEqual({ kind: "response", response: { kind: "answer", text: "second answer", truncated: false } });
		expect(second.asked).toEqual(["q?"]);
		expect(first.asked).toEqual([]);

		const sent = await exchange(process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "s-1", from: FROM, message: "hello" }, 1_000);
		expect(sent).toEqual({ kind: "response", response: { kind: "accepted", recipient: "idle" } });
		expect(first.delivered).toEqual(["hello"]);
		expect(second.delivered).toEqual([]);

		const missing = await exchange(process.pid, { v: PROTOCOL_VERSION, kind: "irc", to: "gone", from: FROM, message: "hello" }, 1_000);
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
		const result = await exchange(process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from: FROM, question: "slow?" }, 200);
		expect(result).toEqual({ kind: "timeout", ms: 200 });
		expect(await aborted).toBe(true);
	});
});

describe("request parsing at the endpoint", () => {
	test("a request from another protocol version or with a missing field is refused, not served", async () => {
		const main = fakeMain("Main", "s-1", answering("x"));
		await add(main);
		const later = await exchange(process.pid, { v: 2, kind: "list" } as never, 1_000);
		expect(later.kind === "response" && later.response.kind === "error" && later.response.code).toBe("unsupported_version");
		const missing = await exchange(process.pid, { v: PROTOCOL_VERSION, kind: "ask", to: "s-1", from: FROM } as never, 1_000);
		expect(missing.kind === "response" && missing.response.kind === "error" && missing.response.code).toBe("bad_request");
		expect(main.asked).toEqual([]);
	});
});

describe("truncateUtf8", () => {
	test("cuts on a character boundary and reports the cut", () => {
		// "é" is two UTF-8 bytes: a 3-byte cap must not split the second one.
		expect(truncateUtf8("éé", 3)).toEqual({ text: "é", truncated: true });
		expect(truncateUtf8("éé", 4)).toEqual({ text: "éé", truncated: false });
	});
});
