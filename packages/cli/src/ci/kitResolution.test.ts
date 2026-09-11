// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **Every `@pithy-sh/*` module this CLI reaches at runtime is re-based onto the project, exempted by name,
 * or recorded as residue this cannot re-base.**
 *
 * #533: capability modules were reached with a bare specifier — `import("@pithy-sh/payments/src/capability")`
 * — and a bare specifier in ESM resolves relative to the **importing module**. A globally installed `pithy`
 * therefore asked its own `dist/`'s `node_modules` about a package the *project* had installed, and refused a
 * composed, working capability as "not installed" with `pithy add` for a remedy. `pithy add` scaffolds into
 * `pithy.config.ts`, so trusting the action rewrites working configuration to work around a resolution bug.
 *
 * The quieter half was the six packages that *did* resolve, to the CLI's copies: cli 0.2.2 ran
 * `@pithy-sh/email@0.1.7`'s resolver against a project pinned to `0.1.6`, silently, because every brand
 * check in the kit is structural and structure did not change.
 *
 * **A gate rather than a note, because the issue's own survey of the blast radius was three files short.**
 * Twelve were named; `capabilities/testersLoader.ts`, `capabilities/testersProvisioner.ts` and
 * `commands/testers.ts` were not, and `project/kitSource.ts`'s `import.meta.resolve` — the same defect,
 * silent, returning a real path to the CLI's own copy of a worker about to be deployed under the adopter's
 * name — was not either. A property that is only true as a set is checked as a set, the way
 * `capabilityVersions.test.ts` and `migrations/orders.test.ts` are.
 *
 * ## Three shapes, and the third is most of them
 *
 * The first draft of this gate read **dynamic** reaches only — `import("@pithy-sh/…")` and
 * `import.meta.resolve("@pithy-sh/…")`, both requiring a string literal — and claimed to cover every
 * runtime reach. It did not. A static `import { X } from "@pithy-sh/…"` is a runtime reach with no literal
 * for either pattern to match, and there are **92 of them across 37 files**. Nor could it see its own
 * motivating case: `kitSource` passed `import.meta.resolve` a *variable*, so the one site the issue's
 * survey had to be extended to find was invisible to the check written to find it. A gate whose stated
 * scope exceeds its real one is worse than no gate, so all three shapes are read now:
 *
 * 1. **Dynamic, literal.** Re-basable, and re-based — {@link kitImport} / {@link kitSource}. `CLI_OWNED`
 *    is the written-down exception, checked in both directions.
 * 2. **`import.meta.resolve`, any argument.** Refused outright. Its base is always the calling module, so
 *    there is no correct use of it in this package; `kitResolve` exists because Node 22 gives it no second
 *    parameter to point elsewhere.
 * 3. **Static.** *Not* re-basable — a static specifier is resolved before any code runs, so no function can
 *    intervene. This is the residue, and it is recorded file by file rather than waved at, because the only
 *    thing a gate can do about a defect it cannot fix is stop it growing.
 *
 * ## What the residue costs, stated once
 *
 * A static import of `@pithy-sh/secrets/src/keyspace` binds the **CLI's** idea of a secret's name to a
 * value the adopter's Worker reads through **its own** copy. CLAUDE.md calls that name the join key: the
 * same name resolves the same value, and two versions of it resolve two. The same is true of
 * `@pithy-sh/turnstile`'s `TURNSTILE_SECRET_NAME`, of the `@pithy-sh/secrets` migration
 * `secretsProvisioner.ts` runs against the adopter's D1, and of the envelope format `addBootstrap.ts`
 * encrypts with. None of it is a convenience import. Closing it means giving each of these commands a
 * project-based loader, which is its own issue; until then the set is pinned here so it cannot quietly
 * take on another package or another file.
 */

/** `packages/cli/src/ci` → the CLI's own source. */
const CLI_SRC = resolve(import.meta.dirname, "..");

