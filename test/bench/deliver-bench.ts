// Bench + equivalence harness for the issue-7 deliver fix (child B of omp-peers#5).
// Synthetic messages per tree-root §4: three tiers — short (one line), medium (~4 KiB) and near the
// 64 KiB message cap — from a seeded deterministic generator with a controlled multi-byte ratio.
// The medium and large tiers put a configured secret across the host's 120-column summary cut, so
// the redaction path of the summary line is exercised too.
//
// Each tier goes through `localMain(pi, ctx).deliver` of the checkout under test. `pi.sendMessage`
// is backed by a real host `SessionManager` the way the host persists a custom message
// (`appendCustomMessageEntry(customType, content, display, details)`); the session file is then
// closed, reopened from disk and replayed through the host's own renderers: the session summary
// line (`formatSessionHistoryMarkdown`, plain and with the advisor redaction transform) and the
// transcript card (pi-tui `buildIrcMessageCard`). All host state lives under a fresh /tmp directory.
//
// Usage:
//   bun test/bench/deliver-bench.ts [--src <dir>] [--dump <out.json>] [--compare <baseline.json>]
//                                   [--keep-session <out.jsonl>] [--legacy <session.jsonl>]
//   --src           the `src/` directory whose local-main.ts is measured (default: this checkout)
//   --dump          write this run's records for a cross-commit comparison
//   --compare       compare this run's records with a baseline dump; prints byte, content, render
//                   and field-diff lines and exits non-zero on any violation
//   --keep-session  copy the large tier's session file here (a baseline-written session)
//   --legacy        open a session file written by another checkout, render it, deliver one more
//                   message with this checkout into the same file and reopen it
//
// Metrics per tier: persisted entry bytes (the JSONL line), heap growth retained per deliver once
// the entries are written, and heap growth per entry of reopening the session (heapUsed after
// Bun.gc(true) over a batch of deliveries, median of ROUNDS rounds).
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionManager as SessionManagerT } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as LocalMainModule from "../../src/local-main.ts";
import type { Sender } from "../../src/protocol.ts";

const work = mkdtempSync("/tmp/peers-deliver-bench-");
// Host modules resolve their agent directory from this variable; keep every write inside `work`.
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
// Host modules are imported only after PI_CODING_AGENT_DIR is set: a static import would evaluate
// them (and resolve their directories) before this module's first statement runs.
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
const { formatSessionHistoryMarkdown } = await import("@oh-my-pi/pi-coding-agent/session/session-history-format");
const { SecretObfuscator } = await import("@oh-my-pi/pi-coding-agent/secrets/obfuscator");
const { advisorToolIOTransform } = await import("@oh-my-pi/pi-coding-agent/advisor/delta-split");
const { buildIrcMessageCard } = await import("@oh-my-pi/pi-tui/chat/transcript-render-helpers");
const { loadThemeSync } = await import("@oh-my-pi/pi-tui/theme/loader");
const { setThemeInstance } = await import("@oh-my-pi/pi-tui/theme/theme");

type IrcMessage = Extract<AgentMessage, { role: "custom" }>;

const { values: args } = parseArgs({
	options: {
		src: { type: "string" },
		dump: { type: "string" },
		compare: { type: "string" },
		"keep-session": { type: "string" },
		legacy: { type: "string" },
	},
});
const srcDir = resolve(args.src ?? join(import.meta.dir, "../../src"));
// Runtime-selected: --src points at the checkout under test (baseline or change).
const { localMain }: typeof LocalMainModule = await import(join(srcDir, "local-main.ts"));

setThemeInstance(loadThemeSync("dark"));

const ROUNDS = 5;
const CARD_WIDTH = 100;
const SECRET = "sk-bench-7f3a9c2e5b8d1f4a6c0e9b2d7a5f3c1e8b6d4a2f";
const transform = advisorToolIOTransform(
	new SecretObfuscator([{ type: "plain", content: SECRET, mode: "replace", replacement: "[REDACTED]" }]),
	new Set(),
);
const SENDER: Sender = { kind: "main", pid: 4242, sessionId: "bench-sender", title: "bench sender", cwd: "/tmp/bench" };

