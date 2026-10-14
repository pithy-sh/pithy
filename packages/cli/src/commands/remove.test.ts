// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RemoveCapabilityOptions } from "../capabilities/remove";
import { collectMigrationSets } from "../migrations/registry";
import { latchInputMode } from "../terminal/inputMode";
import remove, { rejectJson, rejectNoInput, requireDropConfirmable } from "./remove";

/** What `pithy remove` handed the removal: the drop's environment, and the composition it reverses from. */
const seen = vi.hoisted(() => ({ calls: [] as { drop: string | undefined; migrations: string[] }[] }));

vi.mock("../capabilities/remove", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/remove")>()),
  removeCapability: async (options: RemoveCapabilityOptions) => {
    const capabilities = await options.steps.loadCapabilities();
    seen.calls.push({
      drop: options.drop?.env,
      migrations: collectMigrationSets(capabilities).flatMap((set) => Object.keys(set.migrations)),
    });
    return {
      capability: options.capability,
      present: false,
      ejected: false,
      removedBindings: [],
      keptFor: [],
      tablesRemain: false,
    };
  },
}));

describe("remove command", () => {
  test("meta and args shape — --worker names the worker to unwire", () => {
    const args = remove.args as Record<string, { type: string; default?: unknown; required?: boolean }>;
    expect(remove.meta).toMatchObject({ name: "remove" });
    expect(Object.keys(args)).toEqual(["capability", "worker", "drop", "env", "destroy-retained", "json"]);
    expect(args.capability).toMatchObject({ type: "positional", required: true });
    expect(args.worker).toMatchObject({ type: "string" });
  });
});

