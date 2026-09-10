// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { secretWriteTargets } from "@pithy-sh/secrets/src/cli/writeTargets";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import {
  defineSecretRegistry,
  isProvisionableSecret,
  type SecretRegistry,
  type SecretRegistryEntry,
} from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeReport } from "../commands/provision";
import { checkSecretBindings, describeSecretBindings } from "../doctor/secretBindings";
import type { ProvisionReport } from "./environment";
import {
  removedStoreEntryNote,
  storeEntryRemedy,
  supplyStoreEntriesRemedy,
  supplyStoreEntryCommand,
} from "./secretEntryRemedy";

/**
 * # Two commands, one project, one answer (#517)
 *
 * `pithy provision` reports a missing `cf-secrets-store` entry as it writes each Worker's stanza;
 * `pithy doctor` reports the same finding afterwards from the files. A reviewer ran both to completion on
 * one project and found doctor's remedy corrected and provisioning's still naming the dead end four
 * rounds of this issue had been about — because each report rendered the sentence itself.
 *
 * Giving them one **renderer** was the first fix and was not enough. `supplyStoreEntriesRemedy` is the
 * sentence for a value only the operator holds; there is a second answer, `pithy secrets provision`, for
 * every entry the kit composes a value for, and provisioning never asked which it was. It called the
 * supplied-value renderer for every unbound secret — including the master key, whose `pithy secrets
 * create` is refused outright by `assertNotTheMasterKey`, and which is exactly the entry `pithy provision`
 * leaves unbound because `ensureMasterKey` belongs to the other command. **Sharing a renderer is not
 * sharing an answer**, and it slipped through precisely where the two were not compared.
 *
 * So the sentence has one owner — `storeEntryRemedy` — and this file holds both reports to it **over
 * every cell**, not only over the supplied ones the first comparison happened to cover. Every case below
 * runs both renderers over one registry and compares what they printed; nothing here asserts a wording
 * that only one of them has to satisfy.
 */

const PROJECT = "replay";
const ENVIRONMENTS = ["staging", "prod"] as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secret-remedy-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A `text` entry the kit can mint: a random recipe, so `devValue` and `origin` agree by construction. */
const minted = {
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } as const },
  rotation: { kind: "local" },
  devValue: "random",
} as const;

/**
 * **One registry per cell of #517's truth table that takes a `secrets_store_secrets` binding** — every
 * `(scope × origin)` combination, each holding exactly one secret.
 *
 * One secret per registry on purpose: the two reports legitimately *group* differently — doctor gathers a
 * Worker-and-environment's secrets into one line so an adopter counts lines, and provisioning prints one
 * line per binding as it settles — so a registry with one secret is where a second answer has nowhere to
 * hide, and the whole sentence can be compared byte for byte.
 *
 * The `d1` and keyed rows are not here: `boundSecretNames` is the predicate, and neither takes a binding.
 */