/**
 * The dynamic sites that deliberately resolve from the CLI, each with the sentence somebody would have to
 * disagree with to move it.
 *
 * **Checked in both directions.** A site that leaves must be deleted from here, or the gate fails on a
 * stale entry — the same rule `lazyHeavyImports.test.ts`'s `KNOWN` carries, and for the same reason: an
 * exemption list whose reasons have quietly stopped being true is worse than no list.
 *
 * Every entry is `@pithy-sh/cloudflare`, and that is the whole shape of the exception. It is **not a
 * capability**: it ships no manifest, no catalog entry, and there is no `pithy add cloudflare`. It is a
 * hard `dependencies` entry of the CLI, type-imported statically by fourteen modules here, and **no
 * project installs it because it asked for it** — so re-basing these onto the project root would fail on
 * every correctly configured project rather than fix any broken one. `commands/init.ts` carries the
 * sharpest form of it: `pithy init` runs *before* a project exists, against a directory being created,
 * with no `node_modules` to resolve anything from.
 *
 * **A project composing `secrets`, `storage` or `media` does now have a copy**, since #542 made
 * `@pithy-sh/cloudflare` a required peer of the three that import it and `pithy add` declares a required
 * peer on the Worker. That does not move any entry here. A project composing none of them still has
 * nothing to resolve from, `pithy init` still runs before there is a project at all, and the copy an
 * adopter would have is there to satisfy `secrets`' own bundle rather than to serve the CLI — these four
 * sites mint and read tokens with the CLI's credentials, which is work the CLI does as itself.
 */
const CLI_OWNED: Record<string, string> = {
  "cloudflare/clients.ts": "The CF REST client is a CLI dependency, not a capability. No project installs it.",
  "commands/init.ts": "`pithy init` runs before the project exists — there is no project to resolve from.",
  "seed/drivers.ts": "The CF REST client again. `persistRoot` is the project root and still must not be used.",
  "capabilities/secretsProvisioner.ts": "Token policy for a token the CLI mints, from the CLI's own client.",
};

/**
 * The two packages the CLI's **own runtime** is built from, so a static import of either is not residue.
 *
 * Neither is a thing the CLI resolves *on an adopter's behalf*. `@pithy-sh/cloudflare` is not a capability
 * at all — no manifest, no catalog entry, no `pithy add cloudflare` — and no project asks for it (a project
 * composing `secrets`, `storage` or `media` carries a copy since #542 made it their peer, which is theirs
 * and not the CLI's to read). `core` is the CLI's own error family, naming rules and manifest types: the
 * CLI is a Node program that happens to share a library with the Workers it scaffolds, and re-basing that
 * library onto the adopter's project would mean the CLI's own `PithyError` came from somewhere else.
 *
 * A version skew here is a skew between the CLI and *itself*, which npm resolves at install time.
 */
const CLI_RUNTIME: Record<string, string> = {
  "@pithy-sh/core": "The CLI's own error family, naming and manifest types. Not resolved for the adopter.",
  "@pithy-sh/cloudflare": "The CF REST client. Not a capability; no adopter project installs it.",
};

/**
 * The kit packages the CLI reaches **statically**, each with what a version skew in it actually costs.
 *
 * A package appearing here is the loud event: it means a fourth or fifth `@pithy-sh/*` has joined the set
 * the CLI reads its own copy of, on behalf of a project that has its own. Adding one is a decision, not a
 * refactor.
 */
