import { readFileSync } from "node:fs";

const read = (name: string): string => readFileSync(new URL(`./topics/${name}.md`, import.meta.url), "utf8");

export function topicsFor(tool: "peer_list" | "peer_ask" | "peer_send"): Readonly<Record<string, string>> {
	switch (tool) {
		case "peer_list":
			return { liveness: read("liveness") };
		case "peer_ask":
			return { "side-turns": read("side-turns") };
		case "peer_send":
			return { replies: read("replies") };
	}
}
