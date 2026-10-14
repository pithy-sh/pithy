/**
 * Stamp each capability package's own version into a committed `src/version.generated.ts`.
 *
 * ## Why a generated file, and not a bundler define
 *
 * A Worker cannot read its own `package.json`. Everything is bundled, there is no filesystem, and
 * `readFileSync(new URL("../package.json", import.meta.url))` — the idiom the CLI uses three times — is
 * Node-only and unusable in workerd. So a package's version is unknowable at runtime unless it is
 * written into the source.
 *
 * The obvious alternative is a build-time `define`, and this repo has nowhere to put one: there is no
 * bundler. Every package builds with plain `tsc -p tsconfig.json --outDir dist`, and nothing ever reads
 * `dist/` — packages import each other's raw TypeScript through `"exports": { "./src/*": "./src/*.ts" }`,
 * and so do the tests. Introducing a bundler to inject one constant would change how 21 packages resolve
 * each other. `import pkg from "../package.json" with { type: "json" }` fails too: every package sets
 * `rootDir: "src"`, so `tsc` rejects it with TS6059 and CI's build step fails while typecheck passes.
 *
 * What is left is codegen, and `@pithy-sh/email` already does exactly this for its precompiled
 * templates: a script writes a committed `*.generated.ts` with an SPDX header read from the package's own
 * `license` field. This is that pattern, for a version.
 *
 * ## Why the license is read rather than hard-coded
 *
 * The same reason `scripts/precompile.ts` gives. `scripts/license-headers.ts --check` runs over the whole
 * repo in CI and reconciles each file's header against its package's `license` field. Hard-coding `MIT`
 * here would work until a package's license changed — then the gate would report a wrong header, `--fix`
 * would correct it, and the next stamp would put it back. Packages here are not all MIT: `@pithy-sh/audit`
 * is FSL-1.1-MIT.
 *
 * ## When it runs
 *
 * Chained into the root `version` script, which is the one moment it is load-bearing: Changesets
 * rewrites every `package.json` version there, and *after* any build, so a constant stamped at build
 * time would ship permanently reading whatever it was before the release bump.
 *
 * **Deliberately not chained into `build`.** The value depends on one thing — a package's `version`
 * field — and that changes only at `changeset version`, so regenerating per build regenerates something
 * that cannot have changed. It would also make a build silently rewrite tracked source, and it would
 * undermine the gate below: a developer whose stamps had drifted would have `bun run build` quietly
 * repair them and never reproduce the CI failure. (`@pithy-sh/email`'s `precompile` *is* chained into
 * its build, correctly — its output depends on template sources that change all the time. This one does
 * not.) Run it by hand with `bun run stamp-versions` if you ever need to.
 *
 * `--check` runs in CI's whole-repo verify job, which is what makes drift a failed build rather than a
 * lie a customer acts on.
 *
 * It stamps one more thing: every Claude Code plugin's `plugin.json` under `agent-plugins/claude/` takes
 * `@pithy-sh/cli`'s version (#719), for the reason given at {@link pluginManifests}.
 *
 * Only packages carrying a `pithy.manifest.json` are stamped: those are the capability packages, the ones
 * whose version a control-plane manifest reports. Stamping the rest would be 21 generated files for a
 * question nobody asks of them.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The repository the stamp reads and writes. `--root <dir>` points it at another tree, which is how
 * `packages/cli/src/ci/claudePlugin.test.ts` proves `--check` fails on a drift it planted in a copy rather
 * than in this checkout.
 */
function rootDir(): string {
  const at = process.argv.indexOf("--root");
  const given = at === -1 ? undefined : process.argv[at + 1];
  return given === undefined ? join(here, "..") : resolve(given);
}

const root = rootDir();
const packagesDir = join(root, "packages");

/** The generated module's filename, relative to a package's `src/`. */
const GENERATED = "version.generated.ts";

interface StampTarget {
  /** The package directory name under `packages/`. */
  dir: string;
  /** The npm package name, e.g. `@pithy-sh/auth`. */
  name: string;
  /** The version in its `package.json` — `0.0.0` until Changesets has cut a release. */
  version: string;
  /** The SPDX identifier from its `license` field. */
  license: string;
}

/**
 * Every capability package, with the fields a stamp needs.
 *
 * Keyed on **`src/capability.ts`**, not on `pithy.manifest.json`. The manifest looked like the obvious
 * signal and is the wrong one: `@pithy-sh/matchmaking` and `@pithy-sh/rating` shipped as packages
 * that export a capability with no manifest beside it, so a manifest-keyed rule skipped them and
 * their capabilities reported `version: null` — which the contract reserves for *the adopter's own app
 * capability, which genuinely has no npm version*. A published package reporting null is
 * indistinguishable from the adopter's own code, which is exactly the confusion the field exists to
 * prevent.
 *
 * Both ship a manifest now (#415) and the rule is unchanged by that, because the manifest is the artifact
 * that goes missing: keying on it skips exactly the package the rule exists to catch.
 *
 * `core` is deliberately absent from this set and stamped by the rule below: it has no `src/capability.ts`
 * (its `controlplane()` lives at `src/controlPlane/capability.ts`) but does compose into the manifest.
 */
