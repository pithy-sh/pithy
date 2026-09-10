// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { kitResolve, packageDirFrom, packageInstalledFrom } from "../project/kitResolve";
import { classifyCapabilityLoadFailure } from "./loadFailure";
import { loadPayments } from "./paymentsProvisioner";

const run = promisify(execFile);

/** The resolver under test, as a path a subprocess can import. Node 24 strips the types on the way in. */
const RESOLVER = join(import.meta.dirname, "..", "project", "kitResolve.ts");

/**
 * **A capability is loaded from the project that composes it, not from wherever `pithy` is installed.**
 *
 * The defect (#533), hit for real during the `pithy-sh/dashboard` bring-up on a globally installed cli
 * 0.2.2: every optional capability was reached with a bare specifier, which ESM resolves relative to the
 * **importing module** — the CLI's own `dist/`. So a project with `@pithy-sh/payments@0.2.1` installed,
 * composed in its `pithy.config.ts`, and typechecking against it was told
 *
 *     The payments capability is not installed.
 *     Run `pithy add payments`, then re-run this command.
 *
 * Both halves wrong, and the action destructive: `pithy add` rewrites a hand-built `pithy.config.ts`.
 *
 * ## How the fixture stages a defect this repository cannot otherwise reproduce
 *
 * "A capability the CLI does not depend on" cannot be staged by **absence** here. Every capability is a
 * `devDependency` of `@pithy-sh/cli` and hoisted into the workspace's own `node_modules`, so a bare
 * `import("@pithy-sh/payments/…")` from a test in this tree resolves whether or not any project has it —
 * which is exactly why every existing harness passed with the bug in place.
 *
 * So it is staged by **identity** instead, which is strictly stronger. The fixture project installs its
 * own `@pithy-sh/payments` carrying a marker the workspace's copy does not, and the assertions are that
 * the loader returns *that* one. It fails on the old code in the way the issue's silent half describes:
 * the CLI's copy resolves, nothing errors, and the wrong version answers.
 *
 * A negative pins the other side: a module the workspace's copy has and the fixture's does not must
 * **not** resolve. Anything that quietly falls back to the CLI passes the first assertion and fails this
 * one, so no fallback can be added without a red test.
 */

/** The fixture project root: a `package.json` and a `node_modules` holding one capability. */
let projectDir = "";

/**
 * A stand-in `@pithy-sh/payments`, exporting the four modules `loadPayments` asks for plus a marker.
 *
 * Real files rather than a link to `packages/payments`, because the point is that this copy is
 * distinguishable from the workspace's. Its `exports` maps `./src/*` onto `./src/*.js` — a shipped
 * package maps onto `./dist/*.js`, and the resolver reads whatever the map says, so the shape of the
 * mapping is not what is under test.
 */
