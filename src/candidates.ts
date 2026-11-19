// These records outlive crashed
// processes and a pid can be reused, so a live pid here is a candidate, never a reachable peer.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeRoot } from "@oh-my-pi/pi-utils";

async function entries(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch {
		return [];
	}
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function unbridgedOmpPids(bridged: ReadonlySet<number>): Promise<number[]> {
	const root = getDaemonRuntimeRoot();
	const pids = new Set<number>();
	for (const scope of await entries(root)) {
		for (const name of await entries(path.join(root, scope, "clients"))) {
			const match = /^(\d+)-.*\.json$/.exec(name);
			if (match?.[1] === undefined) continue;
			const pid = Number(match[1]);
			if (pid !== process.pid && !bridged.has(pid)) pids.add(pid);
		}
	}
	return [...pids].filter(pidIsLive).sort((a, b) => a - b);
}
