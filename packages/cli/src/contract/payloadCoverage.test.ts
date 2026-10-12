// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import type { ArgsDef } from "citty";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isTestFile, readSource, sourcePaths } from "../ci/sourceFiles";
import { main } from "../main";
import { expectConforms } from "../test-utils/payloadContract";
import { contractOf } from "./commandContract";
import { type TreeNode, walkTree } from "./describe";

/**
 * **Every command's `--json` payload is a Zod schema, and a test parses its real output against it (#697).**
 *
 * The contract is only as good as the set it covers, so this asks it of the whole tree at once — the same
 * shape as the docs gate, the migration orders and the stamped versions, and for the same reason: the
 * property is only true as a set.
 *
 * - Every command that runs declares a contract. A group, which only prints help, declares none.
 * - Every command that takes `--json` publishes a payload; `remove`, which refuses `--json` by design,
 *   is the one that takes the flag and publishes `none`.
 * - Every contract names only flags the command declares, in its facts and in its groups.
 * - Every field of every payload is described, because the descriptions are what `pithy schema` says.
 * - **Every payload is parsed from real output somewhere**: a test calls `expectConforms("<path>", …)`
 *   with the command's path as a literal, and this scans the test sources for it.
 */

const SRC = join(import.meta.dirname, "..");

const nodes = await walkTree(main);
const pathOf = (node: TreeNode): string => node.path.join(" ");
const runnable = nodes.filter((node) => typeof node.cmd.run === "function");

/** One command's parser, resolved. */
async function argsOf(node: TreeNode): Promise<ArgsDef> {
  const args = node.cmd.args;
  return ((typeof args === "function" ? await args() : await args) ?? {}) as ArgsDef;
}

/**
 * Every `expectConforms("<path>"` in a test file, as the path. This file is left out: its planted-defect
 * lines are hand-built, not a real run, and must not count as coverage. `override` stands in for a file's
 * text, so a planted defect can delete a real call without touching the disk.
 */
function conformedPaths(override: ReadonlyMap<string, string> = new Map()): Set<string> {
  const found = new Set<string>();
  for (const path of sourcePaths(SRC, { keep: isTestFile })) {
    if (path === import.meta.filename) continue;
    const text = override.get(path) ?? readSource(path);
    if (text === null) continue;
    for (const match of blankComments(text).matchAll(/expectConforms\(\s*"([a-z][a-z -]*)"/g))
      found.add(match[1] as string);
  }
  return found;
}

/**
 * Every object in a JSON Schema that passes keys it does not name — a `z.looseObject`, or a record of
 * unknowns — by where it sits. Inside one, `expectConforms` checks only the keys it does name.
 */
function undeclaredKeys(schema: unknown, at = "$"): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];
  if (node.type === "object" && node.additionalProperties !== undefined && node.additionalProperties !== false)
    found.push(at);
  for (const [key, property] of Object.entries((node.properties as Record<string, unknown> | undefined) ?? {}))
    found.push(...undeclaredKeys(property, `${at}.${key}`));
  found.push(...undeclaredKeys(node.items, `${at}[]`));
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) found.push(...undeclaredKeys(branch, `${at}|${index}`));
  }
  return found;
}

/**
 * **The known gap: payload subtrees published open, so neither an agent nor `expectConforms` learns their
 * shape.** Most are the doctor check blocks, the testers cohort view's parts, the seed writes, the secrets
 * sweep and the upgrade entries, whose shapes live in packages a shipped module cannot import. `schema`'s own
 * are JSON Schema documents, which are open by nature. The list may only shrink: a new open subtree fails
 * below, and so does typing one without taking it off.
 */
