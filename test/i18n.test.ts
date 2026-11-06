import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE_URL = new URL("../src/i18n.ts", import.meta.url).href;
const SCRIPT = `import { language } from ${JSON.stringify(MODULE_URL)}; process.stdout.write(language());`;

/** language() in a fresh process with a controlled language environment. */
async function languageWith(env: Record<string, string>): Promise<string> {
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !["OMOMP_LANG", "LC_ALL", "LC_MESSAGES", "LANG"].includes(key)) childEnv[key] = value;
	}
	Object.assign(childEnv, env);
	const result = Bun.spawnSync({ cmd: [process.execPath, "-e", SCRIPT], env: childEnv, stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
	return new TextDecoder().decode(result.stdout);
}

/** Regression: an omomp file's `omomp-lang` section must not affect the result. */
async function languageWithOmompFile(env: Record<string, string>): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "omp-peers-i18n-"));
	try {
		await writeFile(join(agentDir, "omomp.yml"), "omomp-lang:\n  language: zh\n");
		const childEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !["OMOMP_LANG", "LC_ALL", "LC_MESSAGES", "LANG"].includes(key)) childEnv[key] = value;
		}
		Object.assign(childEnv, env, { PI_CODING_AGENT_DIR: agentDir });
		const result = Bun.spawnSync({ cmd: [process.execPath, "-e", SCRIPT], env: childEnv, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
		return new TextDecoder().decode(result.stdout);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

describe("UI language resolution (OMOMP_LANG → locale → English)", () => {
	test.each([
		["OMOMP_LANG with case and spaces", { OMOMP_LANG: " ZH " }, "zh"],
		["OMOMP_LANG that is not exactly en or zh is ignored", { OMOMP_LANG: "zh-CN", LANG: "en_US.UTF-8" }, "en"],
		["first non-empty locale variable", { LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8" }, "zh"],
		["LC_ALL wins over LANG", { LC_ALL: "C", LANG: "zh_CN.UTF-8" }, "en"],
		["nothing set", {}, "en"],
		["locale LANG zh without OMOMP_LANG", { LANG: "zh_CN.UTF-8" }, "zh"],
	] as const)("%s", async (_name, env, expected) => {
		expect(await languageWith(env)).toBe(expected);
	});

	test("omomp file with omomp-lang zh does not affect the result", async () => {
		expect(await languageWithOmompFile({ LANG: "en_US.UTF-8" })).toBe("en");
	});
});
