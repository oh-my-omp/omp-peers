import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { advisorToolIOTransform } from "@oh-my-pi/pi-coding-agent/advisor/delta-split";
import { builtinCredentialSecretEntries } from "@oh-my-pi/pi-coding-agent/secrets/index";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { localMain } from "../src/local-main.ts";
import type { Sender } from "../src/protocol.ts";

type Sent = { customType: string; content: string; display: boolean; details: { from: string; message: string } };

const FROM: Sender = { kind: "main", pid: 7, sessionId: "sender", title: "peer", cwd: "/work" };
const pad = (n: number): string => "w".repeat(n);

// Secret shapes the advisor's redaction knows: configured literals (one with spaces), a configured
// regex that needs right-hand context, and the host's built-in credential patterns (JWT, PEM, ...).
const TOKEN = "zq_0123456789abcdefABCDEF0123456789abcd";
const SPACED = "correct horse battery staple";
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJ${"c3ViIjoiMTIzNDU2Nzg5MCJ9".repeat(40)}.${"c2lnbmF0dXJl".repeat(8)}`;
const PEM = [
	"-----BEGIN PRIVATE KEY-----",
	...Array.from({ length: 50 }, (_, i) => `MIIJQwIBADANBgkqhkiG9w0BAQEFAASCCS0wggkpAgEAAoICAQ${String(i).padStart(14, "0")}`),
	"-----END PRIVATE KEY-----",
].join("\n");
const transform = advisorToolIOTransform(
	new SecretObfuscator(
		[
			{ type: "plain", content: TOKEN, mode: "replace", replacement: "[TOKEN]" },
			{ type: "plain", content: SPACED, mode: "replace", replacement: "[SPACED]" },
			{ type: "regex", content: "S3CR3T(?= TAIL)", mode: "replace", replacement: "[AHEAD]" },
			...builtinCredentialSecretEntries(),
		],
		"local-main-test-key",
	),
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

const SECRET_CASES: Record<string, { message: string; secret: string }> = {
	"token across the cut": { message: `${pad(100)} ${TOKEN} and more words after it`, secret: TOKEN },
	"spaced secret across the cut": { message: `${pad(110)} ${SPACED} and more`, secret: SPACED },
	"secret needing right-hand context at the cut": { message: `${pad(117)} S3CR3T TAIL more`, secret: "S3CR3T" },
	"JWT across the cut": { message: `${pad(100)} ${JWT} tail`, secret: JWT },
	"PEM private key across the cut": { message: `${pad(100)} ${PEM}\ntail ${pad(5000)}`, secret: PEM },
};
const CASES: Record<string, string> = {
	"one line": "hello there",
	"exactly 120 columns": pad(120),
	"121 columns": pad(121),
	"folded whitespace": `${pad(60)}\n\n\t  ${pad(70)}\n${pad(10)}`,
	"space at the cut": `${pad(119)} ${pad(40)} tail`,
	"surrogate pair at the cut": `${pad(118)}🜛${pad(50)} tail`,
	"exactly 4096 columns": pad(4096),
	"word across the kept prefix": `${pad(4000)} ${pad(200)} tail`,
	"single 64 KiB token": pad(64 * 1024),
	"multi-line large": Array.from({ length: 2000 }, (_, i) => `line ${i} ${pad(i % 80)}`).join("\n"),
	...Object.fromEntries(Object.entries(SECRET_CASES).map(([name, c]) => [name, c.message])),
};

describe("deliver keeps the full message once, in content", () => {
	for (const [name, message] of Object.entries(CASES)) {
		test(name, () => {
			const sent = deliver(message);
			expect(sent.customType).toBe("irc:incoming");
			expect(sent.content).toContain(message);
			expect(sent.details.from).toBe("peer (pid 7)");
			expect(sent.details.message).not.toContain("\n");
			expect(sent.details.message.length).toBeLessThanOrEqual(4096 + 2);
			expect(summaryLine(sent.details.message, false)).toBe(summaryLine(message, false));
			expect(summaryLine(sent.details.message, true)).toBe(summaryLine(message, true));
		});
	}

	test("a long message keeps a bounded prefix as its second copy", () => {
		for (const name of ["single 64 KiB token", "multi-line large"]) {
			const message = CASES[name] ?? "";
			const summary = deliver(message).details.message;
			expect(summary.endsWith(" …")).toBe(true);
			expect(summary.length).toBeLessThanOrEqual(4096 + 2);
			expect(summary.length).toBeLessThan(message.length / 10);
		}
	});

	test("a secret crossing the summary line's cut stays redacted there", () => {
		for (const { message, secret } of Object.values(SECRET_CASES)) {
			const line = summaryLine(deliver(message).details.message, true);
			expect(line).not.toContain(secret.slice(0, 6));
		}
	});
});
