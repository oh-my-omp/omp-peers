import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE_URL = new URL("../src/i18n.ts", import.meta.url).href;
const SCRIPT = `import { language } from ${JSON.stringify(MODULE_URL)}; process.stdout.write(language());`;

/** language() in a fresh process: the configured language is read once per process. */
async function languageWith(env: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "omp-peers-i18n-"));
	try {
		for (const [name, content] of Object.entries(files)) await writeFile(join(agentDir, name), content);
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

const ZH_SECTION = { "omomp.yml": "omomp-lang:\n  language: zh\n" };

describe("UI language resolution (oh-my-omp test vectors)", () => {
	test.each([
		["OMOMP_LANG with case and spaces", { OMOMP_LANG: " ZH " }, {}, "zh"],
		["OMOMP_LANG that is not exactly en or zh is ignored", { OMOMP_LANG: "zh-CN", LANG: "en_US.UTF-8" }, {}, "en"],
		["first non-empty locale variable", { LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8" }, {}, "zh"],
		["LC_ALL wins over LANG", { LC_ALL: "C", LANG: "zh_CN.UTF-8" }, {}, "en"],
		["nothing set", {}, {}, "en"],
		["config section without OMOMP_LANG", { LANG: "en_US.UTF-8" }, ZH_SECTION, "zh"],
		["OMOMP_LANG over the config section", { OMOMP_LANG: "en" }, ZH_SECTION, "en"],
		["invalid config value falls through to the locale", { LANG: "zh_CN.UTF-8" }, { "omomp.yml": "omomp-lang:\n  language: ZH\n" }, "zh"],
	] as const)("%s", async (_name, env, files, expected) => {
		expect(await languageWith(env, files)).toBe(expected);
	});

	test("two omomp files are ambiguous and decide nothing", async () => {
		expect(await languageWith({ LANG: "en_US.UTF-8" }, { ...ZH_SECTION, "omomp.json": '{"omomp-lang":{"language":"zh"}}' })).toBe("en");
	});
});
