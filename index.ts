/**
 * omp-peers: the main sessions of one user's omp processes find each other, ask each other
 * /btw-style side questions and exchange IRC messages.
 *
 * Process node (src/node.ts): one IPC endpoint per omp process, `/tmp/omp-<uid>/peers/<pid>.sock`
 * (per user, profile-independent, emptied at boot), open while at least one main session of the process is registered.
 * A peer is alive when its endpoint accepts a connection; each connection carries one JSON
 * request (`list`, `ask`, `irc`) and one response (src/protocol.ts).
 *
 * Events: `session_start` registers a main session with the node (subagents are not peers);
 * `session_shutdown` unregisters it, and the last one out closes the endpoint. Session id,
 * title, cwd and idle state are read live, so `/new` and resume need no re-registration.
 * `kill -9` and omp's RPC-mode signal exits skip `session_shutdown`; the endpoint file left
 * behind refuses connections and stays until reboot empties `/tmp`, or the next process with that pid takes it over.
 *
 * Tools (main sessions only): `peer_list`, `peer_ask` (the target answers through the host's
 * side turn, `ctx.runEphemeralTurn`, without touching its conversation) and `peer_send` (an
 * `irc:incoming` custom message injected with `pi.sendMessage`, delivered as an aside).
 *
 * Files: the endpoint above; reads omp's project presence records under
 * `~/.omp/run/daemons/<scope>/clients/` to report omp processes without omp-peers.
 *
 * Failure policy: hooks and tools never throw into omp; endpoint errors are logged with
 * `pi.logger.warn`, request failures come back as error results.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./src/errors.ts";
import { localMain } from "./src/local-main.ts";
import { node } from "./src/node.ts";
import { peerTools } from "./src/tools.ts";

export default function ompPeers(pi: ExtensionAPI): void {
	for (const tool of peerTools()) pi.registerTool(tool);

	const warn = (message: string, error: unknown): void => pi.logger.warn(message, { error: errorText(error) });
	/** The agent id this binding registered, while registered. */
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
