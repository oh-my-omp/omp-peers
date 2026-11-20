import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessageEntry, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
const { builtinCredentialSecretEntries } = await import("@oh-my-pi/pi-coding-agent/secrets/index");
const { advisorToolIOTransform } = await import("@oh-my-pi/pi-coding-agent/advisor/delta-split");
const { normalizeCustomMessagePayload } = await import("@oh-my-pi/pi-coding-agent/session/messages");
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
const { localMain }: typeof LocalMainModule = await import(join(srcDir, "local-main.ts"));

setThemeInstance(loadThemeSync("dark"));

const ROUNDS = 5;
const CARD_WIDTH = 100;
const SECRET = "sk-bench-7f3a9c2e5b8d1f4a6c0e9b2d7a5f3c1e8b6d4a2f";
const transform = advisorToolIOTransform(
	new SecretObfuscator(
		[{ type: "plain", content: SECRET, mode: "replace", replacement: "[REDACTED]" }, ...builtinCredentialSecretEntries()],
		"deliver-bench-key",
	),
	new Set(),
);
const SENDER: Sender = { kind: "main", pid: 4242, sessionId: "bench-sender", title: "bench sender", cwd: "/tmp/bench" };

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

type EntryFields = Pick<CustomMessageEntry, "customType" | "content" | "display" | "details" | "attribution">;
type TierRecord = {
	name: string;
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

function deliverInto(sm: SessionManagerT): (message: string) => void {
	const pi = {
		sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => {
			const msg = normalizeCustomMessagePayload(message);
			sm.appendCustomMessageEntry(msg.customType, msg.content, msg.display, msg.details);
		},
	};
	const ctx = { isIdle: () => true, agent: { id: "bench" }, sessionManager: sm };
	const api = pi as unknown as ExtensionAPI;
	const context = ctx as unknown as ExtensionContext;
	const main = localMain(api, context);
	return (message) => main.deliver(message, SENDER);
}

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
	const singleDir = mkdtempSync(join(work, "session-"));
	const single = SessionManager.create(singleDir, singleDir);
	await single.ensureOnDisk();
	deliverInto(single)(text);
	await single.flush();
	const file = single.getSessionFile() ?? "";
	await single.close();
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
	const raw = JSON.parse(line) as CustomMessageEntry;
	const reopened = await SessionManager.open(file);
	const [message] = ircMessages(reopened);
	await reopened.close();
	if (message === undefined) throw new Error(`${tier.name}: reopened session has no irc:incoming message`);
	if (tier.name === "large-64k" && args["keep-session"] !== undefined) copyFileSync(file, args["keep-session"]);
	return {
		name: tier.name,
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
		typeof old.content === "string" && legacyText.length > 0 && old.content.replace(/\s+/g, " ").includes(legacyText.replace(/ …$/, "")),
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
			const text = TIERS.find((t) => t.name === now.name)?.make() ?? "";
			console.log(
				`bytes ${now.name}: entryBytes ${base.entryBytes} -> ${now.entryBytes} (message ${now.messageBytes}); details.message ${before.length} -> ${after.length} chars; heapDeliver ${base.heapDeliver} -> ${now.heapDeliver}; heapReload ${base.heapReload} -> ${now.heapReload}`,
			);
			check(after === text.replace(/\s+/g, " ").trim(), `${now.name}: details.message is the folded full message`);
			check(now.entry.content === base.entry.content, `content ${now.name}: content identical (${String(now.entry.content).length} chars)`);
			console.log(`render ${now.name} summary: ${now.summaryPlain}`);
			console.log(`render ${now.name} summary (redacted): ${now.summaryRedacted}`);
			check(now.summaryPlain === base.summaryPlain, `render ${now.name}: summary line identical`);
			check(now.summaryRedacted === base.summaryRedacted, `render ${now.name}: redacted summary line identical`);
			check(!now.summaryRedacted.includes(SECRET.slice(0, 12)), `render ${now.name}: redacted summary shows no secret fragment`);
			check(now.cardCollapsed[0] === base.cardCollapsed[0], `render ${now.name}: card title row identical`);
			check(after.split("\n").length === 1, `render ${now.name}: card body source is one line`);
			console.log(`render ${now.name} card before (collapsed, ${base.cardCollapsed.length} rows):\n${base.cardCollapsed.join("\n")}`);
			console.log(`render ${now.name} card after (collapsed, ${now.cardCollapsed.length} rows):\n${now.cardCollapsed.join("\n")}`);
			const paths = diffPaths(base.entry, now.entry);
			console.log(`fields ${now.name}: differing fields [${paths.join(", ")}]`);
			check(
				paths.every((p) => p === "details.message"),
				`fields ${now.name}: differences only in details.message`,
			);
		}
	}
}

if (failures.length > 0) {
	console.log(`${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("all checks passed");
