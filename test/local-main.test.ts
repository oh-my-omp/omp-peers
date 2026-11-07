import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { advisorToolIOTransform } from "@oh-my-pi/pi-coding-agent/advisor/delta-split";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { localMain } from "../src/local-main.ts";
import type { Sender } from "../src/protocol.ts";

type Sent = { customType: string; content: string; display: boolean; details: { from: string; message: string } };

const FROM: Sender = { kind: "main", pid: 7, sessionId: "sender", title: "peer", cwd: "/work" };
const SECRET = "ghp_0123456789abcdefABCDEF0123456789abcd";
/** A token-like secret longer than any summary, e.g. a JWT. */
const LONG_SECRET = `eyJhbGciOi.${"Qm9keQ".repeat(150)}.c2ln`;
const transform = advisorToolIOTransform(
	new SecretObfuscator([
		{ type: "plain", content: SECRET, mode: "replace", replacement: "[REDACTED]" },
		{ type: "plain", content: LONG_SECRET, mode: "replace", replacement: "[REDACTED-JWT]" },
	]),
	new Set(),
);

function deliver(message: string): Sent {
	const sent: Sent[] = [];
	const pi = { sendMessage: (msg: Sent) => sent.push(msg) };
	const ctx = { isIdle: () => true, agent: { id: "main" } };
	// Unchecked shims: `deliver` reaches only `sendMessage` and `isIdle`.
	const api = pi as unknown as ExtensionAPI;
	const context = ctx as unknown as ExtensionContext;
	localMain(api, context).deliver(message, FROM);
	const [only] = sent;
	if (only === undefined) throw new Error("deliver sent nothing");
	return only;
}

/** The host's session summary line for an `irc:incoming` entry whose `details.message` is `text`. */
function summaryLine(text: string, redact: boolean): string {
	const entry = {
		role: "custom",
		customType: "irc:incoming",
		content: "",
		display: true,
		details: { from: "peer", message: text },
		timestamp: 0,
	};
	return formatSessionHistoryMarkdown([entry], redact ? { transformExpandedToolIO: transform } : undefined);
}

const pad = (n: number): string => "w".repeat(n);
const CASES: Record<string, string> = {
	"one line": "hello there",
	"exactly 120 columns": pad(120),
	"121 columns": pad(121),
	"folded whitespace": `${pad(60)}\n\n\t  ${pad(70)}\n${pad(10)}`,
	"space at the cut": `${pad(119)} ${pad(40)} tail`,
	"word ending at the cut": `${pad(118)} ${pad(40)} tail`,
	"token across the cut": `${pad(100)} ${pad(60)} tail ${pad(30)}`,
	"secret across the cut": `${pad(100)} ${SECRET} and more words after it`,
	"secret before the cut": `${SECRET} ${pad(200)}`,
	"long secret across the cut": `${pad(100)} ${LONG_SECRET} tail`,
	"long secret alone": LONG_SECRET,
	"surrogate pair at the cut": `${pad(118)}🜛${pad(50)} tail`,
	"multi-line large": Array.from({ length: 2000 }, (_, i) => `line ${i} ${pad(i % 80)}`).join("\n"),
};

describe("deliver keeps one full copy of the message", () => {
	for (const [name, message] of Object.entries(CASES)) {
		test(name, () => {
			const sent = deliver(message);
			expect(sent.customType).toBe("irc:incoming");
			expect(sent.content).toContain(message);
			expect(sent.details.from).toBe("peer (pid 7)");
			expect(sent.details.message).not.toContain("\n");
			// Folded text up to the end of the word crossing column 119, then " …".
			const longestWord = Math.max(...message.split(/\s+/).map((w) => w.length));
			expect(sent.details.message.length).toBeLessThanOrEqual(120 + longestWord + 2);
			expect(summaryLine(sent.details.message, false)).toBe(summaryLine(message, false));
			expect(summaryLine(sent.details.message, true)).toBe(summaryLine(message, true));
		});
	}

	test("a long message keeps only a summary-sized second copy", () => {
		expect(deliver(CASES["multi-line large"] ?? "").details.message.length).toBeLessThan(140);
	});

	test("a secret straddling the summary cut stays redacted in the summary line", () => {
		for (const name of ["secret across the cut", "long secret across the cut", "long secret alone"]) {
			const line = summaryLine(deliver(CASES[name] ?? "").details.message, true);
			expect(line).not.toContain(SECRET.slice(0, 8));
			expect(line).not.toContain(LONG_SECRET.slice(0, 8));
		}
	});
});
