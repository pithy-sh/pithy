// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exitCodeOf } from "../terminal/exitClass";
import { NO_PROVISION_ARG } from "./effectiveConfig";
import {
  readOptionalWranglerConfig,
  readWranglerConfig,
  refusesTheRun,
  runWrangler,
  WranglerCredentialsError,
  workerEntryPath,
} from "./wrangler";

/** Use `node` as the binary so these run without wrangler installed. */
const NODE = "node";

/**
 * The read behind every `wrangler.jsonc` caller in the CLI — nineteen of them, and the one the ENOENT
 * gate could not see, because the scan recognizes leaf reads and this is a wrapper (#204).
 *
 * It goes through `readOptionalFile` now, so the errno decision has one home rather than being made again
 * at whichever caller happened to catch. Absent and unreadable are different answers, and both are a
 * `PithyError` naming the file.
 */
describe("readWranglerConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-wrangler-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("parses the file, comments and all", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  // a note\n  "name": "api"\n}\n');
    expect(await readWranglerConfig(dir)).toMatchObject({ name: "api" });
  });

  test("a directory with no wrangler.jsonc is a PithyError naming it, not node's raw ENOENT", async () => {
    const thrown = (await readWranglerConfig(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.message).toContain(join(dir, "wrangler.jsonc"));
    expect(thrown.payload.action ?? "").not.toBe("");
  });

  test("a wrangler.jsonc that is there and will not open is a different refusal from an absent one", async () => {
    // EISDIR for every uid, root included. Absent means ENOENT and nothing else — the decision lives in
    // `readOptionalFile`, and this wrapper is now inside that rule rather than outside it.
    await mkdir(join(dir, "wrangler.jsonc"));

    const thrown = (await readWranglerConfig(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.message).toContain(join(dir, "wrangler.jsonc"));
    expect(thrown.payload.detail).toContain("EISDIR");
    expect((thrown.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });

  test("the optional read answers null for absent — and only for absent", async () => {
    // What `pithy env` needs: a Worker whose wrangler.jsonc vanished between discovery and the read drops
    // out of the inventory, and one that will not open still refuses rather than being reported as empty.
    expect(await readOptionalWranglerConfig(dir)).toBeNull();

    await mkdir(join(dir, "wrangler.jsonc"));
    await expect(readOptionalWranglerConfig(dir)).rejects.toThrow(PithyError);
  });
});

/**
 * **The module `main` names, which is the file a Durable Object's export has to land in (#428).**
 *
 * Every branch here is a decision `pithy add` and `pithy remove` act on, and the `null` one is the
 * refusal `add` raises by name. It had no test of its own: replacing `return null` with a guess at
 * `src/index.ts` left the whole `capabilities` + `project` suite green, so the branch was reachable only
 * in principle. A Worker with no `main` is a real Worker — a Vite frontend joins the dev set through
 * `pithy.worker.jsonc` alone — so the answer has to be the config's, never a guess.
 */
describe("workerEntryPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-entry-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("resolves main against the worker directory", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": "src/index.ts"\n}\n');
    expect(await workerEntryPath(dir)).toBe(join(dir, "src/index.ts"));
  });

  test("a main the adopter has moved is followed, never assumed", async () => {
    // The whole reason this reads the config: a Worker carrying a front end has its entry written by the
    // Vite plugin, and guessing `src/index.ts` would put the export in a file nothing bundles.
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": "worker/entry.ts"\n}\n');
    expect(await workerEntryPath(dir)).toBe(join(dir, "worker/entry.ts"));
  });

  test("no main is null — the Worker cannot say which module it is", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "web"\n}\n');
    expect(await workerEntryPath(dir)).toBeNull();
  });

  test("a main that is not a string is null, not a path built out of a number", async () => {
    // `wrangler.jsonc` is the adopter's file and JSON holds any type. `join(dir, 42)` throws a raw
    // TypeError; the honest answer is that this config names no entry.
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": 42\n}\n');
    expect(await workerEntryPath(dir)).toBeNull();
  });

  test("an empty main is null, not the worker directory itself", async () => {
    // `join(dir, "")` is `dir` — a directory, which `add` would then try to read as source and `remove`
    // would try to rewrite. Empty names no module.
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": ""\n}\n');
    expect(await workerEntryPath(dir)).toBeNull();
  });

  test("no wrangler.jsonc at all refuses, rather than answering null", async () => {
    // The refusal is `readWranglerConfig`'s and stays its: a directory that is not a Worker is a
    // different fact from a Worker that names no entry, and only the second one is a value.
    await expect(workerEntryPath(dir)).rejects.toThrow(PithyError);
  });
});

