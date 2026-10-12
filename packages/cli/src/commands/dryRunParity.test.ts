// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ejectCapability } from "../capabilities/eject";
import { runAdd } from "../capabilities/flow";
import { planAdd } from "../capabilities/planAdd";
import { Plan, type PlanFile } from "../plan/plan";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { exitCodeOf } from "../terminal/exitClass";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { commandAt } from "../test-utils/payloadContract";
import { removeTempDir } from "../test-utils/tempRepo";
import { snapshotTree } from "../test-utils/treeSnapshot";

/**
 * **A dry run and the real run, side by side, over links that lead out of the project (#697).**
 *
 * A plan is worth reading only if it is the run. So each case builds two identical fixtures — a project and,
 * beside it, a directory outside it that the project links into — runs the command dry in one and for real in
 * the other, and holds the two to the same answer: the same exit code, the same error code, and a plan whose
 * file edits are exactly the files the real run changed, wherever they live. And the dry run changes nothing:
 * not the project, and not the trees outside it, which is the invariant the copy exists for.
 *
 * The shapes are the ones a dry run got wrong: a directory linked from outside at `apps/api/src`, a deeper one at
 * `apps/api/src/routes`, a link inside the project that resolves through a link out of it, and a file the run
 * cannot read. The commands are the four that plan in a copy: `add --eject`, `ui add`, `deploy`, `provision`.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

/** What the stub wrangler saw: the Worker's entry, read from where it ran, as a bundle would read it. */
const bundled = vi.hoisted(() => ({ entries: [] as (string | null)[] }));
vi.mock("../project/wrangler", async (importOriginal) => {
  const { readFile: read } = await import("node:fs/promises");
  const { join: joined } = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../project/wrangler")>()),
    runWrangler: async (_args: string[], options: { cwd?: string }) => {
      bundled.entries.push(await read(joined(options.cwd ?? ".", "src", "index.ts"), "utf8").catch(() => null));
      return { stdout: "", stderr: "" };
    },
  };
});

/** One fixture: a project, and a directory beside it the project's links lead into. */
interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly outside: string;
}

/** A shape of link, or of unreadable file, applied to a freshly scaffolded fixture. */
type Shape = (fixture: Fixture) => Promise<void>;

const api = (fixture: Fixture, ...parts: string[]) => join(fixture.project, "apps", DEFAULT_WORKER, ...parts);

const PLAIN = "no link at all";

const SHAPES: Record<string, Shape> = {
  /** The control: every command plans here, so every comparison below runs at least once. */
  [PLAIN]: async () => {},
  /** `apps/api/src` is a relative link to a directory outside the project. */
  "a directory link out at apps/api/src": async (fixture) => {
    await rename(api(fixture, "src"), join(fixture.outside, "src"));
    await symlink(relative(api(fixture), join(fixture.outside, "src")), api(fixture, "src"));
  },
  /** `apps/api/src/routes` is an absolute link to a directory outside the project. */
  "a directory link out at apps/api/src/routes": async (fixture) => {
    await mkdir(join(fixture.outside, "routes"), { recursive: true });
    await writeFile(join(fixture.outside, "routes", "shared.ts"), "export const shared = 1;\n");
    await symlink(join(fixture.outside, "routes"), api(fixture, "src", "routes"));
  },
  /** `apps/api/src` is a link inside the project, to `shared/src`, and `shared` is a link out of it. */
  "an in-project link that resolves through a link out": async (fixture) => {
    await mkdir(join(fixture.outside, "shared"), { recursive: true });
    await rename(api(fixture, "src"), join(fixture.outside, "shared", "src"));
    await symlink(join(fixture.outside, "shared"), join(fixture.project, "shared"));
    await symlink(relative(api(fixture), join(fixture.project, "shared", "src")), api(fixture, "src"));
  },
  /** `apps/api/wrangler.jsonc` cannot be read. */
  "an unreadable wrangler.jsonc": async (fixture) => {
    await chmod(api(fixture, "wrangler.jsonc"), 0o000);
  },
};

const UNREADABLE = "an unreadable wrangler.jsonc";
const asRoot = process.getuid?.() === 0;

/** The project and the tree outside it, together, every path absolute: what a run changed, inside and out. */
async function hashFixture(fixture: Fixture): Promise<Map<string, string>> {
  const both = new Map<string, string>();
  for (const dir of [fixture.project, fixture.outside]) {
    for (const [path, hash] of await snapshotTree(dir)) both.set(join(dir, path), hash);
  }
  return both;
}

