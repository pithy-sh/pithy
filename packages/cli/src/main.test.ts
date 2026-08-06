// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import { main } from "./main";

/** Resolve a (possibly lazy) citty subcommand. */
async function subcommand(name: string): Promise<CommandDef> {
  const entry = (main.subCommands as Record<string, CommandDef | (() => Promise<CommandDef>)>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return typeof entry === "function" ? await entry() : entry;
}

async function argNames(name: string): Promise<string[]> {
  const command = await subcommand(name);
  const args = typeof command.args === "function" ? await command.args() : command.args;
  return Object.keys(args ?? {});
}

describe("main", () => {
  test("registers init, add, remove, migrate, deploy, and token", () => {
    expect(Object.keys(main.subCommands as object)).toEqual(
      expect.arrayContaining(["init", "add", "remove", "migrate", "deploy", "token"]),
    );
  });

  test("registers the six commands added for the standard surface (docs/CLI.md §1.1)", () => {
    expect(Object.keys(main.subCommands as object)).toEqual(
      expect.arrayContaining(["worker", "dev", "env", "upgrade", "alias", "doctor"]),
    );
  });

  test("worker exposes add, list, remove, and sync subcommands", async () => {
    const worker = await subcommand("worker");
    expect(Object.keys(worker.subCommands ?? {})).toEqual(expect.arrayContaining(["add", "list", "remove", "sync"]));
  });

  test("worker sync is agent-drivable — --worker, --env, and --json, no prompt required", async () => {
    const worker = await subcommand("worker");
    const sync = (worker.subCommands as Record<string, CommandDef>).sync;
    expect(Object.keys(sync?.args ?? {})).toEqual(["worker", "env", "json"]);
  });

  test("the new commands are agent-drivable — every one supports --json", async () => {
    for (const name of ["dev", "env", "upgrade", "alias", "doctor"]) {
      expect(await argNames(name)).toContain("json");
    }
  });

  test("vector exposes provision, reset, and reprocess", async () => {
    const vector = await subcommand("vector");
    expect(Object.keys(vector.subCommands ?? {})).toEqual(["provision", "reset", "reprocess"]);
  });

  test("storage exposes provision and deprovision, both --json", async () => {
    const storage = await subcommand("storage");
    expect(Object.keys(storage.subCommands ?? {})).toEqual(["provision", "deprovision"]);
    for (const name of ["provision", "deprovision"] as const) {
      const sub = (storage.subCommands as Record<string, CommandDef>)[name];
      expect(Object.keys(sub?.args ?? {})).toContain("json");
    }
  });

  test("payments exposes provision and reconcile, both --json", async () => {
    const payments = await subcommand("payments");
    expect(Object.keys(payments.subCommands ?? {})).toEqual(["provision", "reconcile"]);
    for (const name of ["provision", "reconcile"] as const) {
      const sub = (payments.subCommands as Record<string, CommandDef>)[name];
      expect(Object.keys(sub?.args ?? {})).toContain("json");
    }
  });

  test("support exposes provision and deprovision, both --json", async () => {
    const support = await subcommand("support");
    expect(Object.keys(support.subCommands ?? {})).toEqual(["provision", "deprovision"]);
    for (const name of ["provision", "deprovision"] as const) {
      const sub = (support.subCommands as Record<string, CommandDef>)[name];
      expect(Object.keys(sub?.args ?? {})).toContain("json");
    }
  });

  test("support provision carries all three routing flags — a rule cannot be half-declared", async () => {
    // Creating an Email Routing rule takes over the zone's MX, so the zone, the address, and the target
    // worker are each named explicitly or no rule is made. All three have to be flags for that choice to
    // be drivable without a prompt.
    const support = await subcommand("support");
    const provision = (support.subCommands as Record<string, CommandDef>).provision;
    expect(Object.keys(provision?.args ?? {})).toEqual(
      expect.arrayContaining(["routing-zone", "inbound-address", "app-worker", "worker", "json"]),
    );
  });

  test("testers exposes the whole roster flow, every subcommand --json", async () => {
    // The definition of done is that a developer can run a closed test without the dashboard, so every
    // operation the control-plane routes expose has a command here — and every one of them is
    // agent-drivable, because the dashboard is not the only client that matters.
    const testers = await subcommand("testers");
    expect(Object.keys(testers.subCommands ?? {})).toEqual([
      "provision",
      "deprovision",
      "create",
      "list",
      "invite",
      "pending",
      "roster",
      "status",
      "remove",
      "close",
      "run",
    ]);
    for (const name of [
      "provision",
      "deprovision",
      "create",
      "list",
      "invite",
      "pending",
      "roster",
      "status",
      "remove",
      "close",
      "run",
    ] as const) {
      const sub = (testers.subCommands as Record<string, CommandDef>)[name];
      expect(Object.keys(sub?.args ?? {})).toContain("json");
      // And every one names an environment, so a CI run can never mean "whichever". Provisioning fans
      // out across all of them by default, so there `--env` narrows rather than selects.
      expect(Object.keys(sub?.args ?? {})).toContain("env");
    }
  });

  test("payments reconcile can be driven headlessly — every narrowing is a flag", async () => {
    // The support path is "reconcile one user in production and tell me what changed", and an agent has to be
    // able to run it with no prompt. Every field of the pass's params that a human would want is a flag here.
    const payments = await subcommand("payments");
    const reconcile = (payments.subCommands as Record<string, CommandDef>).reconcile;
    expect(Object.keys(reconcile?.args ?? {})).toEqual(
      expect.arrayContaining(["env", "user", "rail", "dry-run", "json"]),
    );
  });

  test("storage and media deprovision take the R2 key pair — a bucket cannot be emptied without it", async () => {
    // `--storage` deletes buckets, and R2 refuses to delete one that is not empty. Emptying is an
    // S3-protocol operation, so the flags that carry the key pair have to be on deprovision too, not
    // only on provision — otherwise the destructive path has no way to be driven non-interactively.
    for (const command of ["storage", "media"] as const) {
      const subCommands = (await subcommand(command)).subCommands as Record<string, CommandDef>;
      expect(Object.keys(subCommands.deprovision?.args ?? {})).toEqual(
        expect.arrayContaining(["storage", "r2-access-key-id", "r2-secret-access-key", "json"]),
      );
    }
  });

  test("remove takes --drop and --env", async () => {
    expect(await argNames("remove")).toEqual(expect.arrayContaining(["capability", "drop", "env"]));
  });

  test("token exposes mint, list, rotate, and revoke subcommands", async () => {
    const token = await subcommand("token");
    expect(Object.keys(token.subCommands ?? {})).toEqual(expect.arrayContaining(["mint", "list", "rotate", "revoke"]));
  });

  test("every command supports --json — agent-drivable, spec §10.20", async () => {
    for (const name of ["init", "add", "migrate", "deploy"]) {
      expect(await argNames(name)).toContain("json");
    }
  });

  test("deploy takes --env and --json", async () => {
    expect(await argNames("deploy")).toEqual(expect.arrayContaining(["env", "json"]));
  });

  test("init takes --name and --dir", async () => {
    expect(await argNames("init")).toEqual(expect.arrayContaining(["name", "dir", "json"]));
  });

  test("add takes the capability positionally (optional, so --list works alone) and a --list flag", async () => {
    const add = await subcommand("add");
    const args = add.args as Record<string, { type?: string; required?: boolean }>;
    expect(args.capability?.type).toBe("positional");
    expect(args.capability?.required).toBe(false);
    expect(args.list?.type).toBe("boolean");
  });

  test("migrate takes --env and --rollback", async () => {
    expect(await argNames("migrate")).toEqual(expect.arrayContaining(["env", "rollback", "json"]));
  });
});
