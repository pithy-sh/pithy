// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { removeTempDir } from "../test-utils/tempRepo";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin.ts");

/**
 * **A merged pull request tearing its own feature environment down — #660, end to end.**
 *
 * Everything about this run is the runner's situation rather than a developer's, because that is the
 * situation the command could not be reached from. The checkout is on a **detached HEAD**, which is what
 * `refs/pull/<n>/head` gives you; there is no branch of the feature's name, because the merge deleted it;
 * there is no worktree and no port-registry entry, because both are machine-local and the machine is a
 * fresh container. The only thing the pipeline has is the string
 * `github.event.pull_request.head.ref` — which survives the branch, being a snapshot in the event payload.
 *
 * The real binary, driven the way CI drives it. Cloudflare is stubbed **at its own seam** — the REST API,
 * via `CLOUDFLARE_BASE_URL` — rather than by injecting fakes into the CLI, so everything between the flag
 * and the HTTP request is the shipping code. The account id and token are this server's, and it is bound
 * to loopback: no real account is reachable from this suite.
 *
 * The project is `replay` and its one Worker is `board`, deliberately unequal, so a resource name composed
 * from the wrong one of the two could not pass unnoticed.
 */

/** One Cloudflare request the stub answered, as the assertions read it. */
interface Call {
  method: string;
  /** The request target, query string and all — `name=` is where a recomputed resource name shows up. */
  url: string;
}

/** A Cloudflare REST stub on loopback: what the account holds, and what was asked of it. */
interface Account {
  url: string;
  calls: Call[];
  close: () => Promise<void>;
}

/** The account id every request must carry — the one the fixture's `pithy.config.ts` pins. */
const ACCOUNT_ID = "acc0unt0000000000000000000000000";

/**
 * A Cloudflare API this test owns.
 *
 * It answers the endpoints a feature teardown touches and records every one, so the assertions can be
 * about *what the CLI asked the account to delete* rather than about what it printed. The D1 listing
 * filters on `?name=` exactly as the real API does, which is what makes "this name was never asked for"
 * an observation rather than an assumption.
 */
