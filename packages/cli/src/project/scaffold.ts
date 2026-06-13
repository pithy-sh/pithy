import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";

export interface ScaffoldOptions {
  /** Directory to scaffold into. Created if missing; must be empty if present. */
  targetDir: string;
  /** Application name, written into package.json and wrangler.jsonc. */
  appName: string;
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

/**
 * Copy the starter template into `targetDir` and stamp the app name — the pure
 * logic behind `pithy init`. The template ships `gitignore` unprefixed (npm
 * strips dotfiles from published packages); it lands as `.gitignore`.
 */
export async function scaffoldProject(options: ScaffoldOptions): Promise<void> {
  await mkdir(options.targetDir, { recursive: true });
  await ensureEmptyTarget(options.targetDir);

  await cp(templateDir(), options.targetDir, { recursive: true });
  await rename(join(options.targetDir, "gitignore"), join(options.targetDir, ".gitignore"));

  const pkgPath = join(options.targetDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { name: string };
  pkg.name = options.appName;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const wranglerPath = join(options.targetDir, "wrangler.jsonc");
  const wrangler = await readFile(wranglerPath, "utf8");
  // A replacement *function* writes appName verbatim — a string replacement would
  // treat `$&`, `$1`, etc. in the name as special patterns.
  await writeFile(
    wranglerPath,
    wrangler.replace('"name": "pithy-app"', () => `"name": "${options.appName}"`),
  );
}