async function fixturePayments(root: string, marker = "the project's copy"): Promise<void> {
  const pkg = join(root, "node_modules", "@pithy-sh", "payments");
  await mkdir(join(pkg, "src", "provision"), { recursive: true });
  await mkdir(join(pkg, "src", "workflows"), { recursive: true });
  await mkdir(join(pkg, "src", "data"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify(
      {
        name: "@pithy-sh/payments",
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./src/*": "./src/*.js" },
      },
      null,
      2,
    ),
  );
  await writeFile(join(pkg, "src", "capability.js"), `export const FIXTURE_MARKER = ${JSON.stringify(marker)};\n`);
  await writeFile(
    join(pkg, "src", "provision", "resolvePaymentsConfig.js"),
    "export const resolvePaymentsConfig = () => ({});\n",
  );
  await writeFile(join(pkg, "src", "workflows", "specs.js"), 'export const paymentsWorkerName = () => "fixture";\n');
  await writeFile(join(pkg, "src", "data", "subject.js"), "export const decodeSubjectReference = () => undefined;\n");
}

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-533-"));
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "adopter", type: "module" }, null, 2));
  await fixturePayments(projectDir);
});

describe("a capability resolves from the project, not from the CLI", () => {
  test("the module that loads is the project's copy", async () => {
    const payments = (await loadPayments(projectDir)) as unknown as { FIXTURE_MARKER?: string };
    expect(payments.FIXTURE_MARKER).toBe("the project's copy");
  });

  // The other side of the same claim. `@pithy-sh/payments/src/http/routes` exists in the workspace's copy
  // and not in the fixture's, so anything that falls back to the CLI when the project comes up short
  // resolves it. Nothing may.
  test("a module the project's copy does not have does not resolve from the CLI's", () => {
    expect(() => kitResolve(projectDir, "@pithy-sh/payments/src/http/routes")).toThrow();
  });

  // The whole reason the base matters at all: the resolution decides the *version*, and a project pins one.
  test("the CLI's own base and the project's resolve to different files", () => {
    const fromProject = kitResolve(projectDir, "@pithy-sh/payments/src/capability");
    const fromCli = kitResolve(import.meta.dirname, "@pithy-sh/payments/src/capability");
    expect(fromProject).not.toBe(fromCli);
    expect(fromProject.startsWith(projectDir)).toBe(true);
  });
});

/**
 * **A capability installed under the Worker that composes it (#533, round three).**
 *
 * The first round re-based resolution onto the project root, which fixed the global-install half and left
 * the issue's own sentence reproducible in the layout the kit tells adopters to adopt. A Worker's
 * `pithy.config.ts` is imported by absolute path, so its `import "@pithy-sh/payments/…"` resolves from
 * `apps/api/` — and `pithy payments provision` asked the **root** chain, which a per-Worker install is not
 * on. Measured on the round-two tree, against this fixture:
 *
 * ```text
 * REFUSED  The payments capability is not installed.
 *          Run `pithy add payments`, then re-run this command.
 * ```
 *
 * while `createRequire(apps/api/package.json).resolve("@pithy-sh/payments/src/capability")` answered the
 * file the Worker actually loads. pnpm's default layout is not hoisted and pnpm is first-class
 * (`project/packageManager.ts`), so this is not an exotic staging.
 *
 * The repository had already solved this shape once for manifests — `composedManifests(projectDir,
 * workerDir)` merges the root scan with the Worker's (#507) — and resolution now reaches the same places.
 * The difference is precedence, and it is deliberate: `composedManifests` is asked about **one** Worker and
 * lets that Worker's copy win, while a `pithy <capability>` command has no Worker in hand, so the root's
 * copy still wins and `apps/*` is only consulted when the root chain has nothing. Every project that
 * resolves today resolves to the identical file; what changed is that a refusal became an answer.
 */
describe("a capability installed under its Worker rather than at the root", () => {
  /** A project whose only `@pithy-sh/payments` sits in `apps/api/node_modules`. */
  let perWorker = "";
  /** That Worker's directory. */
  let apiDir = "";

  beforeAll(async () => {
    perWorker = await mkdtemp(join(tmpdir(), "pithy-533-perworker-"));
    await writeFile(
      join(perWorker, "package.json"),
      JSON.stringify({ name: "adopter", type: "module", workspaces: ["apps/*"] }, null, 2),
    );
    apiDir = join(perWorker, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "package.json"), JSON.stringify({ name: "api", type: "module" }, null, 2));
    await writeFile(join(apiDir, "wrangler.jsonc"), "{}\n");
    await fixturePayments(apiDir, "the worker's copy");
  });

  // The staging, asserted rather than assumed: the root chain genuinely does not carry it, so a resolution
  // that succeeds below succeeded by looking somewhere the root walk never reaches.
  test("the root chain does not carry the package at all", () => {
    expect(packageDirFrom(perWorker, "@pithy-sh/payments")).toBeNull();
  });

  test("the loader returns the Worker's copy instead of refusing", async () => {
    const payments = (await loadPayments(perWorker)) as unknown as { FIXTURE_MARKER?: string };
    expect(payments.FIXTURE_MARKER).toBe("the worker's copy");
  });

  test("the resolution lands inside the Worker's own node_modules", () => {
    const resolved = kitResolve(perWorker, "@pithy-sh/payments/src/capability");
    expect(resolved.startsWith(join(apiDir, "node_modules"))).toBe(true);
  });

  // The classifier is asked the same question the loader was, and must not answer `pithy add` — the action
  // that rewrites a hand-built `pithy.config.ts` — about a package the project plainly has.
  test("a package present only under a Worker is never called 'not installed'", () => {
    expect(packageInstalledFrom(perWorker, "@pithy-sh/payments")).toBe(true);
    const { kind, action } = classifyCapabilityLoadFailure(
      "payments",
      "@pithy-sh/payments",
      Object.assign(new Error("Cannot find module '@pithy-sh/payments/src/provision/resolvePaymentsConfig'"), {
        code: "MODULE_NOT_FOUND",
      }),
      perWorker,
    );
    expect(kind).toBe("unreachable");
    expect(action).not.toMatch(/pithy add/);
  });

  // Precedence, pinned from the side that can go wrong. A hoisted install is the common case and its answer
  // may not move: `apps/*` is a fallback, never a re-ranking, so a root copy still wins over a Worker's.
  test("the root's copy still wins when the project has one", async () => {
    const both = await mkdtemp(join(tmpdir(), "pithy-533-both-"));
    await writeFile(join(both, "package.json"), JSON.stringify({ name: "adopter", type: "module" }, null, 2));
    await mkdir(join(both, "apps", "api"), { recursive: true });
    await fixturePayments(both, "the root's copy");
    await fixturePayments(join(both, "apps", "api"), "the worker's copy");

    const payments = (await loadPayments(both)) as unknown as { FIXTURE_MARKER?: string };
    expect(payments.FIXTURE_MARKER).toBe("the root's copy");
  });

  // `apps/*` is not the dev set and this does not consult one: a directory holding an install is evidence of
  // an install whatever its manifest says. What it is not is a license to wander — a sibling of `apps/` is
  // not a Worker, and a package parked there stays unresolvable.
  test("a node_modules outside apps/ is not consulted", async () => {
    const stray = await mkdtemp(join(tmpdir(), "pithy-533-stray-"));
    await writeFile(join(stray, "package.json"), JSON.stringify({ name: "adopter", type: "module" }, null, 2));
    await mkdir(join(stray, "tools", "scratch"), { recursive: true });
    await fixturePayments(join(stray, "tools", "scratch"), "somewhere else");

    expect(packageInstalledFrom(stray, "@pithy-sh/payments")).toBe(false);
    expect(() => kitResolve(stray, "@pithy-sh/payments/src/capability")).toThrow(/Cannot find package/);
  });
});

describe("the refusal a load failure earns", () => {
  /** What node throws when a subpath under an installed package has no file — #533's honest remainder. */
  function missingSubpath(specifier: string): unknown {
    return Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" });
  }

  test("a package that is present is never called 'not installed', and never earns `pithy add`", () => {
    const { kind, message, action } = classifyCapabilityLoadFailure(
      "payments",
      "@pithy-sh/payments",
      missingSubpath("@pithy-sh/payments/src/provision/resolvePaymentsConfig"),
      projectDir,
    );
    expect(kind).toBe("unreachable");
    expect(message).not.toMatch(/is not installed/);
    // The destructive half: `pithy add payments` reinstalls nothing and then rewrites the adopter's
    // hand-built `pithy.config.ts`. It must not be printed for a package that is already there.
    expect(action).not.toMatch(/pithy add/);
    expect(action).toMatch(/bun install/);
  });

  test("a package that genuinely is not there still earns it", () => {
    const { kind, action } = classifyCapabilityLoadFailure(
      "support",
      "@pithy-sh/support",
      missingSubpath("@pithy-sh/support/src/capability"),
      projectDir,
    );
    expect(kind).toBe("not-installed");
    expect(action).toContain("pithy add support");
  });

  // A resolved absolute path is not a specifier, and never travels in an action — `loadFailure.test.ts`
  // asserts the same property from the other end. Before #533 this fell through to
  // `dependency-unresolved` and interpolated the path straight into the remedy.
  test("a missing file inside a package names no path", () => {
    const { kind, action } = classifyCapabilityLoadFailure(
      "payments",
      "@pithy-sh/payments",
      missingSubpath("/private/tmp/x/node_modules/@pithy-sh/payments/dist/workflows/specs.js"),
      projectDir,
    );
    expect(kind).toBe("broken");
    expect(action).not.toContain("/private/tmp");
    expect(action).not.toMatch(/pithy add/);
  });
});

/**
 * **The walk and the resolver are not allowed to disagree about what the project has.**
 *
 * #533's headline — *a capability the project does not have is refused* — rested on a resolver throwing,
 * and a resolver is a runtime's opinion. Two of the ones this code runs under hold a different one:
 *
 * ```text
 * # a project with no node_modules anywhere on its ancestor chain
 * bun  probe.mjs  @pithy-sh/payments/src/capability => ~/.bun/install/cache/@pithy-sh/payments@0.2.1@@@1/dist/capability.js
 * node probe.mjs  @pithy-sh/payments/src/capability => MODULE_NOT_FOUND
 * ```
 *
 * Bun answers an absent package out of its **global install cache**. So under Bun `not-installed` was
 * unreachable, the adopter got the refusal that says the package *is* installed, and `kitSource` on the
 * same resolution would have handed wrangler a worker directory inside the cache to deploy under the
 * adopter's name — #533's own defect class, one layer over. `packageInstalledFrom` (a directory walk) and
 * `kitResolve` (a resolution) contradicted each other, and the fixture above could not see it because it
 * installs a copy, so the fallback is never reached.
 *
 * ## Why this is staged with `NODE_PATH` rather than with Bun
 *
 * The suite runs on **Node** — `bunx vitest` resolves vitest's binary and vitest's own shebang is
 * `#!/usr/bin/env node` — which is the same runtime `bin.ts` selects, so the adopter is not exposed and a
 * Bun subprocess would be testing a second runtime rather than this code. It would also be a **network**
 * test: Bun's fallback asks the registry for the version it names, and against an unreachable registry it
 * throws like Node. A gate that needs the network to fail is not a gate.
 *
 * So what is pinned is the property rather than one runtime's habit: **a resolution that lands outside the
 * package the project's own chain names is refused, whatever put it there.** `NODE_PATH` is Node's own
 * global fallback and stages exactly that disagreement — the walk finds nothing, the resolver finds a copy
 * somewhere the project never named — hermetically, offline, in the runtime the suite already runs. Bun's
 * cache, `NODE_PATH`, and whatever the next runtime adds are the same fault, and this refuses all three.
 */
describe("a resolution the project's own node_modules does not account for", () => {
  /** A project with a `package.json` and nothing else — no `node_modules`, on any ancestor. */
  let bareDir = "";
  /** A `@pithy-sh/payments` somewhere the project never named, reachable only through `NODE_PATH`. */
  let elsewhere = "";

  beforeAll(async () => {
    bareDir = await mkdtemp(join(tmpdir(), "pithy-533-bare-"));
    await writeFile(join(bareDir, "package.json"), JSON.stringify({ name: "bare", type: "module" }, null, 2));

    elsewhere = await mkdtemp(join(tmpdir(), "pithy-533-elsewhere-"));
    const pkg = join(elsewhere, "@pithy-sh", "payments");
    await mkdir(join(pkg, "src"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@pithy-sh/payments",
        version: "9.9.9",
        type: "module",
        exports: { "./src/*": "./src/*.js" },
      }),
    );
    await writeFile(join(pkg, "src", "capability.js"), "export const FROM_ELSEWHERE = true;\n");
  });

  /** `kitResolve` in a Node process that has `NODE_PATH` set — the answer, or the refusal, as text. */
  async function withGlobalFallback(specifier: string): Promise<string> {
    const script = join(elsewhere, "ask.mjs");
    await writeFile(
      script,
      'import { pathToFileURL } from "node:url";\n' +
        "const m = await import(pathToFileURL(process.argv[2]).href);\n" +
        'try { process.stdout.write("RESOLVED " + m.kitResolve(process.argv[3], process.argv[4])); }\n' +
        'catch (error) { process.stdout.write("REFUSED " + error.message); }\n',
    );
    const { stdout } = await run(process.execPath, [script, RESOLVER, bareDir, specifier], {
      env: { ...process.env, NODE_PATH: elsewhere },
    });
    return stdout;
  }

  /**
   * The claim the staging rests on, **measured rather than asserted**.
   *
   * `kitResolve.ts` shipped a docstring saying this repository's suite runs on Bun, one file away from
   * this one saying it runs on Node, and only one of them can be right: `bunx vitest` resolves vitest's
   * own binary, whose shebang is `#!/usr/bin/env node`. Prose cannot be wrong quietly if the fact is a
   * test. Red here means the suite has moved, and the anchoring paragraph in `kitResolve.ts` — which
   * explains why a resolver's answer is checked against a filesystem walk — has to be rewritten rather
   * than deleted: the walk is what makes both runtimes agree, and it earns its keep either way.
   */
  test("the suite runs on Node, so Bun's fallback is staged and not run", () => {
    expect(process.versions.bun).toBeUndefined();
    expect(process.execPath).toBe(process.argv[0]);
  });

  test("the fixture is genuinely bare, or nothing below it means anything", () => {
    expect(packageDirFrom(bareDir, "@pithy-sh/payments")).toBeNull();
    expect(packageInstalledFrom(bareDir, "@pithy-sh/payments")).toBe(false);
  });

  // The staging itself, asserted rather than assumed: without it there is no disagreement to refuse, and
  // this whole block would pass by testing nothing. `NODE_PATH` is read once at startup, so it is a
  // subprocess or it is not a fact.
  test("the runtime really does answer with a copy the project never named", async () => {
    const { stdout } = await run(
      process.execPath,
      [
        "-e",
        'import("node:module").then(m => process.stdout.write(m.createRequire(process.argv[1] + "/package.json").resolve("@pithy-sh/payments/src/capability")))',
        bareDir,
      ],
      { env: { ...process.env, NODE_PATH: elsewhere } },
    );
    expect(stdout).toContain(elsewhere);
  });

  test("kitResolve refuses it anyway", async () => {
    const answer = await withGlobalFallback("@pithy-sh/payments/src/capability");
    expect(answer).not.toContain(elsewhere);
    expect(answer).toMatch(/^REFUSED Cannot find package '@pithy-sh\/payments'/);
  });

  // The other half of the same guard, and the one that does not need a second process: the package is on
  // the chain, and the file the resolver hands back is outside the copy the chain names. A store that
  // links files rather than directories does this, and `require.resolve` reports the real path.
  test("a file that escapes the package the chain names is refused", async () => {
    const linked = await mkdtemp(join(tmpdir(), "pithy-533-linked-"));
    await writeFile(join(linked, "package.json"), JSON.stringify({ name: "linked", type: "module" }));
    const pkg = join(linked, "node_modules", "@pithy-sh", "payments");
    await mkdir(join(pkg, "src"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@pithy-sh/payments",
        version: "0.0.0",
        type: "module",
        exports: { "./src/*": "./src/*.js" },
      }),
    );
    const outside = join(linked, "outside.js");
    await writeFile(outside, "export const OUTSIDE = true;\n");
    await symlink(outside, join(pkg, "src", "capability.js"));

    expect(packageDirFrom(linked, "@pithy-sh/payments")).toBe(pkg);
    expect(() => kitResolve(linked, "@pithy-sh/payments/src/capability")).toThrow(/Cannot find module/);
  });
});