const OPEN_SUBTREES = [
  "dev: $|0.workers",
  "dev: $|4.autostart",
  "doctor: $.cloudflare.accountMismatch|0",
  "doctor: $.cloudflare.credentialSplit|0",
  "doctor: $.devPreferences|0",
  "doctor: $.devSecretsFile|0",
  "doctor: $.devSecrets|0",
  "doctor: $.devVarsLocal|0",
  "doctor: $.devVars|0",
  "doctor: $.docsMcp|0",
  "doctor: $.environmentConfigs|0",
  "doctor: $.environmentConfigs|0.unresolved[]",
  "doctor: $.environmentInheritance|0",
  "doctor: $.environmentInheritance|0.unrepeated[]",
  "doctor: $.environments|0",
  "doctor: $.environments|0.drift[]",
  "doctor: $.extensions|0",
  "doctor: $.extensions|0.extensions[]",
  "doctor: $.featureRatelimitIds|0",
  "doctor: $.localDelivery|0",
  "doctor: $.origins|0",
  "doctor: $.origins|0.drift[]",
  "doctor: $.portsRegistry|0",
  "doctor: $.projectName|0",
  "doctor: $.projectName|0.misnamed[]",
  "doctor: $.project|0",
  "doctor: $.project|0.capabilities[]",
  "doctor: $.project|0.health.bindingScope.divergent[]",
  "doctor: $.project|0.health.bindingScope.split[]",
  "doctor: $.project|0.health.workers[]|0.bindings.declinedBindings|0.declines[]",
  "doctor: $.project|0.health.workers[]|0.migrations.environments[]",
  "doctor: $.secretBindings|0",
  "doctor: $.secretBindings|0.missing[]",
  "doctor: $.selfBinding|0",
  "doctor: $.selfBinding|0.missing[]",
  "doctor: $.settings|0",
  "doctor: $.settings|0.account",
  "doctor: $.settings|0.checked[]",
  "doctor: $.settings|0.findings[]",
  "doctor: $.settings|0.unchecked[]",
  "doctor: $.sharedRuntimes|0",
  "doctor: $.sharedRuntimes|0.copies",
  "doctor: $.supportSearchTriggers|0",
  "doctor: $.supportSearchTriggers|0.environments[]",
  "doctor: $.turnstileSitekeys|0",
  "doctor: $.turnstileSitekeys|0.stranded[]",
  "doctor: $.turnstileSitekeys|0.unrendered[]",
  "doctor: $.workerNames|0",
  "doctor: $.workerNames|0.convention[]",
  "doctor: $.workerNames|0.mismatches[]",
  "doctor: $.workerNames|0.reserved[]",
  "doctor: $.workflows|0",
  "doctor: $.workflows|0.drift[]",
  "feature create: $.dev.workers",
  "feature sync: $.dev.workers",
  "payments reconcile: $.report|0",
  "provision: $.declined[]",
  "provision: $.declined[].declines[]",
  "schema: $|0.commands[].events|0",
  "schema: $|0.commands[].payload|0",
  "schema: $|0.errorLine",
  "schema: $|1.commands[].events|0",
  "schema: $|1.commands[].payload|0",
  "schema: $|1.errorLine",
  "secrets verify: $.environments[].verification",
  "secrets verify: $.sweep",
  "seed: $.devSecrets|0",
  "seed: $.workers[].sets[].d1[]",
  "seed: $.workers[].sets[].kv[]",
  "seed: $.workers[].sets[].media[]",
  "seed: $.workers[].sets[].r2[]",
  "testers roster: $.cohort",
  "testers roster: $.cohort.disclaimer",
  "testers roster: $.cohort.members[]",
  "testers roster: $.cohort.projection",
  "testers roster: $.cohort.reconciliation",
  "testers roster: $.cohort.trend",
  "testers run: $.results[].nudged",
  "testers status: $.cohort",
  "testers status: $.cohort.disclaimer",
  "testers status: $.cohort.members[]",
  "testers status: $.cohort.projection",
  "testers status: $.cohort.reconciliation",
  "testers status: $.cohort.trend",
  "turnstile provision: $.sitekeys",
  "upgrade: $.packages",
  "upgrade: $.workers[]",
];

/** Every property in a JSON Schema that carries no description, by where it sits. */
function undescribed(schema: unknown, at = "$"): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const missing: string[] = [];
  const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
  for (const [key, property] of Object.entries(properties ?? {})) {
    if (typeof property.description !== "string" || property.description === "") missing.push(`${at}.${key}`);
    missing.push(...undescribed(property, `${at}.${key}`));
  }
  for (const keyword of ["items", "additionalProperties"]) missing.push(...undescribed(node[keyword], `${at}[]`));
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) missing.push(...undescribed(branch, `${at}|${index}`));
  }
  return missing;
}