function targets(): StampTarget[] {
  const found: StampTarget[] = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    const packageDir = join(packagesDir, dir);
    if (!statSync(packageDir).isDirectory()) continue;
    if (!definesCapability(packageDir)) continue;
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license: string;
    };
    found.push({ dir, name: manifest.name, version: manifest.version, license: manifest.license });
  }
  return found;
}

/**
 * Whether a package contributes a `Capability` — the thing a control-plane manifest reports a version for.
 *
 * `src/capability.ts` covers every capability package. `core` is named explicitly because its capability
 * lives at `src/controlPlane/capability.ts`; a glob over the whole tree would instead sweep in `@pithy-sh/cli`,
 * whose `workerScaffold.ts` carries a `defineCapability` inside a *template string* for the Worker it
 * scaffolds — code it generates, not a capability it composes.
 */
function definesCapability(packageDir: string): boolean {
  if (packageDir.endsWith("/core")) return true;
  try {
    statSync(join(packageDir, "src", "capability.ts"));
    return true;
  } catch {
    return false;
  }
}

/** The exact bytes a package's generated module should hold. */
function render(target: StampTarget): string {
  return `// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: ${target.license}

// GENERATED by scripts/stampVersions.ts — do not edit by hand. Regenerate with \`bun run stamp-versions\`.
//
// A Worker cannot read its own package.json, so this is how ${target.name} knows its own version at
// runtime. The capability attaches it, and \`GET /control-plane/manifest\` reports it per capability —
// which is what answers "should this project upgrade" and "is this customer exposed to what we just
// fixed". Those questions are only answerable per module, because a project composes some capabilities
// and not others.

/** This package's npm name — the join key against a release feed. */
export const PACKAGE_NAME = ${JSON.stringify(target.name)};

/** This package's version, stamped from its own package.json at generation time. */
export const PACKAGE_VERSION = ${JSON.stringify(target.version)};
`;
}

/** Where the Claude Code plugins live: one directory per plugin, each with its own `.claude-plugin/plugin.json`. */
const PLUGINS_DIR = join("agent-plugins", "claude");

/**
 * **A plugin's version is the CLI's** (#719). Every plugin under `agent-plugins/claude/` describes the
 * `pithy` commands it drives, so the version a user holds says which CLI it was written for — and the
 * version is also what Claude Code keys updates on: an unchanged string keeps a user's cached copy, so a
 * plugin updates once per release and never between. Stamped here, beside the packages, for the reason
 * those are: Changesets rewrites `@pithy-sh/cli`'s `package.json` in the `version` script, and this runs
 * straight after it. Every plugin installs from one checkout, so an add-on's `"dependencies": ["pithy"]`
 * needs no range.
 */
function pluginManifests(): string[] {
  const dir = join(root, PLUGINS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names
    .map((name) => join(dir, name, ".claude-plugin", "plugin.json"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/** The CLI's version: the one every plugin carries. */
function cliVersion(): string {
  return (JSON.parse(readFileSync(join(packagesDir, "cli", "package.json"), "utf8")) as { version: string }).version;
}

/**
 * A plugin manifest with its top-level `version` set to the CLI's, and every other byte where it was.
 *
 * Replaced in the text rather than re-serialized: Biome formats the file, and `JSON.stringify` lays an
 * array out differently, so a stamp that rewrote the whole file would fight the formatter on every run and
 * `--check` could never pass. The top-level key is the first `"version"` at two spaces of indent.
 */
function renderPlugin(source: string, version: string): string {
  const field = /^ {2}"version": "[^"]*"/m;
  if (!field.test(source)) throw new Error(`A plugin manifest has no top-level "version" to stamp.`);
  return source.replace(field, `  "version": ${JSON.stringify(version)}`);
}

const check = process.argv.includes("--check");
const stale: string[] = [];
let written = 0;

for (const target of targets()) {
  const path = join(packagesDir, target.dir, "src", GENERATED);
  const expected = render(target);
  let actual: string | null = null;
  try {
    actual = readFileSync(path, "utf8");
  } catch {
    actual = null;
  }
  if (actual === expected) continue;

  if (check) {
    stale.push(`${target.name} (${target.version})`);
    continue;
  }
  writeFileSync(path, expected);
  written += 1;
}

const version = cliVersion();
for (const path of pluginManifests()) {
  const actual = readFileSync(path, "utf8");
  const expected = renderPlugin(actual, version);
  if (actual === expected) continue;
  if (check) {
    stale.push(`${path.slice(root.length + 1)} (${version})`);
    continue;
  }
  writeFileSync(path, expected);
  written += 1;
}

if (check && stale.length > 0) {
  // A stamped version that has drifted from the package.json it came from is worse than reporting
  // nothing, because a customer would act on it — deciding not to upgrade against a version that is a
  // lie. This is the whole defense, and it is the same failure mode as the binding that went missing:
  // correct code, never regenerated, nothing complaining.
  process.stderr.write(`Stamped versions are stale. Run \`bun run stamp-versions\`.\n  ${stale.join("\n  ")}\n`);
  process.exit(1);
}

if (!check) process.stdout.write(written === 0 ? "Versions already stamped.\n" : `Stamped ${written} file(s).\n`);
