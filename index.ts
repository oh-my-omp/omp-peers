/**
 * Subagent senders carry their registry id; recipients
 * return side answers through the ask call, but must not use peer_send to reply to subagents.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./src/errors.ts";
import { localMain } from "./src/local-main.ts";
import { node } from "./src/node.ts";
import { peerTools } from "./src/tools.ts";

export default function ompPeers(pi: ExtensionAPI): void {
	for (const tool of peerTools()) pi.registerTool(tool);

	const warn = (message: string, error: unknown): void => pi.logger.warn(message, { error: errorText(error) });
	let registered: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		registered = ctx.agent.id;
		await node.add(localMain(pi, ctx), warn);
	});

	pi.on("session_shutdown", async () => {
		if (registered === undefined) return;
		const agentId = registered;
		registered = undefined;
		await node.remove(agentId);
	});
}