/** Deterministic LCG; the seeds below are fixed and used only here. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const CHARS = "abcdefghijklmnopqrstuvwxyz";
const MBC = ["é", "中", "語", "ü"];

function word(rand: () => number): string {
	const n = 2 + Math.floor(rand() * 9);
	let w = "";
	for (let i = 0; i < n; i++) w += rand() < 0.05 ? MBC[Math.floor(rand() * MBC.length)] : CHARS[Math.floor(rand() * CHARS.length)];
	return w;
}

/** Lines of seeded words, about `bytes` UTF-8 bytes; `secret` lands across folded column 119. */
function message(bytes: number, seed: number, secret: boolean): string {
	const rand = lcg(seed);
	const lines: string[] = [];
	let first = "";
	while (first.length < 104) first += `${word(rand)} `;
	const head = secret ? `${first.slice(0, 104)} ${SECRET} tail` : first.trimEnd();
	lines.push(head);
	let size = Buffer.byteLength(head);
	while (size < bytes) {
		let line = "";
		const width = 40 + Math.floor(rand() * 50);
		while (line.length < width) line += `${word(rand)} `;
		line = line.trimEnd();
		if (size + Buffer.byteLength(line) + 1 > bytes) break;
		const next = rand() < 0.1 ? "" : line;
		lines.push(next);
		size += Buffer.byteLength(next) + 1;
	}
	return lines.join("\n");
}

type Tier = { name: string; make: () => string };
const TIERS: Tier[] = [
	{ name: "short", make: () => "ping from the bench: are you there? 中文也行" },
	{ name: "medium-4k", make: () => message(4 * 1024, 0x7e5a1, true) },
	{ name: "large-64k", make: () => message(63 * 1024, 0x7e5a2, true) },
];

type EntryFields = { customType: unknown; content: unknown; display: unknown; details: unknown; attribution: unknown };
type TierRecord = {
	name: string;
	messageChars: number;
	messageBytes: number;
	entryBytes: number;
	heapDeliver: number;
	heapReload: number;
	entry: EntryFields;
	summaryPlain: string;
	summaryRedacted: string;
	cardCollapsed: string[];
	cardExpanded: string[];
};

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function heap(): number {
	Bun.gc(true);
	return process.memoryUsage().heapUsed;
}

/** `deliver` of the checkout under test, persisting into `sm` the way the host persists a custom message. */
function deliverInto(sm: SessionManagerT): (message: string) => void {
	const pi = {
		sendMessage: (msg: { customType: string; content: string; display: boolean; details?: unknown }) => {
			sm.appendCustomMessageEntry(msg.customType, msg.content, msg.display, msg.details);
		},
	};
	const ctx = { isIdle: () => true, agent: { id: "bench" }, sessionManager: sm };
	// Unchecked shims: they carry only what `deliver` reaches; the real host objects are far larger.
	const api = pi as unknown as ExtensionAPI;
	const context = ctx as unknown as ExtensionContext;
	const main = localMain(api, context);
	return (message) => main.deliver(message, SENDER);
}

/** `details.message` of a persisted or reopened entry, "" when absent. */
function detailsMessage(details: unknown): string {
	if (typeof details !== "object" || details === null || !("message" in details)) return "";
	return typeof details.message === "string" ? details.message : "";
}

function render(message: IrcMessage): Pick<TierRecord, "summaryPlain" | "summaryRedacted" | "cardCollapsed" | "cardExpanded"> {
	const card = (expanded: boolean) =>
		buildIrcMessageCard({ ...message, timestamp: 0 }, () => expanded)
			.render(CARD_WIDTH)
			.map((row) => Bun.stripANSI(row).trimEnd());
	return {
		summaryPlain: formatSessionHistoryMarkdown([message]).trim(),
		summaryRedacted: formatSessionHistoryMarkdown([message], { transformExpandedToolIO: transform }).trim(),
		cardCollapsed: card(false),
		cardExpanded: card(true),
	};
}

function ircMessages(sm: SessionManagerT): IrcMessage[] {
	return sm.buildSessionContext().messages.filter((m): m is IrcMessage => m.role === "custom" && m.customType === "irc:incoming");
}