async function stubCloudflare(present: {
  scripts: string[];
  databases: { name: string; id: string }[];
}): Promise<Account> {
  const calls: Call[] = [];
  const ok = (result: unknown): string =>
    JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { page: 1, total_pages: 1 } });

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    const query = new URLSearchParams(url.split("?")[1] ?? "");
    const method = req.method ?? "GET";
    calls.push({ method, url });
    res.setHeader("content-type", "application/json");

    if (path === `/client/v4/accounts/${ACCOUNT_ID}`) return void res.end(ok({ id: ACCOUNT_ID, name: "stub" }));
    // The account's scripts, listed — `getWorker` finds by name in the listing rather than asking for one.
    if (path.endsWith("/workers/scripts")) {
      return void res.end(ok(present.scripts.map((id) => ({ id, created_on: "2026-01-01T00:00:00Z" }))));
    }
    if (path.includes("/workers/scripts/") && method === "DELETE") return void res.end(ok(null));
    if (path.endsWith("/d1/database")) {
      const name = query.get("name");
      const rows = present.databases
        .filter((database) => name === null || database.name === name)
        .map((database) => ({ uuid: database.id, name: database.name }));
      return void res.end(ok(rows));
    }
    if (path.includes("/d1/database/")) return void res.end(ok(null));
    return void res.end(ok([]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/client/v4`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every delete the account was actually asked for, in order. */
function deletes(account: Account): string[] {
  return account.calls.filter((call) => call.method === "DELETE").map((call) => call.url);
}

/**
 * One run of the real binary, as an outcome rather than as an exception.
 *
 * A refusal is an exit code and a line on stderr — the shape CI reads — so a failing run is described the
 * same way a succeeding one is, and an assertion about the code cannot be skipped by a rejected promise.
 */
async function pithy(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** A Worker config declaring exactly these bindings — what decides which names teardown reconciles. */
function bindingsConfig(bindings: { name: string; type: string }[]): string {
  const list = bindings.map((binding) => `{ name: "${binding.name}", type: "${binding.type}" }`).join(", ");
  return `export default { capabilities: [{ name: "app", requiredBindings: [${list}] }] };\n`;
}

/** git in one directory, with maintenance off so a temp repo can be deleted without racing a gc. */
function gitIn(dir: string): (args: string[]) => Promise<unknown> {
  return (args) => run("git", ["-c", "gc.auto=0", ...args], { cwd: dir });
}

/** A main checkout on `main`: project `replay`, one Worker `board`, with the bindings `main` declares. */
async function mainCheckout(mainBindings: { name: string; type: string }[] = [{ name: "DB", type: "d1" }]) {
  const dir = await mkdtemp(join(tmpdir(), "pithy-660-"));
  const git = gitIn(dir);
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "ci@example.com"]);
  await git(["config", "user.name", "CI"]);
  await writeFile(
    join(dir, "pithy.config.ts"),
    `export default { name: "replay", cloudflare: { accountId: "${ACCOUNT_ID}" } };\n`,
  );
  const worker = join(dir, "apps", "board");
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, "wrangler.jsonc"), `{ "name": "replay-board" }\n`);
  await writeFile(join(worker, "pithy.config.ts"), bindingsConfig(mainBindings));
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "main"]);
  return dir;
}

/** Cut `feature/<issue>-<slug>` with its own Worker bindings, and register a worktree for it. */
async function addFeature(
  root: string,
  issue: string,
  slug: string,
  branchBindings: { name: string; type: string }[],
): Promise<string> {
  const git = gitIn(root);
  const branch = `feature/${issue}-${slug}`;
  await git(["checkout", "-q", "-b", branch]);
  await writeFile(join(root, "apps", "board", "pithy.config.ts"), bindingsConfig(branchBindings));
  await writeFile(join(root, `.marker-${issue}`), `${branch}\n`);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", branch]);
  await git(["checkout", "-q", "main"]);
  const worktree = join(root, ".worktrees", `${issue}-${slug}`);
  await git(["worktree", "add", "-q", worktree, branch]);
  return worktree;
}

/** The record a `provision --feature` leaves in the feature's worktree. */
async function writeManifest(
  worktree: string,
  manifest: { issue: string; slug: string; resources: unknown[] },
): Promise<void> {
  await writeFile(
    join(worktree, ".pithy-feature.json"),
    JSON.stringify({
      version: 1,
      project: "replay",
      issue: manifest.issue,
      slug: manifest.slug,
      env: "feature",
      resources: manifest.resources,
      scripts: [],
    }),
  );
}

/** The runner's checkout: `mainCheckout` put on a **detached HEAD**, as `refs/pull/<n>/head` leaves it. */
async function mergedCheckout(): Promise<string> {
  const dir = await mainCheckout();
  // What `actions/checkout` does with `refs/pull/<n>/head`: no branch, so `rev-parse --abbrev-ref HEAD`
  // answers the literal `HEAD` and the inferred path has nothing to work from.
  await gitIn(dir)(["checkout", "-q", "--detach"]);
  return dir;
}

describe("pithy feature destroy --branch, from a detached HEAD — #660", () => {
  const dirs: string[] = [];
  const servers: Account[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  /** The environment a runner has: credentials, a config directory of its own, and no color. */
  function ciEnv(dir: string, account?: Account): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      PITHY_CONFIG_DIR: join(dir, ".pithy-config"),
      NO_COLOR: "1",
    };
    delete base.CLOUDFLARE_API_TOKEN;
    delete base.CLOUDFLARE_ACCOUNT_ID;
    if (!account) return base;
    return {
      ...base,
      CLOUDFLARE_BASE_URL: account.url,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "stub-token",
    };
  }

  test("**the feature is named, and its remote half goes**", async () => {
    const dir = await mergedCheckout();
    dirs.push(dir);
    const account = await stubCloudflare({
      scripts: ["replay-f12-x--board"],
      databases: [{ name: "replay-f12-x--db-d1", id: "db-uuid-1" }],
    });
    servers.push(account);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--json"], {
      cwd: dir,
      env: ciEnv(dir, account),
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout.trim()) as Record<string, unknown>;

    // **The remote half ran, against the names this feature composes.** The Worker script and the D1
    // database, deleted by the ids the account gave back — which is the whole thing that could not happen
    // before, and the reason a merged pull request left its environment standing.
    expect(report).toEqual({
      command: "feature.destroy",
      deletedResources: [
        { kind: "worker", name: "replay-f12-x--board", id: "replay-f12-x--board" },
        { kind: "d1", name: "replay-f12-x--db-d1", id: "db-uuid-1" },
      ],
      remote: true,
      // Canonical, and published because `--branch` is an input the parse may correct.
      branch: "feature/12-x",
      // The local half, truthfully: there was no worktree and no port block, and it says so rather than
      // claiming to have freed one.
      portsFreed: false,
      worktreePruned: false,
      branchDeleted: false,
      // And the feature's own manifest was not on this machine, which the report states rather than
      // passing over — see the manifest suite below.
      manifestReachable: false,
      manifestPath: join(dir, ".worktrees", "12-x", ".pithy-feature.json"),
    });
    // Asked of the account, not merely printed: the deletes went out, addressed to the pinned account.
    expect(deletes(account)).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/replay-f12-x--board?force=true`,
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database/db-uuid-1`,
    ]);
  });

  /**
   * **The flag names a feature of *this* project, and cannot reach another's.**
   *
   * Only the issue and the slug come from `--branch`. The project is the first segment of every resource
   * name teardown recomputes, and it comes from this checkout's own `pithy.config.ts` — so the account is
   * asked about `ripple-f12-x--db-d1` when the config says `ripple`, whatever the branch is called.
   */
  test("the project comes from the checkout's config, not from the flag", async () => {
    const dir = await mergedCheckout();
    dirs.push(dir);
    await writeFile(
      join(dir, "pithy.config.ts"),
      `export default { name: "ripple", cloudflare: { accountId: "${ACCOUNT_ID}" } };\n`,
    );
    const account = await stubCloudflare({
      scripts: ["ripple-f12-x--board"],
      databases: [{ name: "ripple-f12-x--db-d1", id: "db-uuid-2" }],
    });
    servers.push(account);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--json"], {
      cwd: dir,
      env: ciEnv(dir, account),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      deletedResources: [
        { kind: "worker", name: "ripple-f12-x--board" },
        { kind: "d1", name: "ripple-f12-x--db-d1" },
      ],
    });
    // The lookup itself carried the checkout's project, which is what the deletes were chosen from.
    expect(account.calls.map((call) => call.url)).toContain(
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database?name=ripple-f12-x--db-d1`,
    );
  });

  test("a malformed name is refused, and nothing is asked of the account", async () => {
    const dir = await mergedCheckout();
    dirs.push(dir);
    const account = await stubCloudflare({
      scripts: ["replay-f12-x--board"],
      databases: [{ name: "replay-f12-x--db-d1", id: "db-uuid-1" }],
    });
    servers.push(account);

    const failed = await pithy(["feature", "destroy", "--branch", "not-a-feature", "--json"], {
      cwd: dir,
      env: ciEnv(dir, account),
    });

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr.trim())).toMatchObject({
      error: { code: "validation/invalid_input", message: "Not a feature branch (not-a-feature)." },
    });
    // Nothing was deleted, because nothing was asked.
    expect(account.calls).toEqual([]);
  });

  test("with no --branch the checkout's own branch is still what decides, and there is none", async () => {
    const dir = await mergedCheckout();
    dirs.push(dir);
    const account = await stubCloudflare({
      scripts: ["replay-f12-x--board"],
      databases: [{ name: "replay-f12-x--db-d1", id: "db-uuid-1" }],
    });
    servers.push(account);

    const failed = await pithy(["feature", "destroy", "--json"], {
      cwd: dir,
      env: ciEnv(dir, account),
    });

    // Byte for byte the refusal this command has always given a checkout it cannot infer a feature from.
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr.trim())).toMatchObject({
      error: {
        code: "validation/invalid_input",
        message: "Not on a feature branch (HEAD).",
        action: "Run this from inside a feature worktree, or create one with pithy feature create.",
      },
    });
    expect(account.calls).toEqual([]);
  });
});

