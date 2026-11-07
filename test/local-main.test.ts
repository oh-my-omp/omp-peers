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
const transform = advisorToolIOTransform(
	new SecretObfuscator([{ type: "plain", content: SECRET, mode: "replace", replacement: "[REDACTED]" }]),
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
	"token across the cut": `${pad(100)} ${pad(60)} tail ${pad(30)}`,
	"secret across the cut": `${pad(100)} ${SECRET} and more words after it`,
	"secret before the cut": `${SECRET} ${pad(200)}`,
	"token longer than the slack": `${pad(50)} ${pad(900)} tail`,
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
			expect(sent.details.message.length).toBeLessThanOrEqual(120 + 512 + 2);
			expect(summaryLine(sent.details.message, false)).toBe(summaryLine(message, false));
			expect(summaryLine(sent.details.message, true)).toBe(summaryLine(message, true));
		});
	}

	test("a secret straddling the summary cut stays redacted in the summary line", () => {
		const sent = deliver(CASES["secret across the cut"] ?? "");
		const line = summaryLine(sent.details.message, true);
		expect(line).not.toContain(SECRET.slice(0, 8));
	});
});
