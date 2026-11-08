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
// Credentials long enough to cross column 4096 of the folded message: a redaction that only saw a
// prefix cut there could not reach their end and would leave the beginning readable.
const LONG_PEM = ["-----BEGIN PRIVATE KEY-----", ...Array.from({ length: 110 }, () => "QUJD".repeat(16)), "-----END PRIVATE KEY-----"].join(
	"\n",
);
const LONG_JWT = `eyJhbGciOiJIUzI1NiJ9.eyJ${"U0VDUkVU".repeat(600)}.${"c2ln".repeat(10)}`;
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
	"PEM private key beyond 4096 columns": { message: `please use this key ${LONG_PEM} thanks`, secret: LONG_PEM },
	"JWT beyond 4096 columns": { message: `token ${LONG_JWT} end`, secret: LONG_JWT },
};
const CASES: Record<string, string> = {
	"one line": "hello there",
	"exactly 120 columns": pad(120),
	"121 columns": pad(121),
	"folded whitespace": `${pad(60)}\n\n\t  ${pad(70)}\n${pad(10)}`,
	"space at the cut": `${pad(119)} ${pad(40)} tail`,
	"surrogate pair at the cut": `${pad(118)}🜛${pad(50)} tail`,
	"surrogate pair at column 4096": `${pad(4095)}🜛 tail`,
	"single 64 KiB token": pad(64 * 1024),
	"empty message": "",
	"whitespace only": " \n\t\r\f\v ",
	"non-breaking space": `a\u00a0b${"\u00a0".repeat(3)}c`,
	"byte order mark": `a\ufeffb\ufeff\ufeffc`,
	"line and paragraph separators": `a\u2028b\u2029c`,
	"multi-line large": Array.from({ length: 2000 }, (_, i) => `line ${i} ${pad(i % 80)}`).join("\n"),
	...Object.fromEntries(Object.entries(SECRET_CASES).map(([name, c]) => [name, c.message])),
};

describe("deliver keeps the full message in content and its folded form in details.message", () => {
	for (const [name, message] of Object.entries(CASES)) {
		test(name, () => {
			const sent = deliver(message);
			expect(sent.customType).toBe("irc:incoming");
			expect(sent.content).toContain(message);
			expect(sent.details.from).toBe("peer (pid 7)");
			// Folded, whole and well formed: the host redacts the full text before it previews the entry,
			// so a cut here would leave a credential fragment it can no longer recognize.
			expect(sent.details.message).toBe(message.replace(/\s+/g, " ").trim());
			expect(sent.details.message).not.toContain("\n");
			expect(sent.details.message.endsWith(" …")).toBe(false);
			expect(sent.details.message.isWellFormed()).toBe(true);
			expect(summaryLine(sent.details.message, false)).toBe(summaryLine(message, false));
			expect(summaryLine(sent.details.message, true)).toBe(summaryLine(message, true));
		});
	}

	test("a secret crossing the summary line's cut stays redacted there", () => {
		for (const { message, secret } of Object.values(SECRET_CASES)) {
			const line = summaryLine(deliver(message).details.message, true);
			expect(line).not.toContain(secret.slice(0, 6));
		}
	});
});