describe("runWrangler", () => {
  let scripts: string;
  beforeEach(async () => {
    scripts = await mkdtemp(join(tmpdir(), "pithy-wrangler-stand-in-"));
  });
  afterEach(async () => {
    await rm(scripts, { recursive: true, force: true });
  });

  /**
   * A node stand-in for wrangler: `code` written to a script, and the argv that runs it.
   *
   * A script file rather than `node -e`, because every spawn carries {@link NO_PROVISION_ARG} (#589) and
   * node reads a flag after `-e <code>` as its own option and exits 9. After a script path, the arguments
   * are the script's — as they are wrangler's.
   */
  async function standIn(code: string): Promise<string[]> {
    const path = join(scripts, `stand-in-${Math.random().toString(36).slice(2)}.cjs`);
    await writeFile(path, `${code}\n`);
    return [path, NO_PROVISION_ARG];
  }

  test("resolves with captured stdout/stderr on a zero exit", async () => {
    await expect(runWrangler(await standIn("process.exit(0)"), { account: null, bin: NODE })).resolves.toEqual({
      stdout: "",
      stderr: "",
    });
  });

  test("captures stdout so callers can scrape it (deploy reads the version id + url)", async () => {
    const { stdout } = await runWrangler(await standIn("process.stdout.write('Current Version ID: v1')"), {
      account: null,
      bin: NODE,
    });
    expect(stdout).toContain("Version ID: v1");
  });

  test("rejects on a non-zero exit, surfacing the captured output in detail (quiet mode)", async () => {
    const error = (await runWrangler(await standIn("console.error('boom'); process.exit(1)"), {
      account: null,
      bin: NODE,
    }).catch((e: unknown) => e)) as PithyError;
    expect(error).toBeInstanceOf(InternalError);
    expect(error.payload.detail).toContain("boom");
    expect(error.payload.detail).toContain("exit 1");
  });

  /**
   * **wrangler's color stops at the capture (#697).** Its `✘ [ERROR]` is red and its links are OSC 8, and the
   * captured output is what a `--json` payload carries as a failure's `detail` and a deploy row's `error`. The
   * encoder writes every value faithfully, so the noise is taken out here, where it is known to be a terminal's.
   */
  test("the captured output in detail carries no terminal control sequence", async () => {
    const error = (await runWrangler(
      await standIn(
        "process.stderr.write('\\u001b[31m\\u2718 [ERROR]\\u001b[0m boom \\u001b]8;;https://x.dev\\u001b\\\\docs\\u001b]8;;\\u001b\\\\\\n'); process.exit(1)",
      ),
      { account: null, bin: NODE },
    ).catch((e: unknown) => e)) as PithyError;
    expect(error.payload.detail).toBe("exit 1\n\u2718 [ERROR] boom docs");
    expect(error.payload.message).not.toContain("\u001b");
  });

  /**
   * **wrangler's own reason is on screen, not only in its log file** (#645). A failed deploy printed
   * `wrangler deploy failed.` and nothing else; the one line that said why — `Could not resolve
   * "@pithy-sh/ledger/src/ledger"` — was in `~/.wrangler/logs`. The error block is lifted into the message,
   * under the failure line, colors stripped; the banner and the log-path footer are not errors and stay out.
   * The real wrangler, failing a real bundle, is `deployKit.test.ts`; this is the shape, pinned.
   */
  test("a failure carries wrangler's own error block in the message, and nothing around it", async () => {
    const printed = [
      "",
      " \u26c5\ufe0f wrangler 4.125.0",
      "\u2500\u2500\u2500\u2500",
      "",
      "\u001b[31m\u2718 \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mBuild failed with 1 error:\u001b[0m",
      "",
      '  \u001b[31m\u2718 \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mCould not resolve "@pithy-sh/ledger/src/ledger"\u001b[0m',
      "",
      "      src/grants/ledgerSeam.ts:104:60:",
      "",
      "",
      '\ud83e\udeb5  Logs were written to "/home/someone/.wrangler/logs/wrangler.log"',
      "",
    ].join("\n");
    const error = (await runWrangler(
      await standIn(`process.stderr.write(${JSON.stringify(printed)}); process.exit(1)`),
      { account: null, bin: NODE },
    ).catch((e: unknown) => e)) as PithyError;

    const [failure, ...block] = error.payload.message.split("\n");
    expect(failure).toMatch(/ failed\.$/);
    expect(block).toEqual([
      "  \u2718 [ERROR] Build failed with 1 error:",
      "",
      '    \u2718 [ERROR] Could not resolve "@pithy-sh/ledger/src/ledger"',
      "",
      "        src/grants/ledgerSeam.ts:104:60:",
    ]);
    // Everything wrangler said is still in `detail`, for the log.
    expect(error.payload.detail).toContain("Logs were written to");
  });

  /**
   * **Cloudflare refusing the credentials is a precondition, exit 3, not an unclassified 1 (#697).** The call
   * was right; what it depends on is a token Cloudflare will take. Three spellings, each one wrangler 4.125.0
   * itself treats as authentication: API codes 10000 and 9106 (`AUTHENTICATION_ERROR_CODES`), and the refusal
   * it raises before any request when no token is set and nobody can log in. No `fix`: a token is minted in
   * the dashboard, which `pithy doctor` says too.
   */
  test.each([
    ["an API token Cloudflare rejected", "Authentication error [code: 10000]"],
    ["no Authorization header at all", "Missing X-Auth-Key, X-Auth-Email or Authorization headers [code: 9106]"],
    [
      "no token where nobody can log in",
      "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.",
    ],
  ])("%s is a credentials refusal, exit 3", async (_, line) => {
    const printed = `\u001b[31m\u2718 \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m A request to the Cloudflare API failed.\n  ${line}\n`;
    const error = (await runWrangler(
      await standIn(`process.stderr.write(${JSON.stringify(printed)}); process.exit(1)`),
      { account: { accountId: "acct", apiToken: "cfat_handed-over" }, bin: NODE },
    ).catch((e: unknown) => e)) as PithyError;
    expect(error).toBeInstanceOf(WranglerCredentialsError);
    expect(refusesTheRun(error)).toBe(true);
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(exitCodeOf(error.payload)).toBe(3);
    expect(error.payload.message.split("\n")[0]).toMatch(/ failed\.$/);
    expect(error.payload.action).toBe(
      "Cloudflare refused the credentials. Run pithy doctor to see whether the token or the account is wrong.",
    );
  });

  test("wrangler handed no token at all is told to sign in, never that its credentials were refused (#759)", async () => {
    // Measured: `pithy deploy` with nothing configured printed "Cloudflare refused the credentials. Run
    // pithy doctor", about credentials nobody gave. The remedy is the sign-in.
    const printed =
      "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.\n";
    const error = (await runWrangler(
      await standIn(`process.stderr.write(${JSON.stringify(printed)}); process.exit(1)`),
      { account: null, bin: NODE, env: { CLOUDFLARE_API_TOKEN: "" } },
    ).catch((e: unknown) => e)) as PithyError;
    expect(error).toBeInstanceOf(WranglerCredentialsError);
    expect(exitCodeOf(error.payload)).toBe(3);
    expect(error.payload.action).toMatch(/^Cloudflare credentials are missing/);
    expect(error.payload.action).toMatch(/pithy cloudflare connect/);
  });

  test("another failure that mentions a code is not a credentials refusal", async () => {
    const error = (await runWrangler(
      await standIn("console.error('A request failed. Unknown error [code: 10013]'); process.exit(1)"),
      { account: null, bin: NODE },
    ).catch((e: unknown) => e)) as PithyError;
    expect(error).toBeInstanceOf(InternalError);
    expect(refusesTheRun(error)).toBe(false);
    expect(exitCodeOf(error.payload)).toBe(1);
  });

  test("a failure with no error block keeps the one-line message it always had", async () => {
    const error = (await runWrangler(await standIn("console.error('boom'); process.exit(1)"), {
      account: null,
      bin: NODE,
    }).catch((e: unknown) => e)) as PithyError;
    expect(error.payload.message.split("\n")).toHaveLength(1);
  });

  /**
   * **Which program `pithy` spawns to reach wrangler, and why it is a question at all — #474.**
   *
   * It was `bun x wrangler`, unconditionally, so every command that touches Cloudflare required Bun on
   * an adopter's PATH — in a CLI whose stated premise is that adoption is never gated behind a Bun
   * install. The failure named the wrong program too: `Could not run wrangler. Is wrangler installed
   * and on PATH?`, when wrangler was installed and `bun` was what was missing.
   *
   * Driven end to end rather than by asserting about an argv the code hands back. A fake manager on
   * `PATH` writes what it was called with, so what is checked is what a child process actually
   * received — the thing an adopter's shell sees. `PATH` is narrowed to the fixture alone, so a real
   * `bun` or `npx` on the machine running this cannot answer for it either way.
   */
  describe("routes through the project's own package manager", () => {
    let project: string;
    let fakeBin: string;

    beforeEach(async () => {
      project = await mkdtemp(join(tmpdir(), "pithy-wrangler-pm-"));
      fakeBin = join(project, "fake-bin");
      await mkdir(fakeBin, { recursive: true });
    });

    afterEach(async () => {
      await rm(project, { recursive: true, force: true });
    });

    /** A stand-in for `<name>` that prints the arguments it was handed, one per line. */
    async function plant(name: string): Promise<void> {
      const path = join(fakeBin, name);
      await writeFile(path, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
    }

    /**
     * What the spawned program reports it was called with, for a project carrying `lockfile`.
     *
     * `runner` is the program, not the manager: npm's way to run a workspace-local binary is `npx`,
     * which is a different executable from `npm`.
     */
    async function calledWith(lockfile: string, runner: string): Promise<string[]> {
      await writeFile(join(project, lockfile), "");
      await plant(runner);
      const { stdout } = await runWrangler(["deploy", NO_PROVISION_ARG], {
        account: null,
        cwd: project,
        env: { PATH: fakeBin },
      });
      return stdout.split("\n").filter(Boolean);
    }

    test("a bun project gets `bun x wrangler`", async () => {
      expect(await calledWith("bun.lock", "bun")).toEqual([
        "x",
        "wrangler",
        "--cwd",
        project,
        "deploy",
        NO_PROVISION_ARG,
      ]);
    });

    test("a pnpm project gets `pnpm exec wrangler`", async () => {
      expect(await calledWith("pnpm-lock.yaml", "pnpm")).toEqual([
        "exec",
        "wrangler",
        "--cwd",
        project,
        "deploy",
        NO_PROVISION_ARG,
      ]);
    });

    test("a yarn project gets `yarn wrangler`", async () => {
      expect(await calledWith("yarn.lock", "yarn")).toEqual(["wrangler", "--cwd", project, "deploy", NO_PROVISION_ARG]);
    });

    test("an npm project gets `npx wrangler`", async () => {
      expect(await calledWith("package-lock.json", "npx")).toEqual([
        "wrangler",
        "--cwd",
        project,
        "deploy",
        NO_PROVISION_ARG,
      ]);
    });

    /**
     * **wrangler is told where the Worker is, not left to infer it from where it was started (#709).** `npx`
     * runs a binary from the nearest package root, not from the spawn's `cwd`: in an npm workspace, or a
     * Worker directory with no lockfile under a package that has one, wrangler started in the package and
     * found no `wrangler.jsonc`. It then tried to autoconfigure the directory as a static site and failed
     * `Could not detect a directory containing static files` on a Worker that deploys fine. wrangler's own
     * global `--cwd` makes it `chdir` before it reads anything, whatever the runner did.
     */
    test("every runner hands wrangler the Worker directory as its own --cwd", async () => {
      for (const [lockfile, runner] of [
        ["bun.lock", "bun"],
        ["pnpm-lock.yaml", "pnpm"],
        ["yarn.lock", "yarn"],
        ["package-lock.json", "npx"],
      ] as const) {
        await rm(join(project, "bun.lock"), { force: true });
        await rm(join(project, "pnpm-lock.yaml"), { force: true });
        await rm(join(project, "yarn.lock"), { force: true });
        await rm(join(project, "package-lock.json"), { force: true });
        const argv = await calledWith(lockfile, runner);
        const at = argv.indexOf("--cwd");
        expect(at, `${runner} passed no --cwd`).toBeGreaterThan(-1);
        expect(argv[at + 1]).toBe(project);
        // Before the command, where yargs reads a global flag whatever the command's own options are.
        expect(at).toBeLessThan(argv.indexOf("deploy"));
      }
    });

    test("with no cwd given, wrangler is pointed at the process's own directory", async () => {
      await plant("npx");
      await plant("bun");
      const { stdout } = await runWrangler(["whoami", NO_PROVISION_ARG], { account: null, env: { PATH: fakeBin } });
      const argv = stdout.split("\n").filter(Boolean);
      expect(argv[argv.indexOf("--cwd") + 1]).toBe(process.cwd());
    });

    // No lockfile is npm, which is the fallback `detectPackageManager` documents: npm is present on
    // every Node install, and a project with no lockfile has not told us anything else.
    test("a project with no lockfile falls back to npx, not to bun", async () => {
      await plant("npx");
      const { stdout } = await runWrangler(["deploy", NO_PROVISION_ARG], {
        account: null,
        cwd: project,
        env: { PATH: fakeBin },
      });
      expect(stdout.split("\n").filter(Boolean)).toEqual(["wrangler", "--cwd", project, "deploy", NO_PROVISION_ARG]);
    });

    // Detection reads the lockfile beside `cwd`, not beside the CLI. This repository is a bun
    // workspace, so a test that let `cwd` default would pass on the wrong evidence.
    test("detection reads the project's lockfile, not this repository's", async () => {
      await writeFile(join(project, "package-lock.json"), "");
      await plant("npx");
      await plant("bun");
      const { stdout } = await runWrangler(["whoami", NO_PROVISION_ARG], {
        account: null,
        cwd: project,
        env: { PATH: fakeBin },
      });
      // Whole lines, not a substring: `bun x` arrives as a line of its own, and the temporary project
      // path is random, so a substring match fails whenever that path happens to end in `x`.
      expect(stdout.split("\n")).not.toContain("x");
      expect(stdout.split("\n").filter(Boolean)).toEqual(["wrangler", "--cwd", project, "whoami", NO_PROVISION_ARG]);
    });
  });

  test("rejects with a clear error when the binary is missing", async () => {
    const error = (await runWrangler(["--version", NO_PROVISION_ARG], {
      account: null,
      bin: "pithy-no-such-binary-xyz",
    }).catch((e: unknown) => e)) as PithyError;
    // A program that is not there is a precondition, exit 3, and every Worker's (#697).
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(exitCodeOf(error.payload)).toBe(3);
    expect(refusesTheRun(error)).toBe(true);
    expect(error.payload.action).toContain("installed");
  });

  // The other half of #474's misdirection: when the runner is missing, wrangler is not what to install.
  test("names the runner, not wrangler, when the runner is what is missing", async () => {
    const project = await mkdtemp(join(tmpdir(), "pithy-wrangler-missing-"));
    try {
      await writeFile(join(project, "bun.lock"), "");
      const error = (await runWrangler(["--version", NO_PROVISION_ARG], {
        account: null,
        cwd: project,
        // An empty PATH, so the runner cannot be found however the machine is set up.
        env: { PATH: join(project, "nothing-here") },
      }).catch((e: unknown) => e)) as PithyError;

      expect(error.payload.code).toBe("core/precondition_failed");
      expect(error.payload.action).toContain("bun");
      expect(error.payload.action).not.toContain("Is wrangler installed");
      expect(error.payload.detail).toContain("spawning bun");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("passthrough mode resolves on success (nothing captured — output already streamed)", async () => {
    await expect(
      runWrangler(await standIn("process.exit(0)"), { account: null, bin: NODE, passthrough: true }),
    ).resolves.toEqual({
      stdout: "",
      stderr: "",
    });
  });

  test("the project's credentials reach the child, over whatever the shell exported (#555)", async () => {
    // The account is an argument here for the reason `deploy` states: resolving against the wrong one
    // does not fail, it ships to another company's tenant and exits 0. The child's environment is built
    // by `cloudflareChildEnv`, so a spawn cannot inherit the shell's token by omission.
    const dir = await mkdtemp(join(tmpdir(), "pithy-wrangler-account-"));
    try {
      await writeFile(join(dir, "cloudflare.json"), JSON.stringify({ CLOUDFLARE_API_TOKEN: "project-token" }), {
        mode: 0o600,
      });
      vi.stubEnv("PITHY_CONFIG_DIR", dir);
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "shell-token");
      await expect(
        runWrangler(await standIn("process.exit(process.env.CLOUDFLARE_API_TOKEN === 'project-token' ? 0 : 1)"), {
          account: null,
          bin: NODE,
        }),
      ).resolves.toEqual({ stdout: "", stderr: "" });
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses before the spawn when the project's pin and the credentials disagree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-wrangler-pin-"));
    try {
      await writeFile(join(dir, "cloudflare.json"), JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "other-account" }), {
        mode: 0o600,
      });
      vi.stubEnv("PITHY_CONFIG_DIR", dir);
      const error = (await runWrangler(["--version", NO_PROVISION_ARG], {
        account: { accountId: "pinned-account" },
        bin: NODE,
      }).catch((e: unknown) => e)) as PithyError;
      expect(error).toBeInstanceOf(PithyError);
      expect(error.payload.message).toContain("pinned-account");
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes extra env to the child — how wrangler gets CLOUDFLARE_API_TOKEN from .dev.vars", async () => {
    // The child exits 0 only when the injected env var is visible to it.
    await expect(
      runWrangler(await standIn("process.exit(process.env.PITHY_WRANGLER_TEST === 'ok' ? 0 : 1)"), {
        account: null,
        bin: NODE,
        env: { PITHY_WRANGLER_TEST: "ok" },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "" });
  });
});

/**
 * **A wrangler spawn creates nothing, and the seam is where that is true (#589).**
 *
 * The rule was held at the two deploy sites and by a sweep reading `runWrangler(` as text. A review
 * planted `const ship = runWrangler; await ship(argv)` and `runWrangler.call(undefined, argv, …)` beside a
 * gated call, on an argv with the switch sliced off, and every half of the sweep stayed green: text cannot
 * count a call spelled some other way. A call under any name is still a call to this function, so this is
 * the one place the rule cannot be walked around.
 *
 * Every spawn, not every deploy. `--experimental-provision` is one of wrangler's global options — every
 * command accepts it, and every command's experimental flags default provisioning on — so there is no
 * list of commands to keep current, and no argv shape to recognize a deploy by.
 */
describe("runWrangler creates nothing, whatever name it is reached by", () => {
  let dir: string;
  let marker: string;
  let script: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-wrangler-provision-"));
    marker = join(dir, "spawned");
    // A script file rather than `-e`: node reads a flag after `-e <code>` as its own option and exits 9,
    // where the arguments after a script path are the script's — as they are wrangler's.
    script = join(dir, "stand-in.cjs");
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));\n`,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A child that leaves a file behind, so "nothing was spawned" is read off disk rather than inferred. */
  const touch = () => [script, "deploy"];

  async function spawned(): Promise<boolean> {
    return readFile(marker).then(
      () => true,
      () => false,
    );
  }

  test("an argv that leaves provisioning on is refused before anything is spawned", async () => {
    const error = (await runWrangler(touch(), { account: null, bin: NODE }).catch((e: unknown) => e)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.message).toBe("This deploy could create Cloudflare resources, so nothing was deployed.");
    expect(await spawned()).toBe(false);
  });

  test("an alias and a .call reach the same refusal — the spellings the call-site sweep could not count", async () => {
    const ship = runWrangler;
    await expect(ship(touch(), { account: null, bin: NODE })).rejects.toBeInstanceOf(PithyError);
    await expect(runWrangler.call(undefined, touch(), { account: null, bin: NODE })).rejects.toBeInstanceOf(PithyError);
    expect(await spawned()).toBe(false);
  });

  test("a second statement about provisioning is refused, even beside the switch", async () => {
    await expect(
      runWrangler([...touch(), NO_PROVISION_ARG, "--x-provision"], { account: null, bin: NODE }),
    ).rejects.toBeInstanceOf(PithyError);
    expect(await spawned()).toBe(false);
  });

  test("an argv carrying the switch spawns", async () => {
    await runWrangler([...touch(), NO_PROVISION_ARG], { account: null, bin: NODE });
    expect(await spawned()).toBe(true);
  });
});