const REGISTRIES: Record<string, SecretRegistry> = {
  "environment-scoped, supplied": defineSecretRegistry({
    CFS_ENV_SUPPLIED: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
  }) as SecretRegistry,
  "global, supplied": defineSecretRegistry({
    CFS_GLOBAL_SUPPLIED: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  }) as SecretRegistry,
  "environment-scoped, adopter bootstrap": defineSecretRegistry({
    CFS_ENV_BOOTSTRAP: {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      bootstrap: true,
    },
  }) as SecretRegistry,
  "global, adopter bootstrap": defineSecretRegistry({
    CFS_GLOBAL_BOOTSTRAP: {
      backend: "cf-secrets-store",
      scope: "global",
      rotatable: false,
      valueType: "text",
      bootstrap: true,
    },
  }) as SecretRegistry,
  // The two cells the first comparison never covered, and the reason it did not catch this: both are
  // answered by `pithy secrets provision`, and only doctor was asking.
  "environment-scoped, mintable": defineSecretRegistry({
    CFS_ENV_MINT: { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text", ...minted },
  }) as SecretRegistry,
  "global, mintable": defineSecretRegistry({
    CFS_GLOBAL_MINT: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text", ...minted },
  }) as SecretRegistry,
  /**
   * **The master key, which is the cell that makes this a defect rather than an inconsistency.**
   *
   * `pithy provision` never creates it — `ensureMasterKey` runs inside `pithy secrets provision` — so it
   * is the entry a bare `pithy provision` most reliably reports unbound, on the commonest project there
   * is. The sentence it used to get named `pithy secrets create SECRETS_ENCRYPTION_KEYS`, which
   * `assertNotTheMasterKey` refuses in every mode.
   */
  "the master key": defineSecretRegistry({
    [MASTER_KEY_BINDING]: {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      bootstrap: true,
    },
  }) as SecretRegistry,
};

/** Every cell at once — what a real project looks like, and what the command sets are compared over. */
const EVERY_CELL: SecretRegistry = defineSecretRegistry(
  Object.assign({}, ...Object.values(REGISTRIES)) as SecretRegistry,
) as SecretRegistry;

/** A Worker under `apps/board` whose declared stanzas bind nothing. */
async function bareWorker(registry: SecretRegistry): Promise<{ name: string; dir: string; registry: SecretRegistry }> {
  const workerDir = join(dir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    JSON.stringify({ name: "replay-board", env: Object.fromEntries(ENVIRONMENTS.map((env) => [env, {}])) }, null, 2),
  );
  return { name: "board", dir: workerDir, registry };
}

/** What `pithy doctor` prints for that project. */
async function doctorLines(registry: SecretRegistry): Promise<string[]> {
  const check = await checkSecretBindings({
    projectDir: dir,
    targets: [await bareWorker(registry)],
    environments: ENVIRONMENTS,
    project: PROJECT,
  });
  if (!check) throw new Error("no check");
  return describeSecretBindings(check);
}

/**
 * What `pithy provision --env <env>` prints for the same project — the real `writeReport`, over a report
 * whose `secretBindings` is the shape `provisionEnvironment` produces for an entry that does not exist.
 *
 * Every entry is unbound, which is the state a run reaches for a supplied secret every time and for a
 * provisionable one whenever the entry is not there yet — the master key on every `pithy provision`,
 * since the command that mints it is `pithy secrets provision`.
 */
function provisionLines(registry: SecretRegistry, env: string): string[] {
  const scope = environmentScope(PROJECT, env);
  const report: ProvisionReport = {
    env,
    manifestFaults: [],
    resources: [],
    workers: [],
    services: [],
    secretBindings: Object.entries(registry).map(([binding, entry]) => ({
      binding,
      entry: scope.secretEntry(binding, entry.scope),
      bound: false,
      minted: false,
    })),
    declined: [],
    configs: [],
    committed: true,
  };
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    writeReport(report, { json: false, seeded: false, pending: { names: [], remedy: null }, registry });
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("").trimEnd().split("\n");
}

/** Every `pithy secrets …` command a set of lines names, de-duplicated and sorted. */
function commands(lines: readonly string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/pithy secrets (?:create [\w-]+(?: --env [\w-]+)?|provision)/g))
      found.add(match[0]);
  }
  return [...found].sort();
}

/**
 * The remedy **sentence** each line carries — everything from `Run` on, which is the part
 * `storeEntryRemedy` owns. The head before it is each report's own subject and legitimately differs;
 * this is the half that must be byte-identical, and comparing the commands alone would let a second
 * renderer that happens to name the same commands pass.
 */
function remedies(lines: readonly string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    const at = line.indexOf("Run pithy secrets ");
    if (at >= 0) found.add(line.slice(at));
  }
  return [...found].sort();
}