describe("every command declares what it promises", () => {
  test("the walk found the tree", () => {
    expect(runnable.length).toBeGreaterThan(70);
  });

  test("every command that runs declares a contract, and no group does", () => {
    expect(runnable.filter((node) => contractOf(node.cmd) === undefined).map(pathOf)).toEqual([]);
    const groups = nodes.filter((node) => typeof node.cmd.run !== "function");
    expect(groups.length).toBeGreaterThan(10);
    expect(groups.filter((node) => contractOf(node.cmd) !== undefined).map(pathOf)).toEqual([]);
  });

  test("a command that takes --json publishes a payload, but for remove, which refuses it", async () => {
    const mismatched: string[] = [];
    for (const node of runnable) {
      const takesJson = Object.hasOwn(await argsOf(node), "json");
      const publishes = contractOf(node.cmd)?.output !== "none";
      if (takesJson !== publishes) mismatched.push(pathOf(node));
    }
    expect(mismatched).toEqual(["remove"]);
  });

  test("a contract names only flags its command declares", async () => {
    const strays: string[] = [];
    for (const node of runnable) {
      const contract = contractOf(node.cmd);
      const args = await argsOf(node);
      const flags = new Set(Object.keys(args).map((name) => `--${name}`));
      for (const name of Object.keys(contract?.flags ?? {})) {
        if (!Object.hasOwn(args, name)) strays.push(`${pathOf(node)}: facts for ${name}`);
      }
      for (const group of contract?.flagGroups ?? []) {
        const named = group.kind === "requires" ? [group.flag, ...group.needs] : group.flags;
        for (const flag of named) if (!flags.has(flag)) strays.push(`${pathOf(node)}: group names ${flag}`);
      }
    }
    expect(strays).toEqual([]);
  });

  /**
   * citty hands every word past the last declared positional to `args._`, so only the last one can take them,
   * and only a positional takes words at all. `pithy schema`'s command is the one today.
   */
  test("a variadic positional is its command's last positional, and nothing else is variadic", async () => {
    const variadic: string[] = [];
    const strays: string[] = [];
    for (const node of runnable) {
      const args = await argsOf(node);
      const positionals = Object.entries(args)
        .filter(([, def]) => (def as { type?: string }).type === "positional")
        .map(([name]) => name);
      for (const [name, facts] of Object.entries(contractOf(node.cmd)?.flags ?? {})) {
        if (facts.variadic !== true) continue;
        variadic.push(`${pathOf(node)} ${name}`);
        if (positionals.at(-1) !== name) strays.push(`${pathOf(node)}: ${name}`);
      }
    }
    expect(variadic).toEqual(["schema command"]);
    expect(strays).toEqual([]);
  });

  test("every field of every payload says what it is", () => {
    const missing: string[] = [];
    for (const node of runnable) {
      const payload = contractOf(node.cmd)?.payload;
      if (payload === undefined) continue;
      const schema = z.toJSONSchema(payload, { io: "input" });
      if (typeof schema.description !== "string") missing.push(`${pathOf(node)}: $`);
      missing.push(...undescribed(schema).map((at) => `${pathOf(node)}: ${at}`));
    }
    expect(missing).toEqual([]);
  });

  test("every payload is parsed from a real run of its command, by name", () => {
    const conformed = conformedPaths();
    const published = runnable.filter((node) => contractOf(node.cmd)?.output !== "none").map(pathOf);
    expect(published.filter((path) => !conformed.has(path))).toEqual([]);
    // And no test names a command that publishes nothing, or one that does not exist.
    expect([...conformed].filter((path) => !published.includes(path)).sort()).toEqual([]);
  });

  /**
   * Planted defects: a line with a key its schema does not name, and one missing a key it requires, are both
   * refused — so a passing `expectConforms` is a statement about the line rather than about a lenient parse.
   */
  test("a line that is not the published shape is refused, in either direction", async () => {
    const status = {
      command: "alias",
      schemaVersion: 1,
      action: "status",
      installed: true,
      shell: "zsh",
      rcPath: "/home/you/.zshrc",
    };
    await expectConforms("alias", JSON.stringify(status));
    // Without its version, or at one the command does not declare, it is not the published shape either.
    const { schemaVersion: _version, ...unversioned } = status;
    await expect(expectConforms("alias", JSON.stringify(unversioned))).rejects.toThrow();
    await expect(expectConforms("alias", JSON.stringify({ ...status, schemaVersion: 2 }))).rejects.toThrow();
    await expect(expectConforms("alias", JSON.stringify({ ...status, extra: 1 }))).rejects.toThrow();
    const { installed: _, ...missing } = status;
    await expect(expectConforms("alias", JSON.stringify(missing))).rejects.toThrow();
    await expect(expectConforms("alias", `${JSON.stringify(status)}\n${JSON.stringify(status)}`)).rejects.toThrow();
  });

  /**
   * A planted defect: delete alias.test.ts's real `expectConforms("alias", …)` calls and the scan must lose
   * `alias`. If anything else still counted for it — this file's own hand-built lines, say — the coverage
   * gate would pass with no real run of the command behind it.
   */
  test("the coverage scan loses a command whose real conformance calls are gone", () => {
    const aliasTest = join(SRC, "commands", "alias.test.ts");
    const real = readSource(aliasTest) ?? "";
    expect(real).toContain('expectConforms("alias"');
    expect(conformedPaths()).toContain("alias");
    const gutted = real.replaceAll('expectConforms("alias"', "expectNothing(");
    expect(conformedPaths(new Map([[aliasTest, gutted]]))).not.toContain("alias");
  });

  test("the payload subtrees published open are the known ones, and no more", () => {
    const open: string[] = [];
    for (const node of runnable) {
      const payload = contractOf(node.cmd)?.payload;
      if (payload === undefined) continue;
      open.push(...undeclaredKeys(z.toJSONSchema(payload, { io: "input" })).map((at) => `${pathOf(node)}: ${at}`));
    }
    expect([...new Set(open)].sort()).toEqual(OPEN_SUBTREES);
  });

  /** A planted defect: the open-subtree scan sees a loose object and a record, and passes a declared one. */
  test("the open-subtree scan sees an object that passes keys it does not name", () => {
    const planted = z
      .object({
        declared: z.object({ a: z.string().describe("A.") }).describe("Declared."),
        loose: z.looseObject({}).describe("Loose."),
        bag: z.record(z.string(), z.unknown()).describe("A bag."),
      })
      .describe("Planted.");
    expect(undeclaredKeys(z.toJSONSchema(planted, { io: "input" }))).toEqual(["$.loose", "$.bag"]);
  });

  /** A planted defect: the scan above has to be able to see a missing description, or it proves nothing. */
  test("the description scan sees a field nobody described", () => {
    const planted = z.object({ named: z.string().describe("Named."), bare: z.string() }).describe("Planted.");
    expect(undescribed(z.toJSONSchema(planted))).toEqual(["$.bare"]);
  });
});