async function measure(tier: Tier): Promise<TierRecord> {
	const text = tier.make();
	// One entry for the byte count, the field diff and the render replay.
	const singleDir = mkdtempSync(join(work, "session-"));
	const single = SessionManager.create(singleDir, singleDir);
	await single.ensureOnDisk();
	deliverInto(single)(text);
	await single.flush();
	const file = single.getSessionFile() ?? "";
	await single.close();
	// Heap readings move by tens of KiB between GCs; a batch of deliveries per reading (about 512 KiB
	// of messages) keeps that noise small per message. Every session stays open until all rounds are
	// read: memory a dropped session frees is swept lazily and would offset a later round's reading.
	const batch = Math.min(200, Math.ceil((512 * 1024) / Buffer.byteLength(text)));
	const deliverHeap: number[] = [];
	const reloadHeap: number[] = [];
	const open: SessionManagerT[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		const dir = mkdtempSync(join(work, "session-"));
		const sm = SessionManager.create(dir, dir);
		open.push(sm);
		await sm.ensureOnDisk();
		const deliver = deliverInto(sm);
		const before = heap();
		// Messages are built inside the measured window so only the session's references keep them;
		// the reading is taken once the entries are written, the state the session then keeps.
		for (let i = 0; i < batch; i++) deliver(tier.make());
		await sm.flush();
		deliverHeap.push(Math.round((heap() - before) / batch));
		const beforeReload = heap();
		const reopened = await SessionManager.open(sm.getSessionFile() ?? "");
		reloadHeap.push(Math.round((heap() - beforeReload) / batch));
		open.push(reopened);
	}
	for (const sm of open) await sm.close();
	const line = readFileSync(file, "utf8")
		.split("\n")
		.find((l) => l.includes('"customType":"irc:incoming"'));
	if (line === undefined) throw new Error(`${tier.name}: no irc:incoming entry in ${file}`);
	const raw = JSON.parse(line) as Record<string, unknown>;
	const reopened = await SessionManager.open(file);
	const [message] = ircMessages(reopened);
	await reopened.close();
	if (message === undefined) throw new Error(`${tier.name}: reopened session has no irc:incoming message`);
	if (tier.name === "large-64k" && args["keep-session"] !== undefined) copyFileSync(file, args["keep-session"]);
	return {
		name: tier.name,
		messageChars: text.length,
		messageBytes: Buffer.byteLength(text),
		entryBytes: Buffer.byteLength(line) + 1,
		heapDeliver: median(deliverHeap),
		heapReload: median(reloadHeap),
		entry: {
			customType: raw.customType,
			content: raw.content,
			display: raw.display,
			details: raw.details,
			attribution: raw.attribution,
		},
		...render(message),
	};
}

/** Paths (dotted) whose JSON values differ between two field sets. */
function diffPaths(a: unknown, b: unknown, path = ""): string[] {
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
		const left = new Map(Object.entries(a));
		const right = new Map(Object.entries(b));
		const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
		return keys.flatMap((k) => diffPaths(left.get(k), right.get(k), path === "" ? k : `${path}.${k}`));
	}
	return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

const failures: string[] = [];
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures.push(label);
}