const RESIDUE_PACKAGES: Record<string, string> = {
  "@pithy-sh/secrets":
    "Secret names, the D1 envelope format, and the migration `pithy secrets provision` runs against the adopter's database. The name is the join key: the CLI writes what its copy calls a secret, the Worker reads what its own copy calls it.",
  "@pithy-sh/email":
    "The suppressions migration and the template engine. The CLI writes rows and renders samples the adopter's Worker then reads with its own copy.",
  "@pithy-sh/turnstile":
    "`TURNSTILE_SECRET_NAME` is the D1 row key the adopter's Worker reads through its own copy while `pithy turnstile provision` writes it through the CLI's — the join-key exposure in its plainest form. `isTurnstileCapability` is structural (`name === \"turnstile\"` plus a config field), so there is no cross-realm identity bug beside it.",
  "@pithy-sh/ui-react":
    "`TEMPLATE_DIR` and the screen manifests. The screens are **copied** into the adopter's repo rather than composed (CLAUDE.md §I18n), so the CLI's copy is the correct source and this one is residue by shape only.",
};

/**
 * Every CLI file that statically imports a residue package, and which packages it takes.
 *
 * **Per file and per package, not per specifier.** The question a reader has is *whose copy of what does
 * the CLI read, and where* — the module inside the package is that command's business, and a table of the
 * 92 specifiers would churn on every refactor while pinning nothing extra. Checked in both directions:
 * a new file, or a new package in an existing file, fails; so does an entry whose file has stopped
 * reaching.
 */
const STATIC_RESIDUE: Record<string, readonly string[]> = {
  "capabilities/addBootstrap.ts": ["@pithy-sh/secrets"],
  "capabilities/emailProvisioner.ts": ["@pithy-sh/email"],
  "capabilities/mediaProvisioner.ts": ["@pithy-sh/secrets"],
  "capabilities/mintSecrets.ts": ["@pithy-sh/secrets"],
  "capabilities/rotateSecrets.ts": ["@pithy-sh/secrets"],
  "capabilities/secretValue.ts": ["@pithy-sh/secrets"],
  "capabilities/secrets.ts": ["@pithy-sh/secrets"],
  "capabilities/secretsDispatcher.ts": ["@pithy-sh/secrets"],
  "capabilities/secretsProvisioner.ts": ["@pithy-sh/secrets"],
  "capabilities/storageProvisioner.ts": ["@pithy-sh/secrets"],
  "capabilities/storeSecretWrites.ts": ["@pithy-sh/secrets"],
  "capabilities/turnstileProvisioner.ts": ["@pithy-sh/secrets", "@pithy-sh/turnstile"],
  "commands/email.ts": ["@pithy-sh/email", "@pithy-sh/secrets"],
  "commands/media.ts": ["@pithy-sh/secrets"],
  "commands/payments.ts": ["@pithy-sh/secrets"],
  "commands/provision.ts": ["@pithy-sh/secrets"],
  "commands/secrets.ts": ["@pithy-sh/secrets"],
  "commands/storage.ts": ["@pithy-sh/secrets"],
  "commands/testers.ts": ["@pithy-sh/email", "@pithy-sh/secrets"],
  "commands/turnstile.ts": ["@pithy-sh/turnstile"],
  "devSecrets/edit.ts": ["@pithy-sh/secrets"],
  "devSecrets/file.ts": ["@pithy-sh/secrets"],
  "devSecrets/generate.ts": ["@pithy-sh/secrets"],
  "devSecrets/seed.ts": ["@pithy-sh/secrets"],
  "devSecrets/store.ts": ["@pithy-sh/secrets"],
  "devSecrets/targets.ts": ["@pithy-sh/secrets"],
  "doctor/devSecrets.ts": ["@pithy-sh/secrets"],
  "doctor/secretBindings.ts": ["@pithy-sh/secrets"],
  "feature/destroy.ts": ["@pithy-sh/secrets"],
  "feature/provision.ts": ["@pithy-sh/secrets"],
  "migrations/run.ts": ["@pithy-sh/secrets"],
  "project/environment.ts": ["@pithy-sh/secrets"],
  "project/environmentReadiness.ts": ["@pithy-sh/secrets"],
  "provision/secretBindings.ts": ["@pithy-sh/secrets"],
  "seed/prepare.ts": ["@pithy-sh/secrets"],
  "seed/run.ts": ["@pithy-sh/secrets"],
  "ui/react.ts": ["@pithy-sh/ui-react"],
};

