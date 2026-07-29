import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";

export interface ScaffoldOptions {
  /** Directory to scaffold into. Created if missing; must be empty if present. */
  targetDir: string;
  /** Application name, written into package.json and wrangler.jsonc. */
  appName: string;
  /** The first worker's name — it lives at `apps/<worker>/`. Defaults to {@link DEFAULT_WORKER}. */
  worker?: string;
}

/**
 * The starter template directory. Resolved relative to this module — Phase 0
 * runs the CLI from the workspace, where `templates/starter` sits at the repo
 * root; publishing bundles the template into the package (a release concern).
 */
function templateDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "templates", "starter");
}

/**
 * Throw if `targetDir` exists and isn't empty. This is the precondition
 * `pithy init` checks *before* prompting, so a doomed run fails fast instead of
 * after the user answers. A missing directory passes — `scaffoldProject`
 * creates it. `scaffoldProject` re-checks, so the guard holds even called direct.
 */
export async function ensureEmptyTarget(targetDir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(targetDir);
  } catch {
    return; // missing directory — nothing to clash with
  }
  if (existing.length > 0) {
    throw new ConflictError({
      message: `${targetDir} isn't empty.`,
      action: "Pick an empty directory. Run pithy init again.",
    });
  }
}

/** The Worker `pithy init` scaffolds first. Every Worker lives in `apps/<name>/`; this is just the default one. */
export const DEFAULT_WORKER = "api";

/** A worker name is a kebab-case directory under `apps/` — the same shape a package name takes. */
export const WORKER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Stamp `appName` into a JSON file's `name` field, preserving the rest. */
async function stampPackageName(path: string, name: string): Promise<void> {
  const pkg = JSON.parse(await readFile(path, "utf8")) as { name: string };
  pkg.name = name;
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Copy the starter template into `targetDir` and stamp the app name — the pure logic behind `pithy init`.
 *
 * The scaffold is the `apps/` layout: the root carries project identity and policy (`pithy.config.ts`,
 * `package.json` with the `apps/*` workspace), and the first Worker lives in `apps/api/` with its own
 * `pithy.config.ts`, `wrangler.jsonc`, and `pithy.worker.jsonc`. There is no root Worker — `pithy worker add`
 * is then purely additive, and each Worker's capabilities, bindings, and DO class migrations attach to it.
 *
 * The template ships `gitignore` unprefixed (npm strips dotfiles from published packages); it lands as
 * `.gitignore`.
 */
export async function scaffoldProject(options: ScaffoldOptions): Promise<void> {
  await mkdir(options.targetDir, { recursive: true });
  await ensureEmptyTarget(options.targetDir);

  await cp(templateDir(), options.targetDir, { recursive: true });
  await rename(join(options.targetDir, "gitignore"), join(options.targetDir, ".gitignore"));

  // The template ships its first worker as `apps/<DEFAULT_WORKER>`; rename it when the caller chose
  // another name, so the directory, the deploy name, and the capability namespace all agree.
  const worker = options.worker ?? DEFAULT_WORKER;
  if (!WORKER_NAME.test(worker)) {
    throw new ValidationError({
      message: `Worker name must be kebab-case (got "${worker}").`,
      action: "Use lowercase words joined by hyphens, e.g. api or admin-api.",
    });
  }
  const workerDir = join(options.targetDir, "apps", worker);
  if (worker !== DEFAULT_WORKER) {
    await rename(join(options.targetDir, "apps", DEFAULT_WORKER), workerDir);
  }

  await stampPackageName(join(options.targetDir, "package.json"), options.appName);
  await stampPackageName(join(workerDir, "package.json"), `${options.appName}-${worker}`);

  // The project's identity — the prefix every feature resource name derives from.
  const configPath = join(options.targetDir, "pithy.config.ts");
  const config = await readFile(configPath, "utf8");
  // A replacement *function* writes appName verbatim — a string replacement would
  // treat `$&`, `$1`, etc. in the name as special patterns.
  await writeFile(
    configPath,
    config.replace('name: "pithy-app"', () => `name: "${options.appName}"`),
  );

  const wranglerPath = join(workerDir, "wrangler.jsonc");
  const wrangler = await readFile(wranglerPath, "utf8");
  await writeFile(
    wranglerPath,
    wrangler.replace('"name": "pithy-app"', () => `"name": "${options.appName}-${worker}"`),
  );
}