describe("rejectJson", () => {
  test("fast-fails on --json with a manual-command PithyError", () => {
    const failure = (() => {
      try {
        rejectJson(true);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/manual command/i);
    // Exit 5: no call an agent could make instead is the right one (#697).
    expect((failure as PithyError).payload.code).toBe("core/person_required");
  });

  test("does nothing without --json", () => {
    expect(() => rejectJson(false)).not.toThrow();
  });
});

/**
 * **Under the explicit switch, `remove` is refused, exit 5 (#697).** `--no-input` and
 * `PITHY_NONINTERACTIVE=1` say outright that nobody is at the keyboard, and `remove` belongs to a person,
 * as `docs/CLI.md` §3.8 and the `AGENTS.md` block both say. A run that merely has no terminal is not the
 * switch, and keeps unwiring as it always has.
 */
describe("rejectNoInput", () => {
  test("the switch needs a person, before anything is read", () => {
    let thrown: unknown;
    try {
      rejectNoInput(true, "auth");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload).toMatchObject({ code: "core/person_required" });
    expect(payload.message).toBe("pithy remove is a manual command, and this run forbids prompts.");
    expect(payload.action).toBe(
      "`pithy remove auth` deletes a capability's wiring. That is a person's decision, not a fix. Run it at a terminal, without --no-input or PITHY_NONINTERACTIVE.",
    );
  });

  test("without the switch it does nothing", () => {
    expect(() => rejectNoInput(false, "auth")).not.toThrow();
  });
});

describe("remove under the switch", () => {
  afterEach(() => {
    latchInputMode(false);
    vi.restoreAllMocks();
  });

  test("exits 5 and removes nothing", async () => {
    seen.calls.length = 0;
    latchInputMode(true);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(
      remove.run?.({
        args: { capability: "auth", json: false, drop: false, env: "dev" },
        rawArgs: [],
      } as never),
    ).rejects.toThrow("exit 5");
    expect(exit).toHaveBeenCalledWith(5);
    expect(stderr.join("")).toContain("pithy remove is a manual command, and this run forbids prompts.");
    expect(seen.calls).toEqual([]);
  });
});

/**
 * **`pithy remove --drop --env staging` reverses the migrations of the composition for staging (#595).**
 *
 * The Worker it unwires was picked by `commands/add.ts`'s `targetWorker`, which composed with no environment
 * stamped, and the drop reversed the migrations of that composition. A config that composes a migration for
 * staging alone had that migration left out of a drop against staging's database. The environments gate did
 * not see it, because the composition was carried out of `add.ts` by a function `remove.ts` called.
 */
/**
 * `--drop` asks a person, and there is no flag that answers for one. A run that may not prompt is refused
 * before anything is read — it used to reach the clack prompt whatever the terminal state (#697).
 */
describe("requireDropConfirmable", () => {
  test("a run that may prompt, or one not dropping, passes", () => {
    expect(() => requireDropConfirmable("auth", { drop: true, interactive: true, env: "dev" })).not.toThrow();
    expect(() => requireDropConfirmable("auth", { drop: false, interactive: false, env: "dev" })).not.toThrow();
  });

  test("--drop where nobody may be asked needs a person, because no flag answers it", () => {
    let thrown: unknown;
    try {
      requireDropConfirmable("auth", { drop: true, interactive: false, env: "dev" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload).toMatchObject({ code: "core/person_required" });
    expect(payload.message).toBe("Dropping auth's tables needs a person to confirm it.");
    expect(payload.action).toBe(
      "`pithy remove auth --drop --env dev` deletes a capability's wiring and a capability's tables. That is a person's decision, not a fix. Run it at a terminal, without --no-input or PITHY_NONINTERACTIVE.",
    );
  });
});

describe("remove --drop composes for the environment it drops", () => {
  let dir: string;

  beforeEach(async () => {
    seen.calls.length = 0;
    dir = await mkdtemp(join(tmpdir(), "pithy-remove-env-"));
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme", environments: ["staging"] };\n');
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "api" }));
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const environment = process.env.ENVIRONMENT ?? "none";',
        "const noop = { up: async () => {}, down: async () => {} };",
        "export default {",
        "  capabilities: [",
        '    { name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables: {}, migrationOrder: 1000, migrations: { [["0001", environment].join(":")]: noop } } } },',
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(args: Record<string, unknown>): Promise<void> {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // A person at a terminal: `--drop` is refused before anything is read when nobody may be asked
    // (`requireDropConfirmable`), and this suite is about what a drop composes, not who confirms it.
    const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    try {
      await remove.run?.({
        args: { capability: "app", json: false, drop: false, env: "dev", ...args },
        rawArgs: [],
      } as never);
    } finally {
      process.stdin.isTTY = tty.stdin;
      process.stdout.isTTY = tty.stdout;
      cwd.mockRestore();
      stdout.mockRestore();
    }
  }

  test("a drop for staging reverses staging's migrations, and a plain unwiring reads dev's", async () => {
    await run({ drop: true, env: "staging" });
    await run({});
    expect(seen.calls).toEqual([
      { drop: "staging", migrations: ["0001:staging"] },
      { drop: undefined, migrations: ["0001:dev"] },
    ]);
  });

  /**
   * **Another account's credentials stop only the run that would use them (#739).** An unwiring and a
   * `--drop --env dev` touch this machine alone, so the audit they get is inert and reads nothing. A drop
   * against staging reaches a live database, and refuses before anything is removed.
   */
  test("under another account's credentials, a local removal runs and a remote drop refuses", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      'export default { name: "acme", environments: ["staging"], cloudflare: { accountId: "pinned-account" } };\n',
    );
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "other-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    const stderr: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    try {
      await run({});
      await run({ drop: true, env: "dev" });
      expect(seen.calls.map((call) => call.drop)).toEqual([undefined, "dev"]);

      await expect(run({ drop: true, env: "staging" })).rejects.toThrow("exit 3");
      expect(stderr.join("")).toContain(
        "This project pins Cloudflare account pinned-account, and the environment supplies credentials for other-account.",
      );
      expect(seen.calls).toHaveLength(2);
    } finally {
      write.mockRestore();
      exit.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