describe("both reports answer the same way, for every cell", () => {
  test.each(Object.keys(REGISTRIES))("%s — the same commands", async (label) => {
    const registry = REGISTRIES[label] as SecretRegistry;
    const doctor = commands(await doctorLines(registry));
    // Provisioning reports one environment at a time, so the project's answer is the union of its runs —
    // which is what doctor prints in one pass.
    const provision = commands(ENVIRONMENTS.flatMap((env) => provisionLines(registry, env)));

    expect(doctor.length).toBeGreaterThan(0);
    expect(provision).toEqual(doctor);
  });

  /**
   * **And the sentence itself, byte for byte, for every cell.**
   *
   * Comparing the command alone would pass for two renderers that happened to name it identically, which
   * is most of how the two drifted. Every registry above holds one secret, so the two reports group the
   * same way and the whole remedy is comparable — which is what turns *both name a command* into *both
   * give the same answer*.
   */
  test.each(Object.keys(REGISTRIES))("%s — the sentence is byte-identical", async (label) => {
    const registry = REGISTRIES[label] as SecretRegistry;
    const doctorRemedies = remedies(await doctorLines(registry));
    expect(doctorRemedies.length).toBeGreaterThan(0);
    expect(remedies(ENVIRONMENTS.flatMap((env) => provisionLines(registry, env)))).toEqual(doctorRemedies);
  });

  /** And over a project holding every cell at once, which is the only shape an adopter ever has. */
  test("every cell at once, in one project", async () => {
    expect(commands(ENVIRONMENTS.flatMap((env) => provisionLines(EVERY_CELL, env)))).toEqual(
      commands(await doctorLines(EVERY_CELL)),
    );
  });

  /**
   * **A provisionable entry is never told to hand-write its own value.**
   *
   * The half a shared renderer cannot enforce, stated positively so it is not only true by comparison:
   * `isProvisionableSecret` decides, and an entry it says yes to gets the one command that creates it.
   * The master key is the cell that matters — `pithy provision` leaves it unbound on every run, and
   * `pithy secrets create SECRETS_ENCRYPTION_KEYS` is refused before a value is even asked for.
   */
  test.each(["environment-scoped, mintable", "global, mintable", "the master key"])(
    "%s — both reports name provision, and neither names create",
    async (label) => {
      const registry = REGISTRIES[label] as SecretRegistry;
      const binding = Object.keys(registry)[0] as string;
      expect(isProvisionableSecret(binding, registry[binding] as SecretRegistryEntry)).toBe(true);

      for (const lines of [await doctorLines(registry), ...ENVIRONMENTS.map((env) => provisionLines(registry, env))]) {
        expect(commands(lines)).toEqual(["pithy secrets provision"]);
      }
    },
  );

  /**
   * The mirror: a value only the operator holds is never answered with `pithy secrets provision` alone,
   * because provisioning has nothing to compose for it and the complaint would come back unchanged.
   */
  test.each([
    "environment-scoped, supplied",
    "global, supplied",
    "environment-scoped, adopter bootstrap",
    "global, adopter bootstrap",
  ])("%s — both reports name a create first", async (label) => {
    const registry = REGISTRIES[label] as SecretRegistry;
    const binding = Object.keys(registry)[0] as string;
    expect(isProvisionableSecret(binding, registry[binding] as SecretRegistryEntry)).toBe(false);

    for (const lines of [await doctorLines(registry), ...ENVIRONMENTS.map((env) => provisionLines(registry, env))]) {
      const named = commands(lines);
      expect(named.some((command) => command.startsWith(`pithy secrets create ${binding}`))).toBe(true);
      // And the provision that writes the stanza, which is the second half and never the whole answer.
      expect(named).toContain("pithy secrets provision");
    }
  });

  /**
   * **And every command either report names is one the write rule accepts.**
   *
   * The third attempt on #517 printed `--env` on a `global` secret, which `secretWriteTargets` refuses:
   * an operator following the line got a refusal rather than a write. Parsed back out of the printed
   * lines, so a flag added to a sentence is checked against the rule that governs it.
   */
  test.each(Object.keys(REGISTRIES))("%s — the write rule accepts every command printed", async (label) => {
    const registry = REGISTRIES[label] as SecretRegistry;
    const printed = commands(await doctorLines(registry));
    expect(printed.length).toBeGreaterThan(0);
    for (const command of printed) {
      // `pithy secrets provision` takes no secret and no `--env`; the rule is about the write commands.
      if (command === "pithy secrets provision") continue;
      const [, , , name, , env] = command.split(" ");
      const entry = registry[name as string];
      if (!entry) throw new Error(`${command} names no declared secret`);
      expect(() =>
        secretWriteTargets({
          name: name as string,
          backend: entry.backend,
          scope: entry.scope,
          mode: "create",
          requested: env,
          declared: [...ENVIRONMENTS],
        }),
      ).not.toThrow();
    }
  });
});

/**
 * **The one function both reports ask, in isolation.** Which of the two answers an entry gets is
 * `isProvisionableSecret`'s decision, carried on the entry — never re-derived by a caller, which is what
 * let two reports carrying the same renderer give two answers.
 */