/** The paths whose hash differs between two snapshots, or that only one of them holds. */
function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

/** Where a planned path lands in `fixture`: every link on the way followed, the last component kept for a delete. */
async function landing(fixture: Fixture, path: string): Promise<string> {
  const at = join(fixture.project, path);
  const real = await realpath(at).catch(() => null);
  if (real !== null) return real;
  return join(await landing(fixture, dirname(path)), basename(path));
}

let parent: string;
let account: ReturnType<typeof recorder>;

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  bundled.entries = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  vi.stubEnv("CLOUDFLARE_ENV", "");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("A parity run reached the network.");
  });
  parent = await realpath(await mkdtemp(join(tmpdir(), "pithy-parity-")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  // A file a case locked has to be readable again before the tree can go.
  for (const side of ["dry", "real"]) {
    await chmod(join(parent, side, "project", "apps", DEFAULT_WORKER, "wrangler.jsonc"), 0o644).catch(() => undefined);
  }
  await removeTempDir(parent);
});

/** The capability `add --eject` ejects: no bindings, two source files. */
const SECRETS = CapabilityManifest.parse({
  name: "secrets",
  package: "@pithy-sh/secrets",
  requiredBindings: [],
  configOptions: [],
});

/** A capability with a Durable Object: `add` writes its class's export into the Worker's entry, under `src/`. */
const MULTIPLAYER = CapabilityManifest.parse({
  name: "multiplayer",
  package: "@pithy-sh/multiplayer",
  requiredBindings: [
    {
      type: "durable_object",
      name: "SESSIONS",
      className: "MultiplayerSession",
      classModule: "@pithy-sh/multiplayer/src/session/durableObject",
    },
  ],
  configOptions: [],
});

/** Put a capability's package where an install would have: its manifest, its version, its source. */
async function install(fixture: Fixture, manifest: CapabilityManifest): Promise<void> {
  const pkg = join(fixture.project, "node_modules", ...manifest.package.split("/"));
  await mkdir(join(pkg, "src"), { recursive: true });
  await writeFile(join(pkg, "pithy.manifest.json"), JSON.stringify(manifest));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: manifest.package, version: "1.2.3" }));
  await writeFile(join(pkg, "src", "index.ts"), "export const capability = 1;\n");
  await writeFile(join(pkg, "src", "routes.ts"), "export const routes = [];\n");
}

/** A scaffolded project at `<parent>/<side>/project`, a sibling `outside/`, and `shape` applied to the pair. */
async function fixtureFor(side: "dry" | "real", shape: Shape): Promise<Fixture> {
  const root = join(parent, side);
  const fixture = { root, project: join(root, "project"), outside: join(root, "outside") };
  await mkdir(fixture.outside, { recursive: true });
  await scaffoldProject({ targetDir: fixture.project, appName: "acme", worker: DEFAULT_WORKER });
  await linkKitPackages(fixture.project, ["core"]);
  await install(fixture, SECRETS);
  await install(fixture, MULTIPLAYER);
  await stageable(fixture);
  await shape(fixture);
  return fixture;
}

