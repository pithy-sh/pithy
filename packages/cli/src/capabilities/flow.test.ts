// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest, type ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { readDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import type { DatabaseRun } from "../migrations/run";
import { installPackage } from "../project/packageManager";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { fixOf } from "../terminal/exitClass";
import { coerceSetFlags, collectSetFlags, isHandWritten, runAdd } from "./flow";

const optionManifest = CapabilityManifest.parse({
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [{ type: "d1", name: "DB" }],
  configOptions: [
    { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
    { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
    { key: "cookies", default: true, describe: "Enable cookie sessions." },
  ],
});

/** Options a manifest can only scaffold empty — the shape `@pithy-sh/secrets` needs for its registry. */
const handWrittenManifest = CapabilityManifest.parse({
  name: "secrets",
  package: "@pithy-sh/secrets",
  requiredBindings: [],
  configOptions: [
    { key: "registry", default: {}, describe: "Your secrets. Declare each one here." },
    { key: "boards", default: [], describe: "Every board this app ranks." },
  ],
});

/**
 * A capability with a **required** option: no default, a closed set of choices.
 *
 * The shape #412 landed. `billingSubject` decides whether an entitlement is held by a person or a
 * company, it lands in a column and a UNIQUE index, and there is no answer the kit is entitled to pick
 * on an adopter's behalf — so the manifest states none, and every path that could write a config has to
 * get one from the caller or refuse.
 */
const requiredManifest = CapabilityManifest.parse({
  name: "payments",
  package: "@pithy-sh/payments",
  requiredBindings: [],
  configOptions: [
    { key: "basePath", default: "/payments", describe: "Where the payments routes mount." },
    { key: "billingSubject", choices: ["user", "organization"], describe: "Who holds a subscription." },
  ],
});

describe("coerceSetFlags", () => {
  test("coerces values to each option's type", () => {
    expect(coerceSetFlags(optionManifest, ["basePath=/api/auth", "sessionDays=7", "cookies=false"])).toEqual({
      basePath: "/api/auth",
      sessionDays: 7,
      cookies: false,
    });
  });

  test("an unknown key fails with the valid keys", () => {
    const error = coerceSetFlags.bind(null, optionManifest, ["nope=1"]);
    expect(error).toThrow(PithyError);
    expect(error).toThrow(/nope/);
  });

  test("a missing = fails", () => {
    expect(() => coerceSetFlags(optionManifest, ["basePath"])).toThrow(/key=value/);
  });

  test("a non-numeric number and a non-boolean boolean fail", () => {
    expect(() => coerceSetFlags(optionManifest, ["sessionDays=lots"])).toThrow(/number/);
    expect(() => coerceSetFlags(optionManifest, ["cookies=maybe"])).toThrow(/boolean/);
  });

  test("an option the adopter writes by hand is refused, not stringified", () => {
    // The secrets registry: a manifest states it as `{}` so the generated config compiles (#161), and
    // there it stops. `--set` carries a string, and the old fall-through returned the raw one — which
    // would have composed `registry: "d1"` as the registry and been accepted by nothing.
    const error = coerceSetFlags.bind(null, handWrittenManifest, ["registry=d1"]);
    expect(error).toThrow(PithyError);
    expect(error).toThrow(/not settable from the command line/);
  });
});

describe("a required option — one the manifest states no default for", () => {
  test("--set carries one of its choices through", () => {
    expect(coerceSetFlags(requiredManifest, ["billingSubject=organization"])).toEqual({
      billingSubject: "organization",
    });
  });

  test("a value outside the choices is refused, naming the option and the legal set", () => {
    let caught: unknown;
    try {
      coerceSetFlags(requiredManifest, ["billingSubject=nonsense"]);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(PithyError);
    const error = caught as PithyError;
    expect(error.message).toContain("billingSubject");
    // The legal set is the operator's line, so it is on the action — the half an agent corrects from.
    expect(error.payload.action).toContain("user");
    expect(error.payload.action).toContain("organization");
  });

  test("it is not hand-written — an absent default is a question, not a registry", () => {
    const option = requiredManifest.configOptions[1] as ConfigOption;
    expect(option.key).toBe("billingSubject");
    expect(isHandWritten(option)).toBe(false);
  });
});

describe("isHandWritten", () => {
  test("is true for an option whose value is an object or an array, false for the scalars", () => {
    const byKey = new Map(handWrittenManifest.configOptions.map((option) => [option.key, option]));
    expect(isHandWritten(byKey.get("registry") as ConfigOption)).toBe(true);
    expect(isHandWritten(byKey.get("boards") as ConfigOption)).toBe(true);
    for (const option of optionManifest.configOptions) expect(isHandWritten(option)).toBe(false);
  });
});

describe("collectSetFlags", () => {
  test("collects every repeated --set, not just the last (citty keeps only the last)", () => {
    expect(collectSetFlags(["add", "auth", "--set", "basePath=/x", "--set", "sessionDays=7"])).toEqual([
      "basePath=/x",
      "sessionDays=7",
    ]);
  });

  test("handles the --set=key=value form", () => {
    expect(collectSetFlags(["--set=basePath=/x", "--set=cookies=false"])).toEqual(["basePath=/x", "cookies=false"]);
  });

  test("a trailing --set with no value is ignored", () => {
    expect(collectSetFlags(["--set"])).toEqual([]);
  });

  test("no --set flags yields an empty list", () => {
    expect(collectSetFlags(["add", "auth", "--json"])).toEqual([]);
  });
});

describe("runAdd", () => {
  let dir: string;
  /** The Worker being wired. The package installs at the project root; the wiring lands here. */
  let worker: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-flow-"));
    await scaffoldProject({ targetDir: dir, appName: "flow-test" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stub installer that drops the capability's manifest where loadManifest reads it. */
  function installManifest(manifest: unknown) {
    return async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
      const name = pkg.replace("@pithy-sh/", "");
      const pkgDir = join(projectDir, "node_modules", "@pithy-sh", name);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
      return { packageManager: "bun" };
    };
  }

  const noMigrations: DatabaseRun[] = [];
  const migrateStub = vi.fn(async () => noMigrations);

  test("installs, loads the manifest, wires config + bindings, then migrates", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const databases: DatabaseRun[] = [{ database: "auth", binding: "DB", results: [] }];
    const migrate = vi.fn(async () => databases);

    const result = await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      setFlags: ["basePath=/authentication", "sessionDays=7"],
      install,
      migrate,
    });

    // Install ran for the scoped package.
    expect(install).toHaveBeenCalledWith({ projectDir: dir, pkg: "@pithy-sh/auth" });
    // Config was wired with every override before migration ran.
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toContain('basePath: "/authentication",');
    expect(config).toContain("sessionDays: 7,");
    expect(config).toContain("cookies: true,"); // un-set option keeps its default
    // Migration ran against the project after wiring — and named it. `add` finishes by writing to a
    // database, so it claims it for this project rather than leaving it unowned for the next one.
    expect(migrate).toHaveBeenCalledWith({
      projectDir: dir,
      workerDir: worker,
      worker: DEFAULT_WORKER,
      project: "acme",
      account: null,
    });
    expect(result).toEqual({
      capability: "auth",
      // No `worker` was passed, so the deployed name falls back to the directory and the two agree.
      // `runAdd`'s own "names the Worker by its directory" test is where they are made to disagree.
      worker: DEFAULT_WORKER,
      deployedAs: DEFAULT_WORKER,
      package: "@pithy-sh/auth",
      packageManager: "bun",
      databases,
      // auth declares no KV binding here, so there is nothing to propose a name for.
      kvNamespaces: [],
      // Every binding auth needs is one `add` writes, so there is nothing left to say.
      notes: [],
      // This fixture's manifest declares no peers, so nothing was composed on the way in.
      prerequisites: [],
      eject: undefined,
    });
  });

  test("names the Worker by its directory, and reports the deployed name separately", async () => {
    // A Worker deploys as `<project>-<worker>`, so these two strings are what `pithy add --worker board`
    // has in hand on a project named `acme`. They must not collapse into one field: `worker` is what
    // `--worker` accepts and what a caller can act on, `deployedAs` is what Cloudflare shows.
    const result = await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      worker: "acme-api",
      project: "acme",
      capability: "auth",
      install: installManifest(optionManifest),
      migrate: async () => [],
    });

    expect(result).toMatchObject({ worker: DEFAULT_WORKER, deployedAs: "acme-api" });
    // Not merely different — the directory is read from `workerDir`, never derived by stripping a
    // project prefix off the deployed name. A `wrangler.jsonc` may name the Worker anything.
    expect(result.worker).not.toBe(result.deployedAs);
  });

  /**
   * The acceptance criterion of #412.
   *
   * `pithy add payments --json` used to pick a billing model. The manifest had no concept of a required
   * option — `default` was a required field — so a non-interactive run attached no prompt, fell straight
   * through to whatever the manifest happened to state, wrote it into a column and a UNIQUE index, and
   * exited 0. A project that meant `organization` found out when it had subscriptions.
   *
   * So the refusal is asserted on its **action string**, not on the fact that something threw. The action
   * is the operator's, and the only thing that makes an agent-driven run recoverable is that it names the
   * exact flag and the values that flag takes.
   */
  test("a non-interactive run that names no value for a required option is refused, naming the flag and the choices", async () => {
    const error = (await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "payments",
      install: installManifest(requiredManifest),
      // A local stub: `migrateStub` is shared, and a later test asserts it was never called.
      migrate: async () => noMigrations,
    }).catch((thrown: unknown) => thrown)) as PithyError;

    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("billingSubject");
    const action = error.payload.action ?? "";
    expect(action).toContain("--set billingSubject=user");
    expect(action).toContain("--set billingSubject=organization");
    // Nothing was written. A refusal that half-wired the config would be the defect one step along.
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).not.toContain("payments(");
  });

  test("the same run with --set billingSubject=organization succeeds and renders it", async () => {
    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "payments",
      setFlags: ["billingSubject=organization"],
      install: installManifest(requiredManifest),
      // A local stub: `migrateStub` is shared, and a later test asserts it was never called.
      migrate: async () => noMigrations,
    });

    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('billingSubject: "organization",');
    // The option that does have a default still takes it — nothing about the other options moved.
    expect(config).toContain('basePath: "/payments",');
  });

  // #711: a free-text option's value is the caller's, and the line naming the run again quotes it. A builder that read
  // `<hi@acme.io>` as a placeholder turned this run into `core/internal` after it had installed the package.
  test("a free-text value with angle brackets in it is a value, and the add finishes", async () => {
    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      setFlags: ["basePath=/auth <hi@acme.io>"],
      install: installManifest(optionManifest),
      migrate: async () => noMigrations,
    });
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain('basePath: "/auth <hi@acme.io>",');
  });

  test("--set billingSubject=nonsense is refused before anything is installed into the config", async () => {
    const error = (await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "payments",
      setFlags: ["billingSubject=nonsense"],
      install: installManifest(requiredManifest),
      // A local stub: `migrateStub` is shared, and a later test asserts it was never called.
      migrate: async () => noMigrations,
    }).catch((thrown: unknown) => thrown)) as PithyError;

    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("billingSubject");
    expect(`${error.message} ${error.payload.action ?? ""}`).toContain("organization");
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).not.toContain("payments(");
  });

  test("a prompt that answers it is enough — the refusal is about a value, not about a flag", async () => {
    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "payments",
      install: installManifest(requiredManifest),
      // A local stub: `migrateStub` is shared, and a later test asserts it was never called.
      migrate: async () => noMigrations,
      prompt: async (_manifest, provided) => ({ ...provided, billingSubject: "user" }),
    });

    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain('billingSubject: "user",');
  });

  test("a re-run over a registration that spreads its options in is not refused for a required option", async () => {
    // The spread may carry `billingSubject`, and the text cannot say it does not. `add` asks the question
    // `upgrade` asks, through the one answer (`statesKey`), so it neither refuses nor rewrites (#590 review).
    const path = join(worker, "pithy.config.ts");
    const scaffolded = await readFile(path, "utf8");
    const marker = "    // pithy:capabilities";
    expect(scaffolded).toContain(marker);
    await writeFile(path, scaffolded.replace(marker, `    payments({ ...billing }),\n${marker}`));

    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "payments",
      install: installManifest(requiredManifest),
      migrate: async () => noMigrations,
    });

    expect(await readFile(path, "utf8")).not.toContain("billingSubject");
  });

  test("mints the secrets dev master key and reports it — `pithy dev` serves the moment add finishes", async () => {
    const secrets = CapabilityManifest.parse({
      name: "secrets",
      package: "@pithy-sh/secrets",
      requiredBindings: [
        { type: "d1", name: "SECRETS" },
        { type: "secret", name: "SECRETS_ENCRYPTION_KEYS" },
      ],
    });

    const result = await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "secrets",
      install: vi.fn(installManifest(secrets)),
      migrate: vi.fn(async () => noMigrations),
    });

    // The dev secrets file — the one source of dev secret values, and where `pithy add secrets` mints
    // the master key now (#179). It used to land in `dev.json` under `vars`, from which the generator
    // copied it into each Worker's `.dev.vars`; the generator reads this file directly instead.
    //
    // **The generated `.dev.vars` is not asserted here, and that is the fixture's limit rather than the
    // behavior's.** Materializing a `cf-secrets-store` secret needs the Worker's *composition* — the
    // registry is what says the master key is one — and this fixture is scaffolded in the OS tmpdir,
    // where `pithy.config.ts`'s `@pithy-sh/*` imports resolve against nothing. `targets.test.ts` and
    // `generate.test.ts` scaffold inside the package for exactly that reason, and cover the rest.
    // The entry itself, with nothing taken off it: its binding carries a bare `EncryptionConfig`, so
    // that is what the file states (#323).
    const stated = (await readDevSecrets(await resolveDevSecretsFile(dir))).SECRETS_ENCRYPTION_KEYS;
    expect(EncryptionConfig.parse(stated).currentVersion).toBe("1");
    expect(result.notes.join(" ")).toMatch(/pithy secrets provision/);
  });

  test("threads the project name through, so add proposes <project>-<env>-<binding>", async () => {
    const result = await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install: vi.fn(
        installManifest(
          CapabilityManifest.parse({
            name: "auth",
            package: "@pithy-sh/auth",
            requiredBindings: [
              { type: "d1", name: "DB" },
              { type: "kv", name: "SESSIONS" },
            ],
          }),
        ),
      ),
      // A local stub: `migrateStub` is shared, and a later test asserts it was never called.
      migrate: vi.fn(async () => noMigrations),
    });

    expect(result.kvNamespaces).toContainEqual({
      binding: "SESSIONS",
      env: "prod",
      name: "acme-prod-sessions",
    });
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"database_name": "acme-dev-db"');
  });

  test("an uninstalled capability (install left no manifest) fails naming it", async () => {
    const install = vi.fn(async () => ({ packageManager: "npm" }));
    await expect(
      runAdd({
        account: null,
        projectDir: dir,
        workerDir: worker,
        project: "acme",
        capability: "ghost",
        install,
        migrate: migrateStub,
      }),
    ).rejects.toThrow(/ghost/);
    expect(migrateStub).not.toHaveBeenCalled();
  });

  test("a linked checkout installs nothing and still wires — the skip and the manifest read agree", async () => {
    // The real install step, not a stub: `installPackage` must decline to spawn, and `loadManifest`
    // must then find the manifest in the very directory the skip was decided from. When those two
    // disagreed, `pithy add secrets` skipped the install and answered "No capability named secrets is
    // installed. Run pithy add secrets to install it." — a dead end with no flag out of it.
    const checkout = join(dir, "checkout", "auth");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "@pithy-sh/auth" }));
    await writeFile(join(checkout, "pithy.manifest.json"), JSON.stringify(optionManifest));
    await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(checkout, join(dir, "node_modules", "@pithy-sh", "auth"), "dir");

    // The real `installPackage`, with only its spawner replaced. The outcome alone did not pin this:
    // with the guard reverted the tmpdir has no lockfile, so the test spawned `npm install
    // @pithy-sh/auth` against the live registry — an E404 today (a failure for the wrong reason, and no
    // failure at all offline), and a passing test the day the scope publishes. A recording runner is
    // the assertion the outcome could not make: nothing spawned.
    const spawned: string[] = [];
    const result = await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install: (input) =>
        installPackage({
          ...input,
          run: async (command, args) => {
            spawned.push(`${command} ${args.join(" ")}`);
          },
        }),
      migrate: vi.fn(async () => noMigrations),
    });

    expect(spawned).toEqual([]);
    expect(result.capability).toBe("auth");
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain('from "@pithy-sh/auth/src/index"');
  });

  test("prompts for un-set options when a prompt seam is supplied", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const prompt = vi.fn(async (_manifest, provided) => ({ ...provided, basePath: "/from-prompt" }));

    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
      prompt,
    });

    expect(prompt).toHaveBeenCalledOnce();
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('basePath: "/from-prompt",');
  });

  test("is idempotent — a second run leaves config and wrangler unchanged", async () => {
    const install = vi.fn(installManifest(optionManifest));
    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
    });
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
    });
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(config);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(wrangler);
  });

  test("audits a successful add as capability/added, info severity", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const events: CliAuditEvent[] = [];

    await runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
      audit: async (event) => void events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/added",
        outcome: "success",
        severity: "info",
        resourceType: "capability",
        resourceId: "auth",
        // `targetWorker`, not `worker`: this is the Worker the capability was added TO, which is a
        // different thing from the `worker` origin column (null for a CLI action, which came from none).
        metadata: { targetWorker: DEFAULT_WORKER, package: "@pithy-sh/auth", packageManager: "bun", ejected: false },
      }),
    ]);
  });

  test("audits a failed add — an uninstalled capability — as a failure, and rethrows", async () => {
    const install = vi.fn(async () => ({ packageManager: "npm" }));
    const events: CliAuditEvent[] = [];

    await expect(
      runAdd({
        account: null,
        projectDir: dir,
        workerDir: worker,
        project: "acme",
        capability: "ghost",
        install,
        migrate: migrateStub,
        audit: async (event) => void events.push(event),
      }),
    ).rejects.toThrow(/ghost/);

    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/added",
        outcome: "failure",
        severity: "info",
        resourceType: "capability",
        resourceId: "ghost",
      }),
    ]);
  });
});

