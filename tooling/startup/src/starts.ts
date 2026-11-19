// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// Fail when the reference Worker throws while it starts.
//
//   bun src/starts.ts     # from tooling/startup, in this tree or the base's
//
// `wrangler check startup` profiles a Worker whose startup threw as though it had finished, and reports the
// shorter time. A composition that refuses itself, or a capability whose build dropped a module it needs,
// would measure as a faster Worker. So the gate runs this on each side before it measures: the Worker is
// bundled as wrangler deploys it, started in workerd, and sent one request. Any answer means it started;
// a refusal at startup fails with workerd's message.

import { spawn } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

/** Where the bundle goes: inside wrangler's own ignored state, never beside the source. */
const OUT_DIR = join(".wrangler", "tmp", "starts");

/** Matches `wrangler.jsonc`, which matches `compatibility.ts` at the repository root. */
const COMPATIBILITY_DATE = "2026-06-01";

function bundle(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const wrangler = join(dir, "node_modules", ".bin", "wrangler");
    const child = spawn(wrangler, ["deploy", "--dry-run", "--outdir", OUT_DIR], { cwd: dir, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (status) =>
      status === 0 ? resolve() : reject(new Error(`wrangler deploy --dry-run exited ${status ?? "on a signal"}.`)),
    );
  });
}

/** The one module wrangler wrote, named after the Worker's `main`. */
function bundled(out: string): string {
  const [script] = readdirSync(out).filter((name) => name.endsWith(".js"));
  if (script === undefined) throw new Error(`wrangler wrote no module to ${out}.`);
  return script;
}

/** Bundles the reference Worker in `dir`, starts it, and resolves once it has answered one request. */
export async function startsCleanly(dir: string): Promise<void> {
  await bundle(dir);
  const out = join(dir, OUT_DIR);
  process.chdir(out);
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: join(out, bundled(out)),
      modulesRoot: out,
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "prod" },
    }),
  );
  try {
    await worker.dispatchFetch("http://startup.invalid/health");
  } finally {
    await worker.dispose().catch(() => undefined);
  }
}

/** Whether this file is what was executed, rather than imported. */
function runAsCommand(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsCommand()) {
  try {
    await startsCleanly(process.cwd());
    process.stdout.write("The reference Worker starts.\n");
  } catch (error) {
    process.stdout.write(
      `The reference Worker did not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
