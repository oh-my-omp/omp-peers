// Bench + byte-equivalence harness for the issue-6 truncateUtf8 fix (child A).
// Synthetic reply loads per tree-root §4: three tiers — below the 32 KiB cap,
// above the cap, and a cut landing mid multi-byte-char — built from a seeded
// deterministic generator with a controlled multi-byte ratio, plus a repeated
// -lines variant (folding is host behavior; this plugin must not introduce any
// and must return the input bytes unchanged).
//
// Usage:
//   bun test/bench/truncate-issue6-bench.ts            # medians + byte lines
//   bun test/bench/truncate-issue6-bench.ts --bytes <baseline.json>
//     # additionally diffs this run's outputs against a saved baseline dump
//   bun test/bench/truncate-issue6-bench.ts --dump <out.json>
//     # save this run's outputs (text bytes + truncated) for cross-commit diff
//
// Metrics per load: per-call heapUsed delta (Bun.gc() before each measurement,
// median of ROUNDS rounds) and per-call wall time (median of ROUNDS rounds).
// Every failure exits non-zero so evidence capture sees it.
import { truncateUtf8 } from "../../src/protocol.ts";

export const CAP = 32 * 1024;

export type Load = {
	name: string;
	reply: string;
	expectTruncated: boolean;
};

/** Deterministic LCG; seeds below were fixed once and are never reused elsewhere. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const CHARS = "abcdefghijklmnopqrstuvwxyz";
const MBC = ["é", "中", "🜛"]; // two-, three- and four-byte sample chars

function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** ASCII text of an exact UTF-8 byte length, built from seeded words. */
function asciiOfBytes(target: number, seed: number): string {
	const rand = lcg(seed);
	const parts: string[] = [];
	let len = 0;
	while (len < target - 1) {
		const n = 3 + Math.floor(rand() * 8);
		let w = "";
		for (let i = 0; i < n; i++) w += CHARS[Math.floor(rand() * CHARS.length)];
		parts.push(w);
		len += w.length + 1;
	}
	// ASCII only ⇒ byte-length == char-length, slicing is safe.
	return parts.join(" ").slice(0, target);
}

/** ASCII text of approximately `target` bytes, words joined by spaces. */
function asciiRoughly(target: number, seed: number): string {
	const rand = lcg(seed);
	const parts: string[] = [];
	let len = 0;
	while (len < target) {
		const n = 3 + Math.floor(rand() * 8);
		let w = "";
		for (let i = 0; i < n; i++) w += CHARS[Math.floor(rand() * CHARS.length)];
		parts.push(w);
		len += w.length + 1;
	}
	return parts.join(" ");
}

/** ~300 KiB reply, mostly ASCII with a controlled ~2% multi-byte ratio. */
function aboveCap(): string {
	const rand = lcg(45645);
	const parts: string[] = [];
	let len = 0;
	while (len < 300 * 1024) {
		const n = 3 + Math.floor(rand() * 8);
		let w = "";
		for (let i = 0; i < n; i++) w += CHARS[Math.floor(rand() * CHARS.length)];
		parts.push(w);
		if (rand() < 0.02) parts.push(MBC[Math.floor(rand() * MBC.length)] ?? "中");
		len += w.length + 1;
	}
	return parts.join(" ");
}

/** Cut lands mid multi-byte char: CAP-2 ASCII bytes + "中" (3 bytes). The naive
 * cut at CAP splits the 中; the boundary-safe cut must return CAP-2 bytes plus
 * the encoder's chosen replacement for the 1 lead byte (baseline: U+FFFD). */
function midChar(): Load {
	const prefix = asciiOfBytes(CAP - 2, 78979);
	const text = `${prefix}中tail`;
	const b = Buffer.from(text, "utf8");
	if (b.byteLength !== CAP + 5 || !isContinuation(b[CAP])) {
		throw new Error("mid-char load failed to land the cut inside a char");
	}
	return { name: "mid-char-cut", reply: text, expectTruncated: true };
}

