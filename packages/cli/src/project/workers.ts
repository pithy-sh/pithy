import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "comment-json";

/** A deployable Worker: the name deploy labels it by, and the directory wrangler runs in. */
export interface WorkerTarget {
  /** The Worker's name — its `wrangler.jsonc` `name`, or the directory when that is absent. */
  name: string;
  /** The directory holding the Worker's `wrangler.jsonc` — the `cwd` for `wrangler deploy`. */
  dir: string;
}

/** Just the `name` field of a `wrangler.jsonc` — the Worker's deployed name. */
interface NamedWrangler {
  name?: string;
}

/** True if `dir` holds a `wrangler.jsonc` — the marker of a deployable Worker. */
async function hasWrangler(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "wrangler.jsonc"))).isFile();
  } catch {
    return false;
  }
}

/** The Worker's name from its `wrangler.jsonc`, falling back to `fallback` if unreadable or unnamed. */
async function workerName(dir: string, fallback: string): Promise<string> {
  try {
    const config = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as NamedWrangler;
    return config.name ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The project's deployable Workers. `apps/` **is** the registry — every `apps/<name>/` holding a
 * `wrangler.jsonc` is one Worker (`docs/CLI.md` §6). Until a project adopts that layout it has a
 * single root worker (the current `pithy init` scaffold), so with no `apps/*` workers this falls back
 * to the root `wrangler.jsonc`. `dev` and `deploy` both discover the set this way — no hand-kept list.
 */
export async function discoverWorkers(projectDir: string): Promise<WorkerTarget[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(join(projectDir, "apps"));
  } catch {
    entries = [];
  }

  const appWorkers: WorkerTarget[] = [];
  for (const entry of entries) {
    const dir = join(projectDir, "apps", entry);
    if (await hasWrangler(dir)) appWorkers.push({ name: await workerName(dir, entry), dir });
  }
  if (appWorkers.length > 0) return appWorkers.sort((a, b) => a.name.localeCompare(b.name));

  if (await hasWrangler(projectDir)) return [{ name: await workerName(projectDir, "app"), dir: projectDir }];
  return [];
}
