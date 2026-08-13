// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authSecretsRegistry } from "@pithy-sh/auth/src/instance/secrets";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { requireProvisionMode } from "./mode";
import { pendingSecretLines, pendingSecrets } from "./pendingSecrets";

/**
 * **#330: a remedy that works in one mode was printed in both.**
 *
 * `pithy provision` cannot create a `d1` secret, and says so. What it said next — *run
 * `pithy secrets provision`* — is true for a declared environment and false for a branch: that command
 * spans the environments the project declares and deploys a manager into each, and a feature environment
 * is neither declared nor given one. An operator ran it, nothing happened, and the message had cost them
 * a command and taught them nothing.
 *
 * The gate is the one #324 settled on for the same class of defect: **extract every `pithy …` command
 * the output names and assert the set.** A menu whose only item cannot be chosen fails whatever words
 * surround it, and prose that merely differs between the modes would pass a weaker check while still
 * naming a dead end.
 */

/** The registries the kit ships, merged: the set one project composing auth, email and secrets declares. */
const SHIPPED: SecretRegistry = {
  ...authSecretsRegistry,
  ...emailSigningRegistry,
  [MASTER_KEY_BINDING]: masterKeyRegistryEntry,
};

/**
 * Every mode there is, produced by the resolver that produces them in a real run — never by reading the
 * table under test. A third kind fails `tsc` at `PENDING_SECRET_REMEDY`, which is the other half of this.
 */
const MODES = [requireProvisionMode({ env: "staging", feature: false }), requireProvisionMode({ feature: true })];

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "commands");

/** Every command module's source, keyed by the top-level `pithy` verb it defines. */
function commandSources(): Map<string, string> {
  return new Map(
    readdirSync(COMMANDS_DIR)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => [file.slice(0, -3), readFileSync(join(COMMANDS_DIR, file), "utf8")]),
  );
}

/**
 * Every `pithy <command> [<subcommand>]` a block of output names, deduplicated, in the order it appears.
 *
 * **Two words, because the CLI is two levels deep**, and that is asserted below rather than assumed: no
 * module declares `subCommands` twice, so no subcommand has subcommands of its own. Without the bound a
 * greedy match runs straight on through the rest of the sentence — `pithy secrets provision to create
 * them` — and a gate comparing that against a command name can never be satisfied by any real one.
 */
function commandsNamed(lines: string[]): string[] {
  const found = [...lines.join("\n").matchAll(/\bpithy(?: [a-z][a-z-]*){1,2}/g)].map((match) => match[0]);
  return [...new Set(found)];
}

describe("the secrets provision defers, and who can create them", () => {
  /**
   * The floor. Every assertion below is about a non-empty warning, and a kit that deferred nothing would
   * make each of them `[] === []` — the vacuity this repository has shipped before (#321's own tests).
   */
  test("the kit as shipped gives both modes something to defer", () => {
    for (const mode of MODES) expect(pendingSecrets(SHIPPED, mode).names.length).toBeGreaterThan(1);
    expect(MODES.length).toBe(2);
  });

  /**
   * The names are a fact about the registry: both modes run before any manager exists, so both defer the
   * same set. Only the advice attached to them was ever mode-dependent, and this is what says the fix did
   * not quietly narrow the warning itself.
   */
  test("both modes defer the same secrets", () => {
    const [declared, feature] = MODES.map((mode) => pendingSecrets(SHIPPED, mode).names);
    expect(declared).toEqual(feature);
    expect(declared).toContain("auth-session-secret");
    expect(declared).toContain("email-link-signing-key");
  });

  /** `--env`'s answer is unchanged: one command, and it is the one that deploys the managers. */
  test("--env names the command that creates them", () => {
    const mode = MODES[0];
    if (mode === undefined) throw new Error("no declared-environment mode");
    const lines = pendingSecretLines(pendingSecrets(SHIPPED, mode));
    expect(commandsNamed(lines)).toEqual(["pithy secrets provision"]);
    expect(lines.join("\n")).toContain("auth-session-secret, email-link-signing-key");
  });

  /**
   * **The defect, stated as the set it produced.** `--feature` used to name `pithy secrets provision`,
   * which cannot create these for a branch. No command can, so the set is empty — and a future edit that
   * invents one has to make it real before this passes again.
   */
  test("--feature names no command, because none can create them for a branch", () => {
    const mode = MODES[1];
    if (mode === undefined) throw new Error("no feature mode");
    const lines = pendingSecretLines(pendingSecrets(SHIPPED, mode));
    expect(commandsNamed(lines)).toEqual([]);
    expect(pendingSecrets(SHIPPED, mode).remedy).toBeNull();
  });

  /** A shortfall stated, not a blank. The line says nothing creates them and what that leaves behind. */
  test("--feature states the shortfall rather than trailing off", () => {
    const mode = MODES[1];
    if (mode === undefined) throw new Error("no feature mode");
    const advice = pendingSecretLines(pendingSecrets(SHIPPED, mode))[1] ?? "";
    expect(advice).toMatch(/no command creates these/i);
    expect(advice).toMatch(/without them/i);
  });

  /**
   * The two modes differ **in the advice**, not merely somewhere. The first line is the same fact in both;
   * the second is the whole subject of this issue.
   */
  test("the modes differ in the advice and agree on the fact", () => {
    const [declared, feature] = MODES.map((mode) => pendingSecretLines(pendingSecrets(SHIPPED, mode)));
    expect(declared?.[0]).toEqual(feature?.[0]);
    expect(declared?.[1]).not.toEqual(feature?.[1]);
  });

  /**
   * Every command any mode names is a command the CLI has, verb and subcommand both. #324's refusal named
   * `pithy secrets create` for a state no `create` could repair; this is the weaker but automatic half of
   * that — a remedy naming a verb that does not exist at all never reaches an operator.
   */
  test("every command any mode names is one the CLI ships", () => {
    const named = MODES.flatMap((mode) => commandsNamed(pendingSecretLines(pendingSecrets(SHIPPED, mode))));
    expect(named.length).toBeGreaterThan(0);
    const sources = commandSources();
    expect(sources.size).toBeGreaterThan(20);
    const unshipped = named.filter((command) => {
      const [, verb = "", sub] = command.split(" ");
      const source = sources.get(verb);
      if (source === undefined) return true;
      return sub !== undefined && !new RegExp(`\\bsubCommands:[^}]*\\b${sub}\\b`, "s").test(source);
    });
    expect(unshipped).toEqual([]);
  });

  /**
   * The bound `commandsNamed` relies on, checked rather than believed: one `subCommands` per module means
   * a command path is at most `pithy <verb> <subcommand>`. A third level would make the extractor silently
   * truncate, and a truncated command is exactly the thing this file exists to catch.
   */
  test("the CLI is two levels deep, which is what bounds the extractor", () => {
    const depths = [...commandSources()].map(
      ([command, source]) => [command, source.match(/\bsubCommands:/g)?.length ?? 0] as const,
    );
    expect(depths.filter(([, levels]) => levels > 1)).toEqual([]);
    // A floor, or the bound is about nothing: several commands really do have subcommands.
    expect(depths.filter(([, levels]) => levels === 1).length).toBeGreaterThan(5);
  });

  /** A project declaring no arbitrary `d1` secret reads no paragraph about one, in either mode. */
  test("nothing deferred prints nothing", () => {
    for (const mode of MODES) expect(pendingSecretLines(pendingSecrets({}, mode))).toEqual([]);
  });
});