/** Long answer made of 120 identical lines (> 4 KiB, below cap): a host with
 * dedupe would fold this; with replyMaxBytes: Infinity the plugin passes it
 * through and truncateUtf8 must return every byte. */
function repeatedLines(): string {
	const rand = lcg(24680);
	const n = 3 + Math.floor(rand() * 8);
	let w = "";
	for (let i = 0; i < n; i++) w += CHARS[Math.floor(rand() * CHARS.length)];
	return `repeated line ${w} ${w}\n`.repeat(120);
}

export function loadList(): Load[] {
	return [
		{ name: "below-cap", reply: asciiRoughly(30 * 1024, 12321), expectTruncated: false },
		{ name: "above-cap", reply: aboveCap(), expectTruncated: true },
		midChar(),
		{ name: "below-cap-repeated-lines", reply: repeatedLines(), expectTruncated: false },
	];
}

const ROUNDS = 40;
const WARMUP = 5;

function median(a: number[]): number {
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	const hi = s[m] ?? 0;
	const lo = s[m - 1];
	return s.length % 2 || lo === undefined ? hi : (lo + hi) / 2;
}

async function measure(load: Load): Promise<void> {
	const probe = truncateUtf8(load.reply, CAP);
	if (probe.truncated !== load.expectTruncated) {
		console.error(`FAIL ${load.name}: truncated=${probe.truncated} expected ${load.expectTruncated}`);
		process.exit(1);
	}
	const b = Buffer.from(load.reply, "utf8");
	const n = Buffer.byteLength(probe.text, "utf8");
	if (load.expectTruncated) {
		if (n > CAP) {
			console.error(`FAIL ${load.name}: returned ${n} bytes > cap`);
			process.exit(1);
		}
		if (isContinuation(b[n])) {
			console.error(`FAIL ${load.name}: cut at byte ${n} splits a character`);
			process.exit(1);
		}
	} else if (n !== b.byteLength) {
		console.error(`FAIL ${load.name}: pass-through returned ${n} of ${b.byteLength} bytes`);
		process.exit(1);
	}
	const heaps: number[] = [];
	const times: number[] = [];
	for (let i = 0; i < WARMUP; i++) truncateUtf8(load.reply, CAP);
	for (let i = 0; i < ROUNDS; i++) {
		Bun.gc(true);
		const h0 = process.memoryUsage().heapUsed;
		const t0 = performance.now();
		truncateUtf8(load.reply, CAP);
		const t1 = performance.now();
		const h1 = process.memoryUsage().heapUsed;
		heaps.push(h1 - h0);
		times.push(t1 - t0);
	}
	console.log(
		`load=${load.name} heapMedian=${median(heaps).toFixed(0)}B timeMedian=${median(times).toFixed(3)}ms ` +
			`textBytes=${n} truncated=${probe.truncated} tail=${Buffer.from(probe.text.slice(-8), "utf8").toString("hex")}`,
	);
}

const args = process.argv.slice(2);
const dumpPath = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : undefined;
const baselinePath = args.includes("--bytes") ? args[args.indexOf("--bytes") + 1] : undefined;

const dumps: string[] = [];
for (const load of loadList()) {
	await measure(load);
	const r = truncateUtf8(load.reply, CAP);
	dumps.push(`${load.name}|${r.truncated}|${Buffer.from(r.text, "utf8").toString("base64")}`);
}

if (dumpPath) await Bun.write(dumpPath, `${dumps.join("\n")}\n`);

if (baselinePath) {
	const baseText = await Bun.file(baselinePath).text();
	const base = new Map(
		baseText
			.trim()
			.split("\n")
			.map((l) => [l.slice(0, l.indexOf("|")), l]),
	);
	let mismatch = 0;
	for (const d of dumps) {
		const name = d.slice(0, d.indexOf("|"));
		if (base.get(name) !== d) {
			console.error(`FAIL byte-mismatch for ${name}`);
			mismatch++;
		} else {
			console.log(`byte-identical: ${name}`);
		}
	}
	if (mismatch > 0) process.exit(1);
	console.log("all tiers byte-identical to baseline dump");
}