/** The staging stanza a deploy refuses without: an origin, and the custom domain that serves it. */
async function stageable(fixture: Fixture): Promise<void> {
  const path = api(fixture, "wrangler.jsonc");
  let text = await readFile(path, "utf8");
  const edit = (from: string, to: string) => {
    const at = text.indexOf(from, text.indexOf('"staging"'));
    text = `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
  };
  edit('"WORKER": "api"', '"WORKER": "api",\n        "BASE_URL": "https://staging.acme.example"');
  edit(
    '"version_metadata"',
    '"workers_dev": false,\n      "routes": [{ "pattern": "staging.acme.example", "custom_domain": true }],\n      "version_metadata"',
  );
  await writeFile(path, text);
}

/** How one side ended: its exit code, its error code when it failed, and the plan when it was a dry run. */
interface Outcome {
  exit: number;
  code: string | undefined;
  /** The error's message, with the fixture's own directory put as `<root>` so the two sides compare. */
  message: string | undefined;
  plan: Plan | undefined;
}

/** `text` with the fixture's directory as `<root>`. */
const rooted = (fixture: Fixture, text: string | undefined) => text?.split(fixture.root).join("<root>");

/** The outcome of a thrown error, or of a result. */
function settled(fixture: Fixture, result: unknown, plan?: (value: never) => Plan | undefined): Outcome {
  if (result instanceof PithyError) {
    const { payload } = result;
    return {
      exit: exitCodeOf(payload),
      code: payload.code,
      message: rooted(fixture, payload.message),
      plan: undefined,
    };
  }
  if (result instanceof Error) throw result;
  return { exit: 0, code: undefined, message: undefined, plan: plan?.(result as never) };
}

/** The half of an outcome both sides must agree on. */
const ending = ({ exit, code, message }: Outcome) => ({ exit, code, message });

/** Run a command as citty would, under `--json`, in `fixture`, and read how it ended off its streams and its exit. */
async function cli(fixture: Fixture, path: string, rawArgs: string[]): Promise<Outcome> {
  vi.spyOn(process, "cwd").mockReturnValue(fixture.project);
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => out.push(String(chunk)) > 0) as never);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => err.push(String(chunk)) > 0) as never);
  let exited: number | undefined;
  let raw: string | undefined;
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exited = code ?? 0;
    throw new Error("exited");
  }) as never);
  process.exitCode = undefined;
  try {
    // Past the error reporting, only what it does not handle: a raw error, which citty prints as a stack and exits 1.
    await runCommand(await commandAt(path), { rawArgs: [...rawArgs, "--json"] }).catch((error: unknown) => {
      if (exited === undefined) raw = error instanceof Error ? error.message : String(error);
    });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
  const code = exited ?? (typeof process.exitCode === "number" ? process.exitCode : 0);
  process.exitCode = undefined;
  if (raw !== undefined) return { exit: 1, code: "a raw error", message: rooted(fixture, raw), plan: undefined };
  const failure = err.join("").trim();
  const error =
    failure === ""
      ? undefined
      : (JSON.parse(failure.split("\n").at(-1) as string) as { error?: { code?: string; message?: string } });
  const document = out.join("").trim();
  const payload = document === "" ? undefined : (JSON.parse(document) as { plan?: unknown });
  return {
    exit: code,
    code: error?.error?.code,
    message: rooted(fixture, error?.error?.message),
    plan: payload?.plan === undefined ? undefined : Plan.parse(payload.plan),
  };
}

/**
 * The plan's file edits, as the real paths they land on in the real fixture — the real run's own changes, read the
 * same way, are what they must equal.
 */
async function plannedLandings(real: Fixture, files: PlanFile[]): Promise<string[]> {
  return (await Promise.all(files.map((file) => landing(real, file.path)))).sort();
}

/** What the install writes at the root, which the stub that stands in for it has to write too: `pkg` at `^1.2.3`. */
async function declare(fixture: Fixture, pkg: string): Promise<void> {
  const path = join(fixture.project, "package.json");
  const doc = JSON.parse(await readFile(path, "utf8")) as { dependencies?: Record<string, string> };
  const dependencies = { ...(doc.dependencies ?? {}), [pkg]: "^1.2.3" };
  doc.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Every planned file that lands outside the real project carries a note saying so, naming it first. */
async function expectNotedWhereOutside(real: Fixture, plan: Plan): Promise<void> {
  for (const file of plan.files) {
    const lands = relative(real.project, await landing(real, file.path));
    if (!lands.startsWith("..")) continue;
    expect(
      plan.notes.some((note) => note.startsWith(`${file.path} `)),
      file.path,
    ).toBe(true);
  }
}

/** The real run's changes, with everything under one of `collapsed` read as that directory: a plan names a copy once. */
function collapse(changed: string[], collapsed: string[]): string[] {
  const out = new Set<string>();
  for (const path of changed) out.add(collapsed.find((dir) => path.startsWith(`${dir}${sep}`)) ?? path);
  return [...out].sort();
}

/**
 * `pithy add <capability>` dry in one fixture and for real in the other — the module the command calls, with the
 * steps that reach past the project (the install, the migrate, the bootstrap, the eject's own install) replaced the
 * same way on both sides, and the install's write to the root manifest made by its stand-in.
 */
async function addParity(name: string, shape: Shape, capability: string, eject: boolean): Promise<void> {
  const dry = await fixtureFor("dry", shape);
  const real = await fixtureFor("real", shape);
  const options = (fixture: Fixture) => ({
    account: null,
    projectDir: fixture.project,
    workerDir: api(fixture),
    project: "acme",
    capability,
    eject,
  });
  const before = await hashFixture(dry);
  const planned = settled(
    dry,
    await planAdd(options(dry)).catch((error: unknown) => error),
    (result: { plan: Plan }) => result.plan,
  );
  expect(changedBetween(before, await hashFixture(dry))).toEqual([]);

  const realBefore = await hashFixture(real);
  const ran = settled(
    real,
    await runAdd({
      ...options(real),
      install: async ({ pkg }) => {
        await declare(real, pkg);
        return { packageManager: "npm" };
      },
      migrate: async () => [],
      bootstrap: async () => [],
      audit: async () => {},
      ejectStep: (step) => ejectCapability({ ...step, promoteDeps: async () => {} }),
    }).catch((error: unknown) => error),
  );

  expect(ending(planned)).toEqual(ending(ran));
  if (name === PLAIN) expect(planned.plan).toBeDefined();
  if (planned.plan === undefined) return;
  await expectNotedWhereOutside(real, planned.plan);
  const changed = changedBetween(realBefore, await hashFixture(real));
  const ejected = await landing(real, `apps/${DEFAULT_WORKER}/capabilities/${capability}`);
  expect(await plannedLandings(real, planned.plan.files)).toEqual(collapse(changed, [ejected]));
}

describe.each(Object.entries(SHAPES))("with %s", (name, shape) => {
  const skip = name === UNREADABLE && asRoot;

  test.skipIf(skip)("add secrets --eject: the dry run is the real run", async () => {
    await addParity(name, shape, "secrets", true);
  });

  test.skipIf(skip)("add multiplayer, which writes into the Worker's entry: the dry run is the real run", async () => {
    await addParity(name, shape, "multiplayer", false);
  });

  test.skipIf(skip)("ui add react --no-auth: the dry run is the real run", async () => {
    const dry = await fixtureFor("dry", shape);
    const real = await fixtureFor("real", shape);
    const flags = ["react", "--no-auth", "--no-payments", "--no-organization"];
    const before = await hashFixture(dry);
    const planned = await cli(dry, "ui add", [...flags, "--dry-run"]);
    expect(changedBetween(before, await hashFixture(dry))).toEqual([]);

    const realBefore = await hashFixture(real);
    const ran = await cli(real, "ui add", flags);

    expect(ending(planned)).toEqual(ending(ran));
    if (name === PLAIN) expect(planned.plan).toBeDefined();
    if (planned.plan === undefined) return;
    await expectNotedWhereOutside(real, planned.plan);
    const changed = changedBetween(realBefore, await hashFixture(real));
    expect(await plannedLandings(real, planned.plan.files)).toEqual(changed);
  });

  test.skipIf(skip)("deploy: the dry run bundles what the real deploy bundles", async () => {
    const dry = await fixtureFor("dry", shape);
    const real = await fixtureFor("real", shape);
    const args = ["--env", "staging", "--apps"];
    const before = await hashFixture(dry);
    const planned = await cli(dry, "deploy", [...args, "--dry-run"]);
    expect(changedBetween(before, await hashFixture(dry))).toEqual([]);
    const dryEntries = [...bundled.entries];
    bundled.entries = [];

    const ran = await cli(real, "deploy", args);

    expect(ending(planned)).toEqual(ending(ran));
    expect(dryEntries).toEqual(bundled.entries);
    expect(account.writes.filter((call) => !call.startsWith("workers"))).toEqual([]);
  });

  test.skipIf(skip)("provision --dry-run: offline, the dry run is the real run", async () => {
    const dry = await fixtureFor("dry", shape);
    const real = await fixtureFor("real", shape);
    const args = ["--env", "staging", "--yes"];
    const before = await hashFixture(dry);
    const planned = await cli(dry, "provision", [...args, "--dry-run"]);
    expect(changedBetween(before, await hashFixture(dry))).toEqual([]);

    const realBefore = await hashFixture(real);
    const ran = await cli(real, "provision", args);

    expect(ending(planned)).toEqual(ending(ran));
    if (name === PLAIN) expect(planned.plan).toBeDefined();
    if (planned.plan === undefined) return;
    await expectNotedWhereOutside(real, planned.plan);
    const changed = changedBetween(realBefore, await hashFixture(real));
    expect(await plannedLandings(real, planned.plan.files)).toEqual(changed);
  });
});

test("the fixtures hold the shapes they are named for", async () => {
  const fixture = await fixtureFor("dry", SHAPES["an in-project link that resolves through a link out"] as Shape);
  expect((await lstat(api(fixture, "src"))).isSymbolicLink()).toBe(true);
  expect(await realpath(api(fixture, "src"))).toBe(join(fixture.outside, "shared", "src"));
  expect(existsSync(api(fixture, "src", "index.ts"))).toBe(true);
});
