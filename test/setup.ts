import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Endpoints live under ~/.omp/run/peers; a private HOME keeps test nodes out of the real peer set.
process.env.HOME = mkdtempSync(join(tmpdir(), "omp-peers-test-"));