/**
 * A dynamic reach for a kit module: `import("@pithy-sh/…")`.
 *
 * **Both type spellings are erased first, and there are two.** `typeof import("…")` is the one everybody
 * writes down; `type X = import("…").Named` is the other, and it is all over the loaders — a bare
 * `import()` in a type position, indistinguishable from a runtime one by a lookbehind for `typeof`. A
 * property access with no call after it is the tell, so that is what the second erase keys on, and the
 * negative lookahead is what keeps a real `import("…").then(` from being erased with them — spelled
 * `(?![\w$]|\s*\()` rather than `(?!\s*\()`, because the shorter form backtracks the identifier one
 * character and matches anyway.
 */
function kitReaches(source: string): string[] {
  const text = blankComments(source)
    .replaceAll(/typeof\s+import\(\s*"[^"]*"\s*\)/g, "")
    .replaceAll(/import\(\s*"[^"]*"\s*\)\s*\.\s*[A-Za-z_$][\w$]*(?![\w$]|\s*\()/g, "");
  const found: string[] = [];
  for (const match of text.matchAll(/\bimport\(\s*"(@pithy-sh\/[^"]+)"/g)) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

/**
 * The kit **packages** a file imports statically, at least one runtime binding from each.
 *
 * Anchored at column 0 with a clause that may hold no backtick, quote or semicolon: a real import clause
 * never does, and without that the lazy span reaches out of one statement and into the next string
 * literal. `capabilities/configSeams.ts` and `project/workerScaffold.ts` are why — both hold the *source
 * the CLI scaffolds into the adopter's repo*, imports and all, in a template literal. Those are the
 * adopter's imports resolved in the adopter's Worker, and reading them here would be the gate reporting a
 * project's own code as the CLI's reach.
 *
 * `import type …` and a named clause whose every specifier carries `type` are both erased at build time
 * and reach nothing at runtime. A side-effect `import "@pithy-sh/…"` has no clause at all and counts.
 */
function staticPackages(source: string): string[] {
  const text = blankComments(source);
  const found = new Set<string>();
  for (const match of text.matchAll(/^(?:import|export)\b([^`;"]*?)\bfrom\s*"(@pithy-sh\/[^"]+)"/gm)) {
    const clause = match[1] ?? "";
    if (/^\s*type\s/.test(clause)) continue;
    const open = clause.indexOf("{");
    if (open >= 0) {
      const named = clause.slice(open + 1, clause.lastIndexOf("}"));
      const specifiers = named
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const bare = clause.slice(0, open).replaceAll(/[,\s]/g, "");
      if (bare === "" && specifiers.length > 0 && specifiers.every((part) => /^type\s/.test(part))) continue;
    }
    if (match[2]) found.add(packageOf(match[2]));
  }
  for (const match of text.matchAll(/^import\s*"(@pithy-sh\/[^"]+)"/gm)) {
    if (match[1]) found.add(packageOf(match[1]));
  }
  return [...found].sort();
}

/** `@pithy-sh/secrets` from `@pithy-sh/secrets/src/keyspace`. */
function packageOf(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

/** Every `import.meta.resolve(` in a file, whatever it is given. */
function metaResolves(source: string): number {
  return [...blankComments(source).matchAll(/\bimport\.meta\.resolve\s*\(/g)].length;
}

/** Every CLI source file, keyed by its path under `src/`. */
function cliSources(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sourcePaths(CLI_SRC)) {
    const text = readSource(path);
    if (text !== null) found.set(relative(CLI_SRC, path).replaceAll("\\", "/"), text);
  }
  return found;
}

/** Every CLI source file that reaches a kit module dynamically, keyed by its path under `src/`. */
function reachingFiles(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [path, text] of cliSources()) {
    const reaches = kitReaches(text);
    if (reaches.length > 0) found.set(path, reaches);
  }
  return found;
}

/** Every CLI source file that statically imports a residue package, keyed by its path under `src/`. */
function residueFiles(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [path, text] of cliSources()) {
    const packages = staticPackages(text).filter((pkg) => !(pkg in CLI_RUNTIME));
    if (packages.length > 0) found.set(path, packages);
  }
  return found;
}

describe("kit modules resolve from the project", () => {
  test("no file reaches a kit module with a bare specifier unless it is written down", () => {
    const unrecorded = [...reachingFiles().keys()].filter((path) => !(path in CLI_OWNED));
    expect(
      unrecorded,
      "Resolve it from the project: `kitImport(projectDir, spec)` / `kitSource(projectDir, spec)` " +
        "(see project/kitResolve.ts). If this site genuinely wants the CLI's own copy, add it to " +
        "CLI_OWNED in this file with the reason. See #533.",
    ).toEqual([]);
  });

  test("an exemption that no longer exists is deleted, not left standing", () => {
    const reaching = reachingFiles();
    const stale = Object.keys(CLI_OWNED).filter((path) => !reaching.has(path));
    expect(stale, "This file no longer reaches a kit module. Delete its entry from CLI_OWNED.").toEqual([]);
  });

  test("every exemption is @pithy-sh/cloudflare, which is not a capability", () => {
    const reaching = reachingFiles();
    for (const path of Object.keys(CLI_OWNED)) {
      for (const specifier of reaching.get(path) ?? []) {
        expect(specifier, `${path} exempts a capability, not just the CF client`).toMatch(/^@pithy-sh\/cloudflare\//);
      }
    }
  });

  // `import.meta.resolve`'s base is the calling module, always, and Node 22 gives it no second parameter
  // to point anywhere else — which is the whole reason `kitResolve` is built on `createRequire`. So there
  // is no correct use of it here, and the ban is on the call rather than on a literal inside it: the one
  // site that had it passed a variable, and the gate that read literals could not see it (#533, round two).
  test("nothing resolves through import.meta.resolve, whatever it is handed", () => {
    const offenders = [...cliSources()].filter(([, text]) => metaResolves(text) > 0).map(([path]) => path);
    expect(
      offenders,
      "`import.meta.resolve` resolves from this file, not from the project. Use kitResolve(projectDir, …).",
    ).toEqual([]);
  });

  // The resolver itself, reached from where the loaders are. A cycle here would not be a slow build —
  // `capabilities/*` and `audit/*` and `doctor/*` all import it, and it must stay importable from each.
  test("the resolver imports node builtins and nothing else", () => {
    const text = readSource(join(CLI_SRC, "project", "kitResolve.ts")) ?? "";
    const imports = [...blankComments(text).matchAll(/^import\s[^"]*"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
  });
});

describe("the static residue, which no resolver can re-base", () => {
  test("every file that statically imports a kit package is recorded, with the packages it takes", () => {
    const found = [...residueFiles()].map(([path, packages]) => `${path}: ${packages.join(", ")}`).sort();
    const recorded = Object.entries(STATIC_RESIDUE)
      .map(([path, packages]) => `${path}: ${[...packages].sort().join(", ")}`)
      .sort();
    expect(
      found,
      "A static import cannot be resolved from the project — it is bound before any code runs. If this " +
        "file must read the adopter's copy, give it a project-based loader; otherwise record it in " +
        "STATIC_RESIDUE with the packages it takes. See #533.",
    ).toEqual(recorded);
  });

  test("no residue package arrives without its cost written down", () => {
    const taken = new Set([...residueFiles().values()].flat());
    expect([...taken].sort()).toEqual(Object.keys(RESIDUE_PACKAGES).sort());
  });

  // The two lists answer different questions and must not overlap: `CLI_RUNTIME` is *not the adopter's*,
  // `RESIDUE_PACKAGES` is *the adopter's and read from the wrong copy anyway*. A package in both would be
  // an exemption granted twice, on two incompatible grounds.
  test("a package is the CLI's own runtime or it is residue, never both", () => {
    const both = Object.keys(RESIDUE_PACKAGES).filter((pkg) => pkg in CLI_RUNTIME);
    expect(both).toEqual([]);
  });

  // Named because round one closed #533 for every capability that had a loader and left this one with no
  // project-based resolution at all — in neither list, reached only through the CLI's own copy, and
  // therefore invisible to both halves of the gate.
  test("turnstile is a catalog capability an adopter installs, and it is accounted for", () => {
    expect(RESIDUE_PACKAGES["@pithy-sh/turnstile"]).toBeDefined();
    expect(STATIC_RESIDUE["commands/turnstile.ts"]).toContain("@pithy-sh/turnstile");
    expect(STATIC_RESIDUE["capabilities/turnstileProvisioner.ts"]).toContain("@pithy-sh/turnstile");
  });
});

describe("the extractor itself", () => {
  test("reads a runtime import and skips a type position", () => {
    expect(kitReaches('await import("@pithy-sh/payments/src/capability");')).toEqual([
      "@pithy-sh/payments/src/capability",
    ]);
    expect(kitReaches('type M = typeof import("@pithy-sh/payments/src/capability");')).toEqual([]);
    expect(kitReaches('type C = import("@pithy-sh/payments/src/config/config").PaymentsConfig;')).toEqual([]);
    // The one property access that *is* a runtime reach, so the erase above cannot be a blanket one.
    expect(kitReaches('import("@pithy-sh/vector/src/capability").then(use);')).toEqual([
      "@pithy-sh/vector/src/capability",
    ]);
  });

  test("a specifier inside a comment is prose, not a reach", () => {
    expect(kitReaches('// was: await import("@pithy-sh/payments/src/capability")\n')).toEqual([]);
  });

  test("the project-based call shape is not a bare reach", () => {
    expect(kitReaches('kitImport<M>(projectDir, "@pithy-sh/payments/src/capability");')).toEqual([]);
  });

  test("import.meta.resolve counts whether or not its argument is a literal", () => {
    expect(metaResolves('const p = import.meta.resolve("@pithy-sh/email/src/workflows/worker");')).toBe(1);
    expect(metaResolves("const p = import.meta.resolve(specifier);")).toBe(1);
    expect(metaResolves("// import.meta.resolve(specifier)\n")).toBe(0);
  });

  test("a static value import counts and a type-only one does not", () => {
    expect(staticPackages('import { TURNSTILE_SECRET_NAME } from "@pithy-sh/turnstile/src/secret/registry";')).toEqual([
      "@pithy-sh/turnstile",
    ]);
    expect(staticPackages('import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";')).toEqual([]);
    expect(staticPackages('import { type A, type B } from "@pithy-sh/secrets/src/registry";')).toEqual([]);
    expect(staticPackages('import { type A, run } from "@pithy-sh/secrets/src/registry";')).toEqual([
      "@pithy-sh/secrets",
    ]);
    expect(staticPackages('import "@pithy-sh/secrets/src/side-effect";')).toEqual(["@pithy-sh/secrets"]);
    expect(staticPackages('import {\n  a,\n  type b,\n} from "@pithy-sh/email/src/x";')).toEqual(["@pithy-sh/email"]);
  });

  // The scaffolded-source case, which is the adopter's import and not ours. Both files that hold one are
  // real, and reading their contents as the CLI's reach is how `@pithy-sh/payments` appeared in a residue
  // it has no business being in.
  test("an import inside a template literal is the adopter's code, not a reach", () => {
    const source = 'const seam = `import { unimplementedSubject } from "@pithy-sh/payments/src/index";\n`;\n';
    expect(staticPackages(source)).toEqual([]);
  });
});
