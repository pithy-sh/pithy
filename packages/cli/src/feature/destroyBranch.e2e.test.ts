// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
 * It answers the handful of endpoints a feature teardown touches and records every one, so the assertions
 * can be about *what the CLI asked the account to delete* rather than about what it printed. The Worker
 * script and the D1 database are present; everything else is an empty listing, which is a real account's
 * answer for a feature that never provisioned one.
 */
async function stubCloudflare(present: { script: string; database: { name: string; id: string } }): Promise<Account> {
  const calls: Call[] = [];
  const ok = (result: unknown): string =>
    JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { page: 1, total_pages: 1 } });

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    const method = req.method ?? "GET";
    calls.push({ method, url });
    res.setHeader("content-type", "application/json");

    if (path === `/client/v4/accounts/${ACCOUNT_ID}`) return void res.end(ok({ id: ACCOUNT_ID, name: "stub" }));
    // The account's scripts, listed — `getWorker` finds by name in the listing rather than asking for one.
    if (path.endsWith("/workers/scripts")) {
      return void res.end(ok([{ id: present.script, created_on: "2026-01-01T00:00:00Z" }]));
    }
    if (path.includes("/workers/scripts/") && method === "DELETE") return void res.end(ok(null));
    if (path.endsWith("/d1/database")) {
      return void res.end(ok([{ uuid: present.database.id, name: present.database.name }]));
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

/**
 * The runner's checkout: project `replay`, one Worker `board`, on a **detached HEAD** with no feature
 * branch and no worktree — the state `pull_request: closed` leaves behind.
 */
async function mergedCheckout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-660-"));
  const git = (args: string[]): Promise<unknown> => run("git", ["-c", "gc.auto=0", ...args], { cwd: dir });
  await git(["init", "-q"]);
  await git(["config", "user.email", "ci@example.com"]);
  await git(["config", "user.name", "CI"]);
  await writeFile(
    join(dir, "pithy.config.ts"),
    `export default { name: "replay", cloudflare: { accountId: "${ACCOUNT_ID}" } };\n`,
  );
  const worker = join(dir, "apps", "board");
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, "wrangler.jsonc"), `{ "name": "replay-board" }\n`);
  await writeFile(
    join(worker, "pithy.config.ts"),
    `export default { capabilities: [{ name: "app", requiredBindings: [{ name: "DB", type: "d1" }] }] };\n`,
  );
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "merged"]);
  // What `actions/checkout` does with `refs/pull/<n>/head`: no branch, so `rev-parse --abbrev-ref HEAD`
  // answers the literal `HEAD` and the inferred path has nothing to work from.
  await git(["checkout", "-q", "--detach"]);
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
  function ciEnv(dir: string, account: Account): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CLOUDFLARE_BASE_URL: account.url,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "stub-token",
      PITHY_CONFIG_DIR: join(dir, ".pithy-config"),
      NO_COLOR: "1",
    };
  }

  test("**the feature is named, and its remote half goes**", async () => {
    const dir = await mergedCheckout();
    dirs.push(dir);
    const account = await stubCloudflare({
      script: "replay-f12-x--board",
      database: { name: "replay-f12-x--db-d1", id: "db-uuid-1" },
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
      // The local half, truthfully: there was no worktree and no port block, and it says so rather than
      // claiming to have freed one.
      portsFreed: false,
      worktreePruned: false,
      branchDeleted: false,
    });
    // Asked of the account, not merely printed: the deletes went out, addressed to the pinned account.
    expect(account.calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
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
      script: "ripple-f12-x--board",
      database: { name: "ripple-f12-x--db-d1", id: "db-uuid-2" },
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
      script: "replay-f12-x--board",
      database: { name: "replay-f12-x--db-d1", id: "db-uuid-1" },
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
      script: "replay-f12-x--board",
      database: { name: "replay-f12-x--db-d1", id: "db-uuid-1" },
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