/**
 * **What `--branch` corrects, and what it used to leave behind.**
 *
 * The first version of this flag corrected the *name* and nothing else: the manifest, the capability set
 * and the Worker list still came from the checkout the command ran in. So the exact-id half of teardown
 * read the wrong file (usually none), and the reconcile ran against `main`'s bindings rather than the
 * feature's. A resource the feature provisioned and `main` no longer names survived a run that printed
 * `Done.` and exited 0 — which is the outcome `commands/feature.ts` spends a paragraph forbidding.
 *
 * The record lives in the feature's own worktree. When that worktree is on this machine, teardown reads it
 * there. When it is not — the CI case, and the whole reason the flag exists — teardown says so, because
 * the alternative is silence over a record it could not consult.
 */
describe("a named feature's own record — #660", () => {
  const dirs: string[] = [];
  const servers: Account[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  function ciEnv(dir: string, account?: Account): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      PITHY_CONFIG_DIR: join(dir, ".pithy-config"),
      NO_COLOR: "1",
    };
    delete base.CLOUDFLARE_API_TOKEN;
    delete base.CLOUDFLARE_ACCOUNT_ID;
    if (!account) return base;
    return {
      ...base,
      CLOUDFLARE_BASE_URL: account.url,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "stub-token",
    };
  }

  /** A feature with a resource only its manifest names, and a binding only its branch declares. */
  async function featureWithItsOwnRecord(root: string): Promise<string> {
    const worktree = await addFeature(root, "12", "x", [
      { name: "DB", type: "d1" },
      { name: "EXTRA", type: "d1" },
    ]);
    await writeManifest(worktree, {
      issue: "12",
      slug: "x",
      resources: [
        { kind: "d1", binding: "DB", name: "replay-f12-x--db-d1", id: "db-uuid" },
        // Provisioned for a binding the branch has since dropped: only the manifest names it, so only a
        // teardown that reads the manifest can reach it.
        { kind: "d1", binding: "GONE", name: "replay-f12-x--gone-d1", id: "gone-uuid" },
      ],
    });
    return worktree;
  }

  /** The account that feature stood up: the script, and all three databases. */
  function itsAccount(): Promise<Account> {
    return stubCloudflare({
      scripts: ["replay-f12-x--board"],
      databases: [
        { name: "replay-f12-x--db-d1", id: "db-uuid" },
        { name: "replay-f12-x--extra-d1", id: "extra-uuid" },
        { name: "replay-f12-x--gone-d1", id: "gone-uuid" },
      ],
    });
  }

  test("**--branch deletes everything the inferred path would, from the feature's own worktree**", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const worktree = await featureWithItsOwnRecord(root);
    const account = await itsAccount();
    servers.push(account);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--json"], {
      cwd: root,
      env: ciEnv(root, account),
    });

    expect(code).toBe(0);
    const report = JSON.parse(stdout.trim()) as { deletedResources: { id: string }[]; manifestReachable: boolean };
    // `gone-uuid` is the manifest's alone; `extra-uuid` is the branch config's alone. Both were invisible
    // to a teardown reading `main`'s copy of each, and both go.
    expect(report.deletedResources.map((resource) => resource.id).sort()).toEqual([
      "db-uuid",
      "extra-uuid",
      "gone-uuid",
      "replay-f12-x--board",
    ]);
    expect(report.manifestReachable).toBe(true);
    // The record it read is removed with the feature, on the clean pass, from where it actually lived.
    expect(existsSync(join(worktree, ".pithy-feature.json"))).toBe(false);
  });

  test("the inferred path deletes the same set — the two agree, which is the whole point", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const worktree = await featureWithItsOwnRecord(root);
    const account = await itsAccount();
    servers.push(account);

    const { code, stdout } = await pithy(["feature", "destroy", "--json"], {
      cwd: worktree,
      env: ciEnv(root, account),
    });

    expect(code).toBe(0);
    const report = JSON.parse(stdout.trim()) as { deletedResources: { id: string }[] };
    expect(report.deletedResources.map((resource) => resource.id).sort()).toEqual([
      "db-uuid",
      "extra-uuid",
      "gone-uuid",
      "replay-f12-x--board",
    ]);
  });

  test("**with no worktree on this machine, the run says which record it could not consult**", async () => {
    const root = await mergedCheckout();
    dirs.push(root);
    const account = await stubCloudflare({
      scripts: ["replay-f12-x--board"],
      databases: [{ name: "replay-f12-x--db-d1", id: "db-uuid" }],
    });
    servers.push(account);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x"], {
      cwd: root,
      env: ciEnv(root, account),
    });

    expect(code).toBe(0);
    // Plainly, in the human output: the path, and what its absence means for what was deleted.
    expect(stdout).toContain(`No feature manifest at ${join(root, ".worktrees", "12-x", ".pithy-feature.json")}.`);
    expect(stdout).toContain("Resources only it recorded were not deleted.");
  });

  test("from inside another feature's worktree, the named feature's own record is the one read", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const worktree = await featureWithItsOwnRecord(root);
    const other = await addFeature(root, "99", "y", [{ name: "DB", type: "d1" }]);
    await writeManifest(other, {
      issue: "99",
      slug: "y",
      resources: [{ kind: "d1", binding: "DB", name: "replay-f99-y--db-d1", id: "y-uuid" }],
    });
    const account = await itsAccount();
    servers.push(account);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--json"], {
      cwd: other,
      env: ciEnv(root, account),
    });

    // No abort on the *other* feature's manifest: the run never reads it. Feature 12's goes in full.
    expect(code).toBe(0);
    const report = JSON.parse(stdout.trim()) as { deletedResources: { id: string }[] };
    expect(report.deletedResources.map((resource) => resource.id)).toContain("gone-uuid");
    expect(existsSync(join(worktree, ".pithy-feature.json"))).toBe(false);
    // And feature 99 is untouched: its manifest, its worktree, and its resources.
    expect(existsSync(join(other, ".pithy-feature.json"))).toBe(true);
    expect(existsSync(join(other, ".git"))).toBe(true);
    expect(deletes(account)).not.toContain(`/client/v4/accounts/${ACCOUNT_ID}/d1/database/y-uuid`);
  });

  /**
   * A manifest that really does belong to somebody else — a stale file in the feature's own worktree.
   * The refusal has to name whose it is, and must never advise deleting it: that file is the only record
   * of what that feature provisioned, and a reader who follows the advice orphans all of it.
   */
  test("a manifest belonging to another feature is refused by name, and never advised away", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const worktree = await addFeature(root, "12", "x", [{ name: "DB", type: "d1" }]);
    await writeManifest(worktree, {
      issue: "99",
      slug: "y",
      resources: [{ kind: "d1", binding: "DB", name: "replay-f99-y--db-d1", id: "y-uuid" }],
    });
    const account = await stubCloudflare({ scripts: [], databases: [] });
    servers.push(account);

    const failed = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--json"], {
      cwd: root,
      env: ciEnv(root, account),
    });

    expect(failed.code).toBe(1);
    const { error } = JSON.parse(failed.stderr.trim()) as { error: { message: string; action: string } };
    expect(error.message).toContain("replay-f99-y");
    expect(error.action).not.toMatch(/delete/i);
    // Nothing was deleted, and the record of the feature it belongs to is still there.
    expect(deletes(account)).toEqual([]);
    expect(existsSync(join(worktree, ".pithy-feature.json"))).toBe(true);
  });

  /**
   * **A teardown that deleted nothing before it failed does not claim a remainder.**
   *
   * "Teardown stopped there. The rest is still in the account" is true after a partial delete and false
   * before the first one — there is no *rest* when nothing went.
   */
  test("a failure before the first delete does not say the rest is still in the account", async () => {
    const root = await mainCheckout([{ name: "DB", type: "d1" }]);
    dirs.push(root);
    const calls: Call[] = [];
    const ok = (result: unknown): string =>
      JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { page: 1, total_pages: 1 } });
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const path = url.split("?")[0] ?? "";
      calls.push({ method: req.method ?? "GET", url });
      res.setHeader("content-type", "application/json");
      if (path === `/client/v4/accounts/${ACCOUNT_ID}`) return void res.end(ok({ id: ACCOUNT_ID, name: "stub" }));
      if (path.endsWith("/workers/scripts")) return void res.end(ok([]));
      // The very first lookup fails, so nothing is ever deleted.
      if (path.endsWith("/d1/database")) {
        res.statusCode = 500;
        return void res.end(
          JSON.stringify({ success: false, errors: [{ code: 1000, message: "boom" }], result: null }),
        );
      }
      return void res.end(ok([]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const account: Account = {
      url: `http://127.0.0.1:${port}/client/v4`,
      calls,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
    servers.push(account);

    const failed = await pithy(["feature", "destroy", "--branch", "feature/12-x"], {
      cwd: root,
      env: ciEnv(root, account),
    });

    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain("The rest is still in the account");
  });
});