if (args.legacy !== undefined) {
	// Row 5: a session written by another checkout opens, renders, and keeps taking deliveries here.
	const legacyCopy = join(mkdtempSync(join(work, "legacy-")), "legacy.jsonl");
	copyFileSync(args.legacy, legacyCopy);
	const opened = await SessionManager.open(legacyCopy);
	const [old] = ircMessages(opened);
	if (old === undefined) throw new Error(`${args.legacy}: no irc:incoming entry`);
	const legacyText = detailsMessage(old.details);
	const oldRender = render(old);
	console.log(`legacy entry: details.message ${legacyText.length} chars`);
	console.log(`legacy summary: ${oldRender.summaryPlain}`);
	console.log(`legacy card (expanded, ${oldRender.cardExpanded.length} rows):\n${oldRender.cardExpanded.join("\n")}`);
	check(
		typeof old.content === "string" && legacyText.length > 0 && old.content.includes(legacyText),
		"legacy entry: full message still present in the model-visible content",
	);
	if (args.compare !== undefined) {
		const baseline: TierRecord[] = JSON.parse(readFileSync(args.compare, "utf8"));
		const written = baseline.find((b) => b.name === "large-64k");
		check(
			written !== undefined &&
				JSON.stringify(oldRender) ===
					JSON.stringify({
						summaryPlain: written.summaryPlain,
						summaryRedacted: written.summaryRedacted,
						cardCollapsed: written.cardCollapsed,
						cardExpanded: written.cardExpanded,
					}),
			"legacy entry renders here exactly as its writing checkout rendered it (summary, redacted summary, both card states)",
		);
	}
	deliverInto(opened)("follow-up after reopening the legacy session");
	await opened.flush();
	await opened.close();
	const again = await SessionManager.open(legacyCopy);
	const both = ircMessages(again);
	await again.close();
	check(both.length === 2, `reopened legacy session holds both deliveries (${both.length})`);
	for (const [i, m] of both.entries()) {
		const r = render(m);
		console.log(`entry ${i} summary: ${r.summaryPlain}`);
		console.log(`entry ${i} card (collapsed):\n${r.cardCollapsed.join("\n")}`);
	}
	const [first] = both;
	check(
		first !== undefined && JSON.stringify(render(first)) === JSON.stringify(oldRender),
		"legacy entry renders identically after the new delivery",
	);
} else {
	const records: TierRecord[] = [];
	for (const tier of TIERS) {
		const record = await measure(tier);
		records.push(record);
		console.log(
			`tier=${record.name} messageBytes=${record.messageBytes} entryBytes=${record.entryBytes} heapDeliver=${record.heapDeliver}B heapReload=${record.heapReload}B detailsMessageChars=${detailsMessage(record.entry.details).length}`,
		);
	}
	if (args.dump !== undefined) writeFileSync(args.dump, JSON.stringify(records));
	if (args.compare !== undefined) {
		const baseline: TierRecord[] = JSON.parse(readFileSync(args.compare, "utf8"));
		for (const now of records) {
			const base = baseline.find((b) => b.name === now.name);
			if (base === undefined) {
				check(false, `${now.name}: missing from baseline`);
				continue;
			}
			const before = detailsMessage(base.entry.details);
			const after = detailsMessage(now.entry.details);
			const saved = base.entryBytes - now.entryBytes;
			// Row 1: the entry shrinks by exactly the JSON bytes dropped from details.message.
			console.log(
				`row1 ${now.name}: entryBytes ${base.entryBytes} -> ${now.entryBytes} (saved ${saved} of message ${now.messageBytes}); heapDeliver ${base.heapDeliver} -> ${now.heapDeliver}; heapReload ${base.heapReload} -> ${now.heapReload}`,
			);
			check(
				Buffer.byteLength(JSON.stringify(before)) - Buffer.byteLength(JSON.stringify(after)) === saved,
				`row1 ${now.name}: saved bytes equal the bytes dropped from details.message`,
			);
			if (now.name === "short") {
				check(before === after && saved === 0, "row1 short: a one-line message is its own summary, nothing to save");
			} else {
				check(saved >= now.messageBytes * 0.9, `row1 ${now.name}: saved at least 90% of one message copy`);
				check(now.heapDeliver < base.heapDeliver, `row1 ${now.name}: heap retained by one deliver is lower`);
				check(now.heapReload < base.heapReload, `row1 ${now.name}: heap retained by reopening the session is lower`);
			}
			// Row 2: model-visible content is identical.
			check(now.entry.content === base.entry.content, `row2 ${now.name}: content identical (${String(now.entry.content).length} chars)`);
			// Row 3: summary lines identical (plain and redacted); card title identical, body one line.
			console.log(`row3 ${now.name} summary: ${now.summaryPlain}`);
			console.log(`row3 ${now.name} summary (redacted): ${now.summaryRedacted}`);
			check(now.summaryPlain === base.summaryPlain, `row3 ${now.name}: summary line identical`);
			check(now.summaryRedacted === base.summaryRedacted, `row3 ${now.name}: redacted summary line identical`);
			check(!now.summaryRedacted.includes(SECRET.slice(0, 12)), `row3 ${now.name}: redacted summary shows no secret fragment`);
			check(now.cardCollapsed[0] === base.cardCollapsed[0], `row3 ${now.name}: card title row identical`);
			const bodyLines = after.split("\n").length;
			check(bodyLines === 1, `row3 ${now.name}: card body source is one line`);
			console.log(`row3 ${now.name} card before (collapsed, ${base.cardCollapsed.length} rows):\n${base.cardCollapsed.join("\n")}`);
			console.log(`row3 ${now.name} card after (collapsed, ${now.cardCollapsed.length} rows):\n${now.cardCollapsed.join("\n")}`);
			// Row 4: field-by-field diff of the persisted entry.
			const paths = diffPaths(base.entry, now.entry);
			console.log(`row4 ${now.name}: differing fields [${paths.join(", ")}]`);
			check(
				now.name === "short" ? paths.length === 0 : paths.length === 1 && paths[0] === "details.message",
				`row4 ${now.name}: differences only in details.message`,
			);
		}
	}
}

if (failures.length > 0) {
	console.log(`${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("all checks passed");