/**
 * **What `pithy add` does about a capability's declared prerequisites — the decision, and its shape.**
 *
 * The manifest has always carried `peerCapabilities` and `createBackend` has always refused to assemble
 * without them; between the two, `pithy add` read the declaration from nowhere and reported `Done.` on a
 * Worker that could not start (#273).
 *
 * Three answers, and which one a run gets is decided by what can be asked of it. A flag composes them. A
 * human is asked once, for the whole cascade. Anything else is refused, naming the commands in the order
 * they have to run — because a run that cannot answer a question must not have one answered for it, and
 * "compose two capabilities nobody named" is the wrong default to pick in silence.
 */
describe("runAdd prerequisites", () => {
  let dir: string;
  let worker: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-prereq-"));
    await scaffoldProject({ targetDir: dir, appName: "prereq-test" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The real graph in miniature: auth ⇒ secrets + email, email ⇒ secrets. Every manifest binding-free. */
  const GRAPH: Record<string, unknown> = {
    auth: {
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      peerCapabilities: ["secrets", "email"],
    },
    email: { name: "email", package: "@pithy-sh/email", requiredBindings: [], peerCapabilities: ["secrets"] },
    secrets: { name: "secrets", package: "@pithy-sh/secrets", requiredBindings: [] },
  };

  /**
   * An installer that drops **whichever** manifest was asked for.
   *
   * The single-manifest stub above cannot express this defect: it answers every package with the same
   * file, so a walk over the graph would find `auth` requiring `auth`. A prerequisite is a different
   * package with a different manifest, and that is the whole subject.
   */
  const install = async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
    const name = pkg.replace("@pithy-sh/", "");
    const pkgDir = join(projectDir, "node_modules", "@pithy-sh", name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(GRAPH[name]));
    return { packageManager: "bun" as const };
  };

  const base = () => ({
    account: null,
    projectDir: dir,
    workerDir: worker,
    project: "acme",
    capability: "auth",
    install,
    migrate: async () => [] as DatabaseRun[],
  });

  test("a non-interactive run is refused, naming the commands in dependency order", async () => {
    const error = await runAdd(base()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    // The action, not just the message: the commands and their order are the part an adopter acts on,
    // and `pithy add email` before `pithy add secrets` reproduces the defect one capability along.
    expect((error as PithyError).payload).toMatchObject({
      // Nobody could be asked, so the answer is missing rather than wrong (#697): `input/required`,
      // naming the flag that gives it.
      code: "input/required",
      flag: "--with-prerequisites",
      message: `auth requires secrets and email, which ${DEFAULT_WORKER} does not compose.`,
      action: `Run \`pithy add auth --worker ${DEFAULT_WORKER} --with-prerequisites\`, or compose them first: \`pithy add secrets --worker ${DEFAULT_WORKER}\`, then \`pithy add email --worker ${DEFAULT_WORKER}\`.`,
    });
    // #711: its `fix` is the command the action leads with, naming the Worker the caller was wiring, so a
    // project with several Workers runs it as written.
    expect(fixOf(error as PithyError)).toBe(`pithy add auth --worker ${DEFAULT_WORKER} --with-prerequisites`);

    // Refused before anything was wired. An install happened — that is how the manifest was readable at
    // all — but the config is untouched, so the adopter is not left with half of what they asked for.
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).not.toMatch(/^\s*auth\(/m);
  });

  // The refusal's fix is the caller's own run with the flag it lacked (#711): an --eject or a --force it dropped is a
  // fix that composes from the package what the caller asked to eject, and a dry run's fix that drops --dry-run
  // writes what the caller asked only to see.
  test.each([
    [{ eject: true }, "--eject"],
    [{ eject: true, force: true }, "--eject --force"],
    [{ dryRun: true }, "--dry-run"],
    // An agent that asked for one JSON document gets one from the fix it runs, too.
    [{ json: true }, "--json"],
    [{ dryRun: true, json: true }, "--dry-run --json"],
  ])("a refusal of %o names the caller's own flags in its fix and its action", async (flags, carried) => {
    const error = await runAdd({ ...base(), ...flags }).catch((thrown: unknown) => thrown);
    const fix = `pithy add auth --worker ${DEFAULT_WORKER} --with-prerequisites ${carried}`;
    expect(fixOf(error as PithyError)).toBe(fix);
    expect((error as PithyError).payload.action?.startsWith(`Run \`${fix}\`,`)).toBe(true);
  });

  // #711: the refusal names the caller's `--set` again, and a value a builder read as a placeholder made building
  // it throw — `core/internal` where the caller should get the `input/required` that names the flag.
  test("a --set value shaped like a placeholder is quoted in the refusal, which stays input/required", async () => {
    const error = await runAdd({ ...base(), setFlags: ["fromName=Acme <hi@acme.io>"] }).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as PithyError).payload.code).toBe("input/required");
    expect(fixOf(error as PithyError)).toBe(
      `pithy add auth --worker ${DEFAULT_WORKER} --with-prerequisites --set 'fromName=Acme <hi@acme.io>'`,
    );
  });

  // A refusal raised inside a composed prerequisite names the caller's own run again, from its context (#711): the
  // nested add named itself — `pithy add secrets` — and dropped the caller's --json and --set, so an agent that ran
  // it got human text and composed only secrets, with auth and email still missing and nothing saying so.
  test("a refusal inside a composed prerequisite names the caller's own run, every flag and --set", async () => {
    const config = join(worker, "pithy.config.ts");
    const source = await readFile(config, "utf8");
    await writeFile(
      config,
      source
        .split("\n")
        .filter((line) => !line.includes("pithy:capabilities"))
        .join("\n"),
    );
    const error = await runAdd({ ...base(), withPrerequisites: true, json: true, setFlags: ["x=y"] }).catch(
      (thrown: unknown) => thrown,
    );
    const action = (error as PithyError).payload.action ?? "";
    expect(action).toContain(
      `Run \`pithy add auth --worker ${DEFAULT_WORKER} --with-prerequisites --set x=y --json\` again.`,
    );
    expect(action).not.toContain("pithy add secrets");
  });

  // An option the Worker's config already answers is settled for every line naming the run (#711): the prerequisite
  // refusal named one command per billing model, one contradicting the config, and gave no fix at all.
  test("the prerequisite refusal settles an option the Worker's config already answers, and has a fix", async () => {
    const payments = {
      name: "payments",
      package: "@pithy-sh/payments",
      requiredBindings: [],
      peerCapabilities: ["secrets"],
      configOptions: [{ key: "billingSubject", describe: "Who pays.", choices: ["user", "organization"] }],
    };
    const config = join(worker, "pithy.config.ts");
    const source = await readFile(config, "utf8");
    await writeFile(
      config,
      source.replace(
        /^(\s*)\/\/ pithy:capabilities.*$/m,
        (line, indent: string) => `${line}\n${indent}payments({ billingSubject: "organization" }),`,
      ),
    );
    const error = await runAdd({
      ...base(),
      capability: "payments",
      json: true,
      install: async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
        const name = pkg.replace("@pithy-sh/", "");
        const pkgDir = join(projectDir, "node_modules", "@pithy-sh", name);
        await mkdir(pkgDir, { recursive: true });
        await writeFile(
          join(pkgDir, "pithy.manifest.json"),
          JSON.stringify(name === "payments" ? payments : GRAPH[name]),
        );
        return { packageManager: "bun" as const };
      },
    }).catch((thrown: unknown) => thrown);
    expect((error as PithyError).payload, JSON.stringify((error as PithyError).payload)).toMatchObject({
      code: "input/required",
    });
    expect(fixOf(error as PithyError)).toBe(
      `pithy add payments --worker ${DEFAULT_WORKER} --with-prerequisites --json`,
    );
    expect((error as PithyError).payload.action).not.toContain("billingSubject");
  });

  test("--with-prerequisites composes them, deepest first, and reports what it composed", async () => {
    const result = await runAdd({ ...base(), withPrerequisites: true });

    expect(result.prerequisites).toEqual(["secrets", "email"]);
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    for (const capability of ["secrets", "email", "auth"]) {
      expect(config).toMatch(new RegExp(`^\\s*${capability}\\(`, "m"));
    }
  });

  // A composed prerequisite's own notes name its own add again (#711): only `pithy add secrets` reaches the bootstrap
  // that records SECRETS_STORE_ID or mints a master key. The caller's `pithy add auth` rerun finds secrets composed,
  // never adds it again, and leaves the fault its note reported exactly where it was.
  test("a composed prerequisite's notes name its own add, with the run's mode flags", async () => {
    const seen: Record<string, string> = {};
    await runAdd({
      ...base(),
      withPrerequisites: true,
      json: true,
      dryRun: true,
      bootstrap: async ({ manifest, again }) => {
        seen[manifest.name] = again ?? "";
        return [];
      },
    });
    expect(seen.secrets).toBe(`\`pithy add secrets --worker ${DEFAULT_WORKER} --dry-run --json\``);
    expect(seen.email).toBe(`\`pithy add email --worker ${DEFAULT_WORKER} --dry-run --json\``);
    expect(seen.auth).toBe(`\`pithy add auth --worker ${DEFAULT_WORKER} --with-prerequisites --dry-run --json\``);
  });

  test("a human is asked once, for the whole cascade — not once per capability", async () => {
    // `email` needs `secrets` too. One intent is one question: the answer is carried down, and a nested
    // add that re-asked would turn `pithy add auth` into an interrogation.
    const ask = vi.fn(async () => true);
    const result = await runAdd({ ...base(), askPrerequisites: ask });

    expect(result.prerequisites).toEqual(["secrets", "email"]);
    expect(ask).toHaveBeenCalledTimes(1);
    // The question carries what the refusal it stands in for would name: the Worker by directory, and what
    // the add reads to build that refusal's commands (#711).
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "auth",
        worker: DEFAULT_WORKER,
        missing: ["secrets", "email"],
        caller: expect.objectContaining({ set: {} }),
      }),
    );
  });

  test("declining is a refusal, not a partial add", async () => {
    const error = await runAdd({ ...base(), askPrerequisites: async () => false }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    // Asked and declined is an answer, refused as one — not a question this run could not ask.
    const payload = (error as PithyError).payload as unknown as Record<string, unknown>;
    expect(payload.code).toBe("validation/invalid_input");
    expect(payload).not.toHaveProperty("flag");
    expect(payload.message).toContain("auth requires secrets and email");
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    for (const capability of ["secrets", "email", "auth"]) {
      expect(config).not.toMatch(new RegExp(`^\\s*${capability}\\(`, "m"));
    }
  });

  test("a prerequisite already composed is not composed again, and asks nothing", async () => {
    await runAdd({ ...base(), capability: "secrets", withPrerequisites: true });
    await runAdd({ ...base(), capability: "email", withPrerequisites: true });

    const ask = vi.fn(async () => true);
    const result = await runAdd({ ...base(), askPrerequisites: ask });

    // Both peers are registered already, so there is nothing missing and no question to ask. This is the
    // path an adopter who composed them by hand takes, and it must not be a prompt.
    expect(result.prerequisites).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  test("the Worker in the refusal is the one --worker takes, never the deployed script name", async () => {
    // `pithy add --worker board` on a project named replay deploys as `replay-board`. A refusal naming
    // the deployed name sends the adopter to a flag value that resolves to nothing.
    await expect(runAdd({ ...base(), worker: "acme-api" })).rejects.toThrow(`which ${DEFAULT_WORKER} does not compose`);
  });
});