/**
 * **The local half says what it did, including the part it never mentioned.**
 *
 * `branchDeleted` has been in the `--json` payload since the command existed and has never had a sentence
 * in the human output — so the "nothing local" line, which reads `portsFreed` and `worktreePruned`, was
 * printed over a run that had just deleted a branch. A sentence asserting nothing happened, on a run that
 * mutated the repository.
 */
describe("what the local half reports — #660", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  function localEnv(dir: string): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      PITHY_CONFIG_DIR: join(dir, ".pithy-config"),
      NO_COLOR: "1",
    };
    delete base.CLOUDFLARE_API_TOKEN;
    delete base.CLOUDFLARE_ACCOUNT_ID;
    return base;
  }

  test("**a deleted branch is named, and is not 'nothing local'**", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    // A merged feature branch with no worktree and no port block — what a second `destroy` meets.
    await gitIn(root)(["branch", "feature/12-x"]);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--local-only"], {
      cwd: root,
      env: localEnv(root),
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Branch feature/12-x deleted.");
    expect(stdout).not.toContain("Nothing local to tear down");
    const after = await run("git", ["branch", "--list", "feature/12-x"], { cwd: root });
    expect(after.stdout.trim()).toBe("");
  });

  test("with nothing local at all, the sentence still stands", async () => {
    const root = await mainCheckout();
    dirs.push(root);

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--local-only"], {
      cwd: root,
      env: localEnv(root),
    });

    expect(code).toBe(0);
    expect(stdout).toContain("No port block and no worktree here. Nothing local to tear down.");
    expect(stdout).not.toContain("Branch feature/12-x deleted.");
  });

  test("the inferred path is unchanged when the worktree is registered", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const worktree = await addFeature(root, "12", "x", [{ name: "DB", type: "d1" }]);
    await writeFile(join(worktree, ".dev.config.json"), JSON.stringify({ version: 1, branch: "feature/12-x" }));

    const { code, stdout } = await pithy(["feature", "destroy", "--local-only"], {
      cwd: worktree,
      env: localEnv(root),
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Worktree pruned.");
    expect(stdout).not.toContain("Nothing local to tear down");
    expect(existsSync(join(worktree, ".dev.config.json"))).toBe(false);
  });

  /** `--branch` from another feature's worktree still frees the named feature's block, and only its. */
  test("the named feature's local state goes, and the run's own worktree keeps its", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const twelve = await addFeature(root, "12", "x", [{ name: "DB", type: "d1" }]);
    const other = await addFeature(root, "99", "y", [{ name: "DB", type: "d1" }]);
    await writeFile(join(twelve, ".dev.config.json"), JSON.stringify({ version: 1, branch: "feature/12-x" }));
    await writeFile(join(other, ".dev.config.json"), JSON.stringify({ version: 1, branch: "feature/99-y" }));
    const configDir = join(root, ".pithy-config");
    await mkdir(configDir, { recursive: true });
    const realRoot = (await run("realpath", [root])).stdout.trim();
    await writeFile(
      join(configDir, "dev-ports.json"),
      JSON.stringify({
        [realRoot]: {
          "feature/12-x": { block: 0, base: 9000, size: 10 },
          "feature/99-y": { block: 1, base: 9010, size: 10 },
        },
      }),
    );

    const { code, stdout } = await pithy(["feature", "destroy", "--branch", "feature/12-x", "--local-only", "--json"], {
      cwd: other,
      env: localEnv(root),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ portsFreed: true, worktreePruned: true });
    expect(existsSync(join(twelve, ".dev.config.json"))).toBe(false);
    expect(existsSync(join(other, ".dev.config.json"))).toBe(true);
    const registry = JSON.parse(await readFile(join(configDir, "dev-ports.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(registry[realRoot] ?? {})).toEqual(["feature/99-y"]);
  });
});

/**
 * **`feature/012-x` and `feature/12-x` are one feature, so they are one set of strings.**
 *
 * `canonicalIssue` has settled this for resource *names* since #643 — `f012` and `f12` would otherwise
 * collide on the rate-limit namespaces they share. The branch did not go through it, so the remote half
 * addressed feature 12 while the local half looked for a `feature/012-x` registry key and a
 * `.worktrees/012-x` directory: one command, two features, and the half that leaks is the quiet one.
 */
describe("a branch's issue is canonical — #660", () => {
  const dirs: string[] = [];
  const servers: Account[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  function localEnv(dir: string): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      PITHY_CONFIG_DIR: join(dir, ".pithy-config"),
      NO_COLOR: "1",
    };
    delete base.CLOUDFLARE_API_TOKEN;
    delete base.CLOUDFLARE_ACCOUNT_ID;
    return base;
  }

  test("**--branch feature/012-x frees feature 12's block, not a second one**", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const configDir = join(root, ".pithy-config");
    await mkdir(configDir, { recursive: true });
    const realRoot = (await run("realpath", [root])).stdout.trim();
    await writeFile(
      join(configDir, "dev-ports.json"),
      JSON.stringify({ [realRoot]: { "feature/12-x": { block: 0, base: 9000, size: 10 } } }),
    );

    const { code, stdout } = await pithy(
      ["feature", "destroy", "--branch", "feature/012-x", "--local-only", "--json"],
      { cwd: root, env: localEnv(root) },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ portsFreed: true });
    const registry = JSON.parse(await readFile(join(configDir, "dev-ports.json"), "utf8")) as Record<string, unknown>;
    expect(registry[realRoot]).toBeUndefined();
  });

  test("the remote half is feature 12's either way, which it already was", async () => {
    const root = await mainCheckout();
    dirs.push(root);
    const account = await stubCloudflare({
      scripts: ["replay-f12-x--board"],
      databases: [{ name: "replay-f12-x--db-d1", id: "db-uuid" }],
    });
    servers.push(account);

    const { code } = await pithy(["feature", "destroy", "--branch", "feature/012-x", "--json"], {
      cwd: root,
      env: {
        ...localEnv(root),
        CLOUDFLARE_BASE_URL: account.url,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: "stub-token",
      },
    });

    expect(code).toBe(0);
    expect(deletes(account)).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/replay-f12-x--board?force=true`,
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database/db-uuid`,
    ]);
  });
});
