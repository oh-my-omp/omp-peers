import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import manifest from "./package.json";
import { errorText } from "./src/errors.ts";
import { inflightCalls, localMain } from "./src/local-main.ts";
import { node } from "./src/node.ts";
import { peerScheme } from "./src/scheme.ts";

declare global {
	var ompPeersEnabled: Promise<boolean> | undefined;
}

/**
 * Read once per process: registering or dropping `peer://` mid-run would change every session's system prompt,
 * so a changed setting takes effect when omp next starts.
 */
async function readEnabled(pi: ExtensionAPI): Promise<boolean> {
	const fallback = manifest.omp.settings.enabled.default;
	try {
		const raw: unknown = (await getPluginSettings(manifest.name, process.cwd())).enabled;
		if (raw === undefined) return fallback;
		if (typeof raw === "boolean") return raw;
		pi.logger.warn("omp-peers ignored its invalid `enabled` setting", { value: String(raw) });
		return fallback;
	} catch (error) {
		pi.logger.warn("omp-peers could not read its plugin settings", { error: errorText(error) });
		return fallback;
	}
}

export default async function ompPeers(pi: ExtensionAPI): Promise<void> {
	globalThis.ompPeersEnabled ??= readEnabled(pi);
	if (!(await globalThis.ompPeersEnabled)) return;
	InternalUrlRouter.instance().register(peerScheme);

	const warn = (message: string, error: unknown): void => pi.logger.warn(message, { error: errorText(error) });
	let registered: string | undefined;
	let streaming: AgentMessage | undefined;

	pi.on("message_update", (event) => {
		if (registered !== undefined && event.message.role === "assistant") streaming = event.message;
	});
	pi.on("message_end", () => {
		streaming = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		registered = ctx.agent.id;
		await node.add(
			localMain(pi, ctx, () => inflightCalls(streaming)),
			warn,
		);
	});

	pi.on("session_shutdown", async () => {
		if (registered === undefined) return;
		const agentId = registered;
		registered = undefined;
		streaming = undefined;
		await node.remove(agentId);
	});
}
