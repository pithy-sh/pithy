// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * **The payments host bundles in a project that never installed `@pithy-sh/ledger`** (#645).
 *
 * `ledger` is an optional peer: a catalog that sells features and never names a currency does not install it.
 * But a literal `import("@pithy-sh/ledger/src/ledger")` anywhere a Worker bundle reaches is resolved by the
 * bundler whether or not the branch ever runs, and wrangler's esbuild refuses a specifier it cannot find:
 *
 *     ✘ [ERROR] Could not resolve "@pithy-sh/ledger/src/ledger"
 *
 * Every project that composed payments without ledger could not deploy its payments host, in any
 * environment, from #86 until this. The unit test beside the seam injected a loader, so it proved the
 * *runtime* absent-package path and never met the bundler, which is where the failure was.
 *
 * So this runs **the real bundler wrangler uses — wrangler itself**, `wrangler deploy --dry-run --outdir`, over
 * a scratch project whose `node_modules` holds everything payments declares except the ledger. Nothing is
 * injected and no account is touched: a dry run bundles and stops.
 *
 * The package is copied rather than linked. The workspace copy's own `node_modules` carries `@pithy-sh/ledger`
 * as a devDependency, so a linked package would find it one directory up and the test would pass for the
 * wrong reason. The copy's `exports` map points at `src` instead of `dist`: a host is deployed from source
 * (`kitSource`), and `dist` mirrors it file for file (`packaging.test.ts`), so source is the stricter and the
 * current half.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRANGLER = join(PACKAGE_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

/** The optional peer this project deliberately does not have. */
const ABSENT = "@pithy-sh/ledger";

/**
 * A module reference to it in a bundle — an `import`, a dynamic `import()`, a `require()`. Not the bare name:
 * payments' refusals say `Upgrade @pithy-sh/ledger`, and a sentence is not a specifier.
 */
const REFERENCE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]@pithy-sh\/ledger\b/;

let project: string;

/** Link every package payments itself resolves into the scratch project — except the one it must not need. */
function linkDependencies(target: string): void {
  const source = join(PACKAGE_DIR, "node_modules");
  for (const name of readdirSync(source)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      mkdirSync(join(target, name), { recursive: true });
      for (const scoped of readdirSync(join(source, name))) {
        if (`${name}/${scoped}` === ABSENT) continue;
        symlinkSync(join(source, name, scoped), join(target, name, scoped));
      }
      continue;
    }
    symlinkSync(join(source, name), join(target, name));
  }
}

/** Copy the package as an adopter's install would hold it, resolving its modules to source. */
function installPayments(target: string): void {
  const installed = join(target, "@pithy-sh", "payments");
  mkdirSync(installed, { recursive: true });
  cpSync(join(PACKAGE_DIR, "src"), join(installed, "src"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.exports = { "./src/*": "./src/*.ts" };
  writeFileSync(join(installed, "package.json"), JSON.stringify(manifest, null, 2));
}

/** The committed host template, which carries the compatibility date and flags the host really runs under. */
function hostTemplate(): { compatibility_date: string; compatibility_flags?: string[] } {
  return JSON.parse(blankComments(readFileSync(join(PACKAGE_DIR, "src", "workflows", "wrangler.jsonc"), "utf8")));
}

/** `wrangler deploy --dry-run` one entry, and hand back what it said. */
function bundle(name: string, main: string): { status: number | null; output: string; outdir: string } {
  const template = hostTemplate();
  const outdir = join(project, "out", name);
  const config = join(project, `${name}.wrangler.json`);
  writeFileSync(
    config,
    JSON.stringify({
      name,
      main,
      compatibility_date: template.compatibility_date,
      compatibility_flags: template.compatibility_flags ?? [],
    }),
  );
  const home = join(project, "home");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    WRANGLER_LOG_PATH: join(project, "logs"),
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  };
  const result = spawnSync(
    process.execPath,
    [WRANGLER, "deploy", "--dry-run", "--outdir", outdir, "--config", config],
    {
      cwd: project,
      env,
      encoding: "utf8",
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, outdir };
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "pithy-payments-bundle-"));
  const modules = join(project, "node_modules");
  mkdirSync(modules, { recursive: true });
  linkDependencies(modules);
  installPayments(modules);
  mkdirSync(join(project, "home", ".config"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  // The adopter's app Worker, reduced to the one thing that matters here: it composes payments, so its
  // bundle holds everything `payments()` reaches — the routes, fulfillment, and the grants modules.
  writeFileSync(
    join(project, "src", "index.ts"),
    [
      'import { payments } from "@pithy-sh/payments/src/capability";',
      "export default { fetch: (): Response => new Response(typeof payments) };",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  // `rmSync` unlinks a symlink rather than following it, so the workspace packages linked in stay put.
  if (project) rmSync(project, { recursive: true, force: true });
});

describe("a project without @pithy-sh/ledger", () => {
  test("has nothing a bundler could resolve it from", () => {
    expect(existsSync(join(project, "node_modules", ABSENT))).toBe(false);
  });

  test("bundles the payments host with wrangler", () => {
    const run = bundle("pithy-payments-host", "node_modules/@pithy-sh/payments/src/workflows/worker.ts");
    expect(run.output).not.toContain(`Could not resolve "${ABSENT}`);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(run.outdir, "worker.js"), "utf8")).not.toMatch(REFERENCE);
  }, 120_000);

  test("bundles an app Worker that composes payments with wrangler", () => {
    const run = bundle("pithy-payments-app", "src/index.ts");
    expect(run.output).not.toContain(`Could not resolve "${ABSENT}`);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(run.outdir, "index.js"), "utf8")).not.toMatch(REFERENCE);
  }, 120_000);
});