describe("storeEntryRemedy", () => {
  test("a value the kit composes is answered with the one command that composes it", () => {
    expect(storeEntryRemedy([{ binding: "FOO", scope: "environment", env: "staging", provisionable: true }])).toBe(
      "Run pithy secrets provision — it creates the store entries and writes the stanza.",
    );
  });

  test("a value only the operator holds is answered with the create that supplies it", () => {
    expect(storeEntryRemedy([{ binding: "FOO", scope: "environment", env: "staging", provisionable: false }])).toBe(
      "Run pithy secrets create FOO --env staging to supply its value, then pithy secrets provision to write the stanza.",
    );
  });

  /**
   * A group holding both — which doctor's own grouping never produces, since it splits on this axis
   * first — reads as the supplied sentence, and is still right: that sentence ends by naming the
   * provision the composable half needs anyway.
   */
  test("a mixed group names the create it needs and the provision they share", () => {
    expect(
      storeEntryRemedy([
        { binding: "FOO", scope: "environment", env: "staging", provisionable: true },
        { binding: "BAR", scope: "environment", env: "staging", provisionable: false },
      ]),
    ).toBe(
      "Run pithy secrets create BAR --env staging to supply its value, then pithy secrets provision to write the stanza.",
    );
  });
});

describe("supplyStoreEntryCommand", () => {
  test("an environment-scoped secret carries the --env its entry belongs to", () => {
    expect(
      supplyStoreEntryCommand({ binding: "FOO", scope: "environment", env: "staging", provisionable: false }),
    ).toBe("pithy secrets create FOO --env staging");
  });

  /** A global secret is one entry every environment binds, and the write rule refuses to narrow it. */
  test("a global secret carries no --env at all", () => {
    expect(supplyStoreEntryCommand({ binding: "FOO", scope: "global", env: "staging", provisionable: false })).toBe(
      "pithy secrets create FOO",
    );
  });
});

describe("supplyStoreEntriesRemedy", () => {
  test("one entry reads in the singular, and names both acts", () => {
    expect(
      supplyStoreEntriesRemedy([{ binding: "FOO", scope: "environment", env: "staging", provisionable: false }]),
    ).toBe(
      "Run pithy secrets create FOO --env staging to supply its value, then pithy secrets provision to write the stanza.",
    );
  });

  /**
   * One `global` entry short in three stanzas is **one** command. Printing it per environment asks an
   * operator to run the same thing three times, which is the dead end a remedy that only works once is.
   */
  test("a global entry short in every stanza is one command and one provision", () => {
    expect(
      supplyStoreEntriesRemedy([
        { binding: "FOO", scope: "global", env: "staging", provisionable: false },
        { binding: "FOO", scope: "global", env: "prod", provisionable: false },
      ]),
    ).toBe("Run pithy secrets create FOO to supply its value, then pithy secrets provision to write every stanza.");
  });

  test("several entries in one stanza are several commands and one provision", () => {
    expect(
      supplyStoreEntriesRemedy([
        { binding: "FOO", scope: "environment", env: "staging", provisionable: false },
        { binding: "BAR", scope: "environment", env: "staging", provisionable: false },
      ]),
    ).toBe(
      "Run pithy secrets create FOO --env staging, pithy secrets create BAR --env staging to supply their values, then pithy secrets provision to write the stanza.",
    );
  });
});

/**
 * **The half `rm` cannot do, said rather than left to be found.**
 *
 * `applySecretBindings` only ever adds, so nothing in the kit takes a `secrets_store_secrets` line out.
 * Wrangler refuses a config naming an absent entry, so the next deploy of that Worker fails on it.
 */
describe("removedStoreEntryNote", () => {
  test("names the binding and every stanza that still carries it", () => {
    expect(removedStoreEntryNote("CFS_ENV_SUPPLIED", ["staging"])).toBe(
      "The store entry is gone. Each Worker's wrangler.jsonc still binds CFS_ENV_SUPPLIED under env.staging — remove that entry, or the next deploy of it fails.",
    );
    expect(removedStoreEntryNote("CFS_GLOBAL_SUPPLIED", [...ENVIRONMENTS])).toContain("env.staging, env.prod");
  });
});
