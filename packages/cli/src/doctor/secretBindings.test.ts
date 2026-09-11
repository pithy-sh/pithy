// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import {
  backendRoutedDispatcher,
  type PreflightSecretDispatcher,
  type SecretWriteRequest,
} from "@pithy-sh/secrets/src/cli/dispatch";
import { secretWriteTargets } from "@pithy-sh/secrets/src/cli/writeTargets";
import type { VersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { runWriteSecret } from "@pithy-sh/secrets/src/management/writeSecret";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import {
  defineSecretRegistry,
  isProvisionableSecret,
  type SecretRegistry,
  type SecretRegistryEntry,
} from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { RotationTracker } from "@pithy-sh/secrets/src/store/rotationTracker";
import type { SystemSecretsStore } from "@pithy-sh/secrets/src/store/systemSecretsStore";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SecretApplicability } from "../capabilities/secretApplicability";
import { runSecretWrite } from "../capabilities/secrets";
import { storeSecretWriter } from "../capabilities/storeSecretWrites";
import type { DevSecretsTarget } from "../devSecrets/targets";
import { secretsStoreBindings } from "../provision/secretBindings";
import type { SecretsStore } from "../provision/store";
import { applySecretBindings } from "../provision/wranglerEnv";
import { checkSecretBindings, describeSecretBindings } from "./secretBindings";

const PROJECT = "replay";
const ENVIRONMENTS = ["staging", "prod"] as const;
/** The account's one Secrets Store id — the `store_id` every `secrets_store_secrets` entry carries. */
const STORE_ID = "store-1";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secret-bindings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * # #517's truth table, as the fixture the whole file runs against.
 *
 * Four attempts at this line each corrected the command it named and stopped one layer short of asking
 * whether that command *works* for the shape it was named for. The answer to that is not derivable by
 * reading: it depends on `SecretWriteRequest` carrying no `backend`, on `secretsStoreBindings` gating
 * `mint` on `isMintableSecret`, and on `ensureMasterKey` creating exactly one entry. So the space is
 * enumerated here — every (backend × scope × origin × keyed) combination a registry can hold — and every
 * cell's answer is established below by **running the remedy and re-reading the report**, never by
 * asserting a sentence.
 *
 * `origin` is the axis the previous rounds kept mis-reading, and it has four values, not two:
 *
 * - **mintable** — `devValue`, a random recipe. `secretsStoreBindings`' `mint` callback creates it.
 * - **master key** — `SECRETS_ENCRYPTION_KEYS`. `bootstrap`, so *not* mintable, and `ensureMasterKey`
 *   creates it anyway, a step ahead of the binding pass. This is the cell round 1 got wrong.
 * - **adopter bootstrap** — `bootstrap: true` under any other name. `defineSecretRegistry` accepts it and
 *   nothing creates it. This is the cell round 2 got wrong.
 * - **supplied** — neither. An OAuth client secret, a payment rail's key. Nothing creates it.
 *
 * The last two were the dead ends: `pithy secrets create` accepted them, exited 0, and wrote a D1 row, so
 * the store entry stayed absent and the complaint came back byte-identical. That is fixed here — a write
 * request carries its `backend` and `backendRoutedDispatcher` sends a store write to the store — so those
 * four cells have a command again, and the block below establishes it by **running** the command and
 * re-reading the report.
 */
interface Cell {
  /** The row number in #517's truth table, so a failure here points at the evidence that established it. */
  row: number;
  /** The registry key, which is also the Worker binding name. */
  binding: string;
  /** The entry, declared through the real `defineSecretRegistry` below. */
  entry: SecretRegistryEntry;
  /**
   * **Does the Secret bindings block report this shape at all?** Only a non-keyed `cf-secrets-store`
   * secret takes a `secrets_store_secrets` binding — `boundSecretNames` is the predicate — so the `d1`
   * and keyed rows are the truth table's `n/a` column and must never appear.
   */
  reported: boolean;
  /**
   * What actually creates this cell's store entry, established by running it.
   *
   * - `"provision"` — `pithy secrets provision`, through `mint` or `ensureMasterKey`.
   * - `"create"` — `pithy secrets create`, with the value the operator holds.
   * - `null` — the cell is not reported here at all.
   */
  creates: "provision" | "create" | null;
  /**
   * **Where a `pithy secrets create` of this cell must put the value.** The one assertion every previous
   * test on this surface did not make.
   *
   * `null` for a cell the command refuses outright — a keyspace, or the master key.
   */
  lands: "store" | "d1" | null;
}

/** A `text` entry the kit can mint: a random recipe, so `devValue` and `origin` agree by construction. */
const minted = {
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } as const },
  rotation: { kind: "local" },
  devValue: "random",
} as const;

const TRUTH_TABLE: Cell[] = [
  // Rows 1–5: `d1` and keyed. Rows in a database, or a keyspace with no single value — never a binding.
  {
    row: 1,
    binding: "D1_ENV_MINT",
    entry: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", ...minted },
    reported: false,
    creates: null,
    lands: "d1",
  },
  {
    row: 2,
    binding: "D1_ENV_SUPPLIED",
    entry: { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    reported: false,
    creates: null,
    lands: "d1",
  },
  {
    row: 3,
    binding: "D1_GLOBAL_MINT",
    entry: { backend: "d1", scope: "global", rotatable: true, valueType: "text", ...minted },
    reported: false,
    creates: null,
    lands: "d1",
  },
  {
    row: 4,
    binding: "D1_GLOBAL_SUPPLIED",
    entry: { backend: "d1", scope: "global", rotatable: false, valueType: "text" },
    reported: false,
    creates: null,
    lands: "d1",
  },
  {
    row: 5,
    binding: "D1_ENV_KEYED",
    entry: { backend: "d1", scope: "environment", rotatable: false, valueType: "text", keyed: true },
    reported: false,
    creates: null,
    lands: null,
  },
  // Rows 6–8: the store entries `pithy secrets provision` composes a value for.
  {
    row: 6,
    binding: "CFS_ENV_MINT",
    entry: { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text", ...minted },
    reported: true,
    creates: "provision",
    lands: "store",
  },
  {
    row: 7,
    binding: "CFS_GLOBAL_MINT",
    entry: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text", ...minted },
    reported: true,
    creates: "provision",
    lands: "store",
  },
  {
    row: 8,
    binding: MASTER_KEY_BINDING,
    entry: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text", bootstrap: true },
    reported: true,
    creates: "provision",
    lands: null,
  },
  // Rows 9–12: the store entries only the operator holds a value for. `pithy secrets create` writes each.
  {
    row: 9,
    binding: "CFS_ENV_BOOTSTRAP",
    entry: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text", bootstrap: true },
    reported: true,
    creates: "create",
    lands: "store",
  },
  {
    row: 10,
    binding: "CFS_GLOBAL_BOOTSTRAP",
    entry: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text", bootstrap: true },
    reported: true,
    creates: "create",
    lands: "store",
  },
  {
    row: 11,
    binding: "CFS_ENV_SUPPLIED",
    entry: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
    reported: true,
    creates: "create",
    lands: "store",
  },
  {
    row: 12,
    binding: "CFS_GLOBAL_SUPPLIED",
    entry: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    reported: true,
    creates: "create",
    lands: "store",
  },
];

/**
 * The whole table as one registry, declared through the real {@link defineSecretRegistry} — so a cell
 * this file claims is reachable is one the author-time rules actually accept.
 */
const REGISTRY: SecretRegistry = defineSecretRegistry(
  Object.fromEntries(TRUTH_TABLE.map((cell) => [cell.binding, cell.entry])) as SecretRegistry,
);

/** The cells the Secret bindings block is about. */
const REPORTED = TRUTH_TABLE.filter((cell) => cell.reported);

/** One Worker under `apps/<name>`, with the env stanzas its `wrangler.jsonc` declares. */
async function worker(name: string, env: Record<string, unknown>): Promise<DevSecretsTarget> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `replay-${name}`, env }, null, 2));
  return { name, dir: workerDir, registry: REGISTRY };
}

/** A Worker binding nothing in any declared environment — the state every case below starts from. */
async function bareWorker(registry: SecretRegistry = REGISTRY): Promise<DevSecretsTarget> {
  const target = await worker("board", Object.fromEntries(ENVIRONMENTS.map((env) => [env, {}])));
  return { ...target, registry };
}

/**
 * One name out of reach, said both ways: project-wide, and for the Worker named. A single-Worker project's
 * applicability looks exactly like this, because with one Worker the two answers cannot differ.
 */
function applicabilityFor(name: string, reason: string, worker = "board"): SecretApplicability {
  const map = new Map([[name, reason]]);
  return { project: map, byWorker: new Map([[worker, map]]) };
}

/** The report for one Worker, as `pithy doctor` prints it. */
async function report(target: DevSecretsTarget): Promise<string[]> {
  const check = await checkSecretBindings({
    projectDir: dir,
    targets: [target],
    environments: ENVIRONMENTS,
    project: PROJECT,
  });
  if (!check) throw new Error("no check");
  return describeSecretBindings(check);
}

/** Every line of a report that names one binding. */
function linesFor(lines: string[], binding: string): string[] {
  return lines.filter((line) => new RegExp(`\\b${binding}\\b`).test(line));
}

// ---------------------------------------------------------------------------------------------------
// The account, and the commands that write to it. The Cloudflare account is the one stand-in; every
// decision about *where a value lands* is taken by kit code running over it.
//
// **Two destinations, both recording, and every case below asserts which one received the value.** That
// is the standard four rounds of #517 failed: each previous test on this surface asserted that a command
// exited without throwing, which was true of a `pithy secrets create` that wrote an encrypted D1 row
// nothing reads and of a `pithy secrets rm` that reported a revocation it never performed.
// ---------------------------------------------------------------------------------------------------

/** The account's one Secrets Store, entry name to stored payload. The value is kept so a test can find it. */
type Store = Map<string, string>;

/**
 * Every environment's secrets D1 at once, keyed `<env>/<name>`.
 *
 * One map with the environment in the key rather than one map per environment, because that is what makes
 * a fan-out visible: a `global` `d1` secret is written once per environment, and a single flat map would
 * report the second write as a name already taken. The key is also the assertion — *which* database holds
 * it is half of "where did the value land".
 */
type Rows = Map<string, VersionedValue>;

/** Both destinations, so one object can be handed to a command and then asked where the value went. */
interface Account {
  store: Store;
  rows: Rows;
}

/** A fresh account: an empty Secrets Store and an empty manager database. */
function account(): Account {
  return { store: new Map(), rows: new Map() };
}

/** The `SecretsStore` seam over the recording store — the same one `pithy provision` is handed. */
function secretsStore(store: Store): SecretsStore {
  return {
    storeId: STORE_ID,
    exists: async (name) => store.has(name),
    put: async (name, value) => {
      store.set(name, value);
    },
    remove: async (name) => store.delete(name),
  };
}

/** One environment's `SystemSecretsStore`-shaped D1 — the destination a manager-dispatched write reaches. */
function d1(rows: Rows, env: string): SystemSecretsStore {
  const key = (name: string) => `${env}/${name}`;
  return {
    has: async (name: string) => rows.has(key(name)),
    put: async (name: string, value: VersionedValue) => {
      rows.set(key(name), value);
    },
    delete: async (name: string) => {
      rows.delete(key(name));
    },
  } as unknown as SystemSecretsStore;
}

/** No rotation history, and none recorded. The ledger is not what this file is about. */
const tracker = {
  getLatestSuccess: async () => null,
  recordBaseline: async () => {},
  purgeHistory: async () => {},
} as unknown as RotationTracker;

/**
 * **The whole write path of `pithy secrets create|update|rm`, from the CLI's brain to both destinations.**
 *
 * `runSecretWrite` is the command body, `dispatchSecretWrite` applies the real `secretWriteTargets` rule,
 * `backendRoutedDispatcher` is the real router, and each half is the real writer: `storeSecretWriter`
 * against the account's Secrets Store, and `runWriteSecret` — the manager Workflow's own core — against
 * the environment's D1. Nothing in this file decides where a value goes.
 *
 * Returns every request the router saw, so a case can assert the backend the CLI resolved as well as the
 * destination that received the value.
 */
async function pithySecrets(
  where: Account,
  mode: "create" | "update" | "delete",
  name: string,
  env: string | undefined,
  value?: string,
): Promise<SecretWriteRequest[]> {
  const seen: SecretWriteRequest[] = [];
  const manager: PreflightSecretDispatcher = {
    // The real manager's pre-flight is a `probe` of this same store, and this file is about *where* a
    // value lands rather than about the ordering a rotation depends on — which `rotationPreflight.test.ts`
    // drives through the real dispatcher. Nothing here rotates, so there is nothing to refuse in front of.
    preflight: async () => {},
    dispatch: async (request) => {
      await runWriteSecret({ store: d1(where.rows, request.env), tracker }, {
        mode: request.mode,
        name: request.name,
        value: request.value ?? "",
        valueType: request.valueType ?? "text",
        rotatable: request.rotatable ?? false,
      } as Parameters<typeof runWriteSecret>[1]);
    },
  };
  const routed = backendRoutedDispatcher({
    d1: manager,
    "cf-secrets-store": storeSecretWriter({
      store: async () => secretsStore(where.store),
      // Provisioning's own namer, which is the point: a value has to land at the address
      // `secretsStoreBindings` later asks the store for.
      scope: (target) => environmentScope(PROJECT, target),
    }),
  });
  await runSecretWrite(
    REGISTRY,
    {
      dispatch: async (request) => {
        seen.push(request);
        await routed.dispatch(request);
      },
    },
    { mode, name, value, env: env as ManagedEnvironment | undefined, environments: [...ENVIRONMENTS] },
  );
  return seen;
}

/**
 * **`pithy secrets provision`, in the two steps that create a store entry.**
 *
 * `ensureMasterKey` first, per environment — it composes {@link masterKeySecretName} and writes it when
 * absent, which is the step ahead of the binding pass that makes the master key provisionable while not
 * being mintable. Then the real `secretsStoreBindings` over each Worker and environment, with `exists`
 * reading the account and `mint` standing in for `storeSecretMinter` — the gate on *which* entries are
 * minted is `secretsStoreBindings`' own `isMintableSecret`, not this callback. Then the real
 * `applySecretBindings`, writing the stanza into the real `wrangler.jsonc`.
 *
 * Idempotent, like the command: a re-run mints nothing and rewrites the same stanza.
 */
async function pithySecretsProvision(where: Account, targets: readonly DevSecretsTarget[]): Promise<void> {
  for (const env of ENVIRONMENTS) where.store.set(masterKeySecretName(PROJECT, env), "master-key");
  for (const target of targets) {
    for (const env of ENVIRONMENTS) {
      const { bound } = await secretsStoreBindings({
        registry: target.registry as SecretRegistry,
        scope: environmentScope(PROJECT, env),
        storeId: STORE_ID,
        exists: async (name) => where.store.has(name),
        mint: async ({ secretName }) => {
          where.store.set(secretName, "minted");
        },
      });
      await applySecretBindings(target.dir, env, bound);
    }
  }
}

/**
 * **Run the commands a report line names, in the order it names them.**
 *
 * Parsed out of the line rather than composed here, so a line naming a command with the wrong flag — or
 * one that cannot do the job — fails rather than passing on something this file happened to know. This is
 * the whole apparatus behind *a line may name a command only if running that command clears the line*.
 */
async function runRemedy(line: string, where: Account, targets: readonly DevSecretsTarget[]): Promise<void> {
  for (const command of commandsIn(line)) {
    if (command.kind === "provision") {
      await pithySecretsProvision(where, targets);
      continue;
    }
    await pithySecrets(where, "create", command.name, command.env, `${command.name}-value-the-operator-holds`);
  }
}

/** Every remedy the whole report names, run in order. */
async function runEveryRemedy(target: DevSecretsTarget, where: Account): Promise<void> {
  for (const line of await report(target)) await runRemedy(line, where, [target]);
}

// ---------------------------------------------------------------------------------------------------

describe("the reported set is the truth table's, and nothing else", () => {
  test("only a non-keyed cf-secrets-store secret ever needs a binding", async () => {
    const lines = await report(await bareWorker());
    for (const cell of TRUTH_TABLE) {
      expect(linesFor(lines, cell.binding).length > 0, `row ${cell.row}: ${cell.binding}`).toBe(cell.reported);
    }
  });

  /**
   * The classification is the thing under test, so it is read from the registry through the shipped
   * predicate rather than restated, and the **check's own answer** is bound to it. A cell whose `creates`
   * disagrees with either is a wrong row or the defect coming back.
   *
   * Round 1 of #517 read `isMintableSecret` here, and the difference between the two predicates is
   * exactly `SECRETS_ENCRYPTION_KEYS` — `bootstrap`, so nothing may invent it, and `ensureMasterKey`
   * creates it anyway. It is also the only `cf-secrets-store` secret a stock Worker declares, so getting
   * it wrong is getting the commonest case wrong. Row 8 is that cell, and this fails on it alone.
   */
  test("each reported cell's remedy is the one isProvisionableSecret decides, and the check agrees", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker()],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    for (const cell of REPORTED) {
      expect(isProvisionableSecret(cell.binding, cell.entry), `row ${cell.row} predicate`).toBe(
        cell.creates === "provision",
      );
      const reported = (check?.missing ?? []).filter((entry) => entry.binding === cell.binding);
      expect(reported.length, `row ${cell.row} reported`).toBeGreaterThan(0);
      for (const entry of reported) {
        expect(entry.provisionable, `row ${cell.row} classification`).toBe(cell.creates === "provision");
      }
    }
  });

  /** The combinations `defineSecretRegistry` refuses, so the table above is the whole reachable space. */
  test.each([
    ["d1 + bootstrap", { backend: "d1", scope: "environment", rotatable: false, valueType: "text", bootstrap: true }],
    [
      "cf-secrets-store + keyed",
      { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text", keyed: true },
    ],
    ["keyed + global", { backend: "d1", scope: "global", rotatable: false, valueType: "text", keyed: true }],
    [
      "bootstrap + mintable",
      {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        valueType: "text",
        bootstrap: true,
        ...minted,
      },
    ],
    [
      "keyed + mintable",
      { backend: "d1", scope: "environment", rotatable: false, valueType: "text", keyed: true, ...minted },
    ],
  ])("%s is refused at declaration time, so it is not a cell", (_label, entry) => {
    expect(() => defineSecretRegistry({ REFUSED: entry as SecretRegistryEntry })).toThrow();
  });
});

/**
 * **The standard every previous round of #517 failed: a line may name a command only if running that
 * command makes the complaint go away.**
 *
 * One case per reported row of the truth table. Each renders the report, runs **the commands the line
 * itself names**, parsed back out of it — never composed here, so a line naming the wrong command or the
 * wrong flag fails rather than passing on something this file happened to know — and asserts the
 * complaint is gone. Reasoning about it instead is what produced the defect four times.
 */
describe("running the remedy a line names clears the complaint", () => {
  test.each(REPORTED.map((cell) => [`row ${cell.row}: ${cell.binding} (${cell.creates})`, cell] as const))(
    "%s",
    async (_label, cell) => {
      const target = await bareWorker();
      const where = account();
      const before = linesFor(await report(target), cell.binding);
      expect(before.length).toBeGreaterThan(0);

      for (const line of before) await runRemedy(line, where, [target]);

      expect(linesFor(await report(target), cell.binding)).toEqual([]);
    },
  );

  test("and the whole report goes quiet once every remedy has been run", async () => {
    const target = await bareWorker();
    const where = account();
    await runEveryRemedy(target, where);
    expect(await report(target)).toEqual([]);
  });

  /** Provisioning is idempotent by contract, so the cleared report survives a second run of it. */
  test("a second provision run changes nothing", async () => {
    const target = await bareWorker();
    const where = account();
    await runEveryRemedy(target, where);
    const stanzas = await readFile(join(target.dir, "wrangler.jsonc"), "utf8");
    await pithySecretsProvision(where, [target]);
    expect(await readFile(join(target.dir, "wrangler.jsonc"), "utf8")).toBe(stanzas);
    expect(await report(target)).toEqual([]);
  });
});

/**
 * **Where the value landed — the assertion four rounds of tests on this surface never made.**
 *
 * Every previous test here passed on an exit code. `pithy secrets create CFS_ENV_SUPPLIED --env prod`
 * exited 0 and wrote an encrypted D1 row nothing reads, because the dispatched request carried no
 * `backend` and the only writer downstream was the manager's. So this drives the real routed write path
 * over a recording Secrets Store and a recording D1 and asks the only question that matters: which one
 * received it.
 *
 * Table-driven over every `(backend × scope × origin)` cell, so a backend added later or a routing branch
 * dropped later is a failure in this table rather than a value in the wrong store.
 */
describe("a create puts the value in the store the registry names, and in no other", () => {
  const WRITABLE = TRUTH_TABLE.filter((cell) => cell.lands !== null);

  test.each(WRITABLE.map((cell) => [`row ${cell.row}: ${cell.binding} → ${cell.lands}`, cell] as const))(
    "%s",
    async (_label, cell) => {
      const where = account();
      // The flag the scope permits, and only that one: the write rule refuses `--env` on a `global`
      // secret and requires it on an `environment` one.
      const env = cell.entry.scope === "global" ? undefined : "prod";
      const dispatched = await pithySecrets(where, "create", cell.binding, env, "the-value-the-operator-holds");

      // The CLI resolved the backend from the registry and put it on the request. Without this the two
      // destinations below are indistinguishable to everything downstream.
      expect(dispatched.length).toBeGreaterThan(0);
      for (const request of dispatched) {
        expect(request.backend).toBe(cell.entry.backend);
        expect(request.scope).toBe(cell.entry.scope);
      }

      if (cell.lands === "store") {
        // The account entry, at the address provisioning will ask for — composed by the writer through
        // the same scope, never by this file.
        const entry = environmentScope(PROJECT, env ?? "prod").secretEntry(cell.binding, cell.entry.scope);
        expect([...where.store.keys()]).toEqual([entry]);
        // **The payload this secret's reader receives, which is not one shape for all of them** (#517).
        // An ordinary entry holds the envelope `decodeVersionedValue` reads; a `bootstrap` entry holds
        // the value, because it is read straight off its binding before the decoder's own key exists.
        // `storeEntryText` is the one place that decides, and `capabilities/storeSecretWrites.test.ts`
        // proves the bootstrap half by putting a real boot reader on the far end of a real write.
        expect(where.store.get(entry)).toBe(
          cell.entry.bootstrap === true
            ? "the-value-the-operator-holds"
            : JSON.stringify({ currentVersion: "1", versions: { "1": "the-value-the-operator-holds" } }),
        );
        // And nothing reached the database. A shadow row there is the defect, not a harmless extra.
        expect([...where.rows.keys()]).toEqual([]);
        return;
      }

      // A `d1` write reaches one row per target environment — one for an `environment` secret, every
      // declared one for a `global` secret, which is the fan-out `secretWriteTargets` decided.
      const written = cell.entry.scope === "global" ? [...ENVIRONMENTS] : [env as string];
      expect([...where.rows.keys()].sort()).toEqual(written.map((target) => `${target}/${cell.binding}`).sort());
      for (const target of written) {
        expect(where.rows.get(`${target}/${cell.binding}`)).toEqual({
          currentVersion: "1",
          versions: { "1": "the-value-the-operator-holds" },
        });
      }
      expect([...where.store.keys()]).toEqual([]);
    },
  );

  /**
   * **`rm` on a store-backed secret removes the entry the Worker actually reads.**
   *
   * `pithy secrets rm CFS_ENV_MINT --env staging` used to exit 0, print `removed from staging`, delete a
   * D1 shadow row, and leave the live Secrets Store entry present. An operator revoking a leaked
   * credential was told it was gone while the Worker kept reading it — the worst line this CLI can print.
   */
  test.each(
    TRUTH_TABLE.filter((cell) => cell.lands === "store").map(
      (cell) => [`row ${cell.row}: ${cell.binding}`, cell] as const,
    ),
  )("%s — rm deletes the store entry and nothing else", async (_label, cell) => {
    const where = account();
    const env = cell.entry.scope === "global" ? undefined : "staging";
    await pithySecrets(where, "create", cell.binding, env, "leaked");
    const entry = environmentScope(PROJECT, env ?? "prod").secretEntry(cell.binding, cell.entry.scope);
    expect(where.store.has(entry)).toBe(true);

    await pithySecrets(where, "delete", cell.binding, env);

    expect(where.store.has(entry)).toBe(false);
    // And it did not reach for the database on the way past, which is all the old path ever did.
    expect([...where.rows.keys()]).toEqual([]);
  });

  /** The mirror for `d1`: a row is removed, and the account's store is never touched. */
  test("rm on a d1 secret removes the row and leaves the store alone", async () => {
    const where = account();
    await pithySecrets(where, "create", "D1_ENV_SUPPLIED", "staging", "leaked");
    await pithySecrets(where, "delete", "D1_ENV_SUPPLIED", "staging");
    expect([...where.rows.keys()]).toEqual([]);
    expect([...where.store.keys()]).toEqual([]);
  });

  /**
   * **A create on a store-backed secret refuses an entry that is already there**, the same guard
   * `runWriteSecret` holds for a row. A second value under one name is how a live credential is replaced
   * by a typo.
   */
  test("create refuses a store entry that already exists, and update refuses one that does not", async () => {
    const where = account();
    await pithySecrets(where, "create", "CFS_ENV_SUPPLIED", "staging", "first");
    await expect(pithySecrets(where, "create", "CFS_ENV_SUPPLIED", "staging", "second")).rejects.toThrow(
      /already exists/,
    );
    await expect(pithySecrets(where, "update", "CFS_ENV_BOOTSTRAP", "staging", "value")).rejects.toThrow(
      /does not exist/,
    );
    // The first value is still the one in the account.
    const entry = environmentScope(PROJECT, "staging").secretEntry("CFS_ENV_SUPPLIED", "environment");
    expect(JSON.parse(where.store.get(entry) as string).versions["1"]).toBe("first");
  });

  /**
   * **The master key is refused in every mode**, and row 8 is why it has no `lands`.
   *
   * `create` and `update` would replace the `EncryptionConfig` every other secret in that environment is
   * sealed under, orphaning each one; `rm` deletes it, which is the same loss with nothing to put back.
   * Before the write path knew its backend the damage was quieter and no smaller: a master-key-shaped
   * value was written as a versioned envelope into the very D1 the master key opens.
   */
  test.each(["create", "update", "delete"] as const)(
    "%s of the master key is refused, and writes nothing",
    async (mode) => {
      const where = account();
      await expect(pithySecrets(where, mode, MASTER_KEY_BINDING, "staging", "mine")).rejects.toThrow(
        /master key every other secret is sealed under/,
      );
      expect([...where.store.keys()]).toEqual([]);
      expect([...where.rows.keys()]).toEqual([]);
    },
  );
});

/**
 * **The entry a report names is the one a write lands in and the one provisioning asks for.**
 *
 * Three producers of one address: `checkSecretBindings` composes it for the report, `storeSecretWriter`
 * composes it for the write, and `secretsStoreBindings` composes it for the lookup. A one-character drift
 * between any two is an operator who does the work and gets the same complaint — the failure mode this
 * whole file exists to prevent, arriving through the name instead of through the command.
 */
describe("the entry name is one address, whoever composes it", () => {
  test("every reported cell's entry is what environmentScope composes", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker()],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    for (const entry of check?.missing ?? []) {
      expect(entry.entry).toBe(environmentScope(PROJECT, entry.env).secretEntry(entry.binding, entry.scope));
    }
  });

  /** The master key's entry has a second, older namer, and the two must not have drifted. */
  test("the master key's entry is masterKeySecretName's", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker()],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    const master = (check?.missing ?? []).filter((entry) => entry.binding === MASTER_KEY_BINDING);
    expect(master.length).toBe(ENVIRONMENTS.length);
    for (const entry of master) expect(entry.entry).toBe(masterKeySecretName(PROJECT, entry.env));
  });

  /** A `global` secret resolves to one account-level entry, whichever environment is asking. */
  test("a global secret names one entry across every environment", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker()],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    const named = (check?.missing ?? []).filter((entry) => entry.binding === "CFS_GLOBAL_SUPPLIED");
    expect(new Set(named.map((entry) => entry.entry))).toEqual(new Set(["replay-global-cfs-global-supplied"]));
  });

  /** And an environment-scoped one names an entry per stanza, because that is how many there are. */
  test("an environment-scoped secret names an entry per environment", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker()],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    const named = (check?.missing ?? []).filter((entry) => entry.binding === "CFS_ENV_SUPPLIED");
    expect(named.map((entry) => entry.entry).sort()).toEqual([
      "replay-prod-cfs-env-supplied",
      "replay-staging-cfs-env-supplied",
    ]);
  });

  /**
   * **And a write lands at that exact address**, which is the half no report can establish on its own.
   * The report and the writer compose the name through the same scope; this is the run that proves it,
   * because a correct sentence pointing at an entry nothing writes is the dead end in a new costume.
   */
  test("what pithy secrets create writes is what the report named", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker()],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    for (const cell of REPORTED.filter((candidate) => candidate.creates === "create")) {
      const where = account();
      const env = cell.entry.scope === "global" ? undefined : "prod";
      await pithySecrets(where, "create", cell.binding, env, "value");
      const reported = (check?.missing ?? []).filter(
        (entry) => entry.binding === cell.binding && (env === undefined || entry.env === env),
      );
      expect(reported.length, `row ${cell.row}`).toBeGreaterThan(0);
      for (const entry of reported) expect(where.store.has(entry.entry), `row ${cell.row}: ${entry.entry}`).toBe(true);
    }
  });
});

/** One `pithy` command a report line names, parsed out of the line exactly as it is printed. */
type NamedCommand = { kind: "provision" } | { kind: "create"; name: string; env: string | undefined };

/**
 * Every command a line names, in order.
 *
 * `--env` is captured rather than assumed, because it is the flag the third round of #517 got wrong: the
 * write rule refuses it for a `global` secret, so a line carrying it on one is a line whose remedy throws.
 */
function commandsIn(line: string): NamedCommand[] {
  const found: NamedCommand[] = [];
  for (const match of line.matchAll(/pithy secrets (?:(provision)|create ([\w-]+)(?: --env ([\w-]+))?)/g)) {
    if (match[1]) found.push({ kind: "provision" });
    else found.push({ kind: "create", name: match[2] as string, env: match[3] });
  }
  return found;
}

describe("the lines themselves", () => {
  test("a provisionable group is one sentence naming the one command that creates every entry on it", async () => {
    const lines = await report(await bareWorker());
    expect(lines.filter((line) => line.includes("Run pithy secrets provision —"))).toEqual(
      ENVIRONMENTS.map(
        (env) =>
          `board env.${env} binds no CFS_ENV_MINT, CFS_GLOBAL_MINT, SECRETS_ENCRYPTION_KEYS. Run pithy secrets provision — it creates the store entries and writes the stanza.`,
      ),
    );
  });

  test("a supplied environment-scoped group names one create per secret, each with its --env", async () => {
    const lines = await report(await bareWorker());
    expect(lines.filter((line) => line.startsWith("board env.staging binds no CFS_ENV_BOOTSTRAP"))).toEqual([
      "board env.staging binds no CFS_ENV_BOOTSTRAP, CFS_ENV_SUPPLIED. Run pithy secrets create CFS_ENV_BOOTSTRAP --env staging, pithy secrets create CFS_ENV_SUPPLIED --env staging to supply their values, then pithy secrets provision to write the stanza.",
    ]);
  });

  /**
   * **One command, however many stanzas are short of it, and no `--env` on it.** `global` is one entry
   * every environment binds, so a report printing it per environment asks an operator to run the same
   * command twice — the same dead end as one that only works the first time. And the write rule *refuses*
   * `--env` on a global secret, so a line carrying it is a line whose remedy throws: that was the third
   * attempt on #517. Every short stanza is still named, because provisioning writes all of them.
   */
  test("a supplied global group is one sentence, one command, and no --env", async () => {
    const lines = await report(await bareWorker());
    expect(lines.filter((line) => line.includes("CFS_GLOBAL_BOOTSTRAP"))).toEqual([
      "board env.staging, env.prod bind no CFS_GLOBAL_BOOTSTRAP, CFS_GLOBAL_SUPPLIED. Run pithy secrets create CFS_GLOBAL_BOOTSTRAP, pithy secrets create CFS_GLOBAL_SUPPLIED to supply their values, then pithy secrets provision to write every stanza.",
    ]);
  });

  /** A single supplied secret reads as one thing, not as a list of one. */
  test("one supplied secret is stated in the singular", async () => {
    const registry = defineSecretRegistry({
      CFS_ENV_SUPPLIED: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
    });
    const target = await bareWorker(registry as SecretRegistry);
    expect((await report(target))[0]).toBe(
      "board env.staging binds no CFS_ENV_SUPPLIED. Run pithy secrets create CFS_ENV_SUPPLIED --env staging to supply its value, then pithy secrets provision to write the stanza.",
    );
  });

  /** A Worker's two answers stay adjacent, so a report never reads as two separate findings. */
  test("each Worker and environment keeps its lines together", async () => {
    const target = await bareWorker();
    const web = await worker("web", { staging: {}, prod: {} });
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [target, web],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    if (!check) throw new Error("no check");
    // Every line of one Worker's report is contiguous: a Worker's name never reappears after another's.
    const workers = describeSecretBindings(check).map((line) => line.slice(0, line.indexOf(" env.")));
    expect(new Set(workers)).toEqual(new Set(["board", "web"]));
    const runs = workers.filter((name, index) => name !== workers[index - 1]);
    expect(runs).toEqual([...new Set(runs)]);
  });
});

describe("checkSecretBindings", () => {
  test("a stanza binding everything it declares is ok", async () => {
    const target = await bareWorker();
    await runEveryRemedy(target, account());
    expect(
      await checkSecretBindings({
        projectDir: dir,
        targets: [target],
        environments: ENVIRONMENTS,
        project: PROJECT,
      }),
    ).toEqual({ state: "ok", missing: [] });
  });

  /**
   * `dev` is not among the environments a project declares, and that is the point: local dev
   * materializes every `cf-secrets-store` secret into the generated `.dev.vars` (#179), so a stanza
   * there would name entries a local run never reads.
   */
  test("only the environments the project declares, which never include dev", async () => {
    const target = await bareWorker();
    await runEveryRemedy(target, account());
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [target],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    expect(check?.state).toBe("ok");
  });

  test("a project where no Worker composes secrets has no answer to give", async () => {
    expect(
      await checkSecretBindings({ projectDir: dir, targets: [], environments: ENVIRONMENTS, project: PROJECT }),
    ).toBeNull();
  });

  /**
   * A Worker whose `pithy.config.ts` would not import is exactly the one that might have declared the
   * secret this would otherwise report as unbound. "Binds no X" is a negative claim about a registry
   * nobody read, so the whole check declines rather than answering confidently (#199).
   */
  test("a config nobody could import makes this decline rather than claim ok", async () => {
    expect(
      await checkSecretBindings({
        projectDir: dir,
        targets: [await bareWorker()],
        unresolvable: [{ name: "web", dir: "apps/web", reason: "cannot import" }],
        environments: ENVIRONMENTS,
        project: PROJECT,
      }),
    ).toEqual({ state: "could-not-check", missing: [] });
  });

  test("a wrangler.jsonc nobody could read establishes nothing", async () => {
    const workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");
    expect(
      await checkSecretBindings({
        projectDir: dir,
        targets: [{ name: "board", dir: workerDir, registry: REGISTRY }],
        environments: ENVIRONMENTS,
        project: PROJECT,
      }),
    ).toEqual({ state: "could-not-check", missing: [] });
  });

  /**
   * **A project with no name cannot say which entry a value would land in**, and every line here is about
   * one. A guess would put the reported address somewhere `pithy secrets provision` never asks about,
   * which is a worse dead end than the one #517 is about: the operator does real work and the complaint
   * stays. `Project name:` is the block that says why.
   */
  test("a project with no resolvable name declines rather than guessing an entry name", async () => {
    expect(
      await checkSecretBindings({ projectDir: dir, targets: [await bareWorker()], environments: ENVIRONMENTS }),
    ).toEqual({ state: "could-not-check", missing: [] });
  });
});

/**
 * **The write rule the remedy's flags have to satisfy.**
 *
 * `supplyStoreEntryCommand` puts `--env` on an `environment` secret and leaves it off a `global` one, and
 * this is why: the rule refuses each mistake from its own end. The third attempt on #517 printed the flag
 * on a global secret, so following the line raised a refusal instead of writing anything.
 */
describe("the write rule decides which flag a remedy may carry", () => {
  test("a global secret refuses --env, an environment-scoped one requires it", () => {
    expect(() =>
      secretWriteTargets({
        name: "CFS_GLOBAL_SUPPLIED",
        backend: "cf-secrets-store",
        scope: "global",
        mode: "create",
        requested: "prod",
        declared: [...ENVIRONMENTS],
      }),
    ).toThrow(/--env cannot narrow it/);
    expect(() =>
      secretWriteTargets({
        name: "CFS_ENV_SUPPLIED",
        backend: "cf-secrets-store",
        scope: "environment",
        mode: "create",
        requested: undefined,
        declared: [...ENVIRONMENTS],
      }),
    ).toThrow(/choose an environment/);
  });

  /** And a keyspace is refused by the command body before any of that — the truth table's row 5. */
  test("a keyspace is refused as a secret, which is why row 5 has no command", async () => {
    const where = account();
    await expect(pithySecrets(where, "create", "D1_ENV_KEYED", "prod", "value")).rejects.toThrow(
      /is a keyspace, not a secret/,
    );
    expect([...where.store.keys()]).toEqual([]);
    expect([...where.rows.keys()]).toEqual([]);
  });
});

/**
 * **A stanza is not short of a binding for a secret nothing can reach (#541).**
 *
 * The same rule this wave applied to `Dev secrets:`, one block down. `boundSecretNames` filters on
 * `cf-secrets-store`, and no kit credential behind a declined binding is one today — but the rule is
 * about the report rather than about today's registry, and a `secrets_store_secrets` line for a
 * credential the configuration has refused is a line an operator can never close.
 */
describe("what the configuration cannot reach", () => {
  const storeBacked = defineSecretRegistry({
    "support-r2-credentials": {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      binding: "SUPPORT_BUCKET",
    },
  });

  test("is reported when it applies", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker(storeBacked)],
      environments: ENVIRONMENTS,
      project: PROJECT,
    });
    expect(check?.state).toBe("unbound");
    expect(check?.missing.map((entry) => entry.binding)).toContain("support-r2-credentials");
  });

  test("and is not reported when it does not", async () => {
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker(storeBacked)],
      environments: ENVIRONMENTS,
      project: PROJECT,
      inapplicable: applicabilityFor("support-r2-credentials", "SUPPORT_BUCKET declined in pithy.config.ts"),
    });
    expect(check?.state).toBe("ok");
    expect(check?.missing).toEqual([]);
  });

  /**
   * **Never the master key.** Every environment's `SECRETS_ENCRYPTION_KEYS` stanza is what lets a
   * deployed Worker open its store at all, so a declaration that could silence it would hide the one
   * finding in this block that stops everything else working.
   */
  test("never silences the master key", async () => {
    const withMaster = defineSecretRegistry({
      [MASTER_KEY_BINDING]: {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        bootstrap: true,
        valueType: "text",
      },
    });
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [await bareWorker(withMaster)],
      environments: ENVIRONMENTS,
      project: PROJECT,
      inapplicable: applicabilityFor(MASTER_KEY_BINDING, "somebody declared this unreachable"),
    });
    expect(check?.missing.map((entry) => entry.binding)).toContain(MASTER_KEY_BINDING);
  });

  /**
   * **The mixed-Worker case, which is where this survived a round.**
   *
   * A secret is per project — one name, one value — so `SecretApplicability.project` marks a name only
   * when *every* Worker has declined it, and that is right for `pithy secrets ls` and for the one
   * `.dev.secrets.json`. It is wrong here, and wrong in the way that reads as a bug: this loop is per
   * Worker and per environment, and a `secrets_store_secrets` stanza belongs to one Worker. Handed the
   * project answer, the report told the Worker that had *just* declined `SUPPORT_BUCKET` that its stanza
   * was short of `support-r2-credentials` — because a second Worker still reaches it. That is a finding
   * the first Worker can never close, printed a few lines under its own decline.
   */
  test("takes a credential out of the Worker that declined it, and leaves it for the one that did not", async () => {
    const declining = {
      ...(await worker("board", Object.fromEntries(ENVIRONMENTS.map((env) => [env, {}])))),
      registry: storeBacked,
    };
    const reading = {
      ...(await worker("collab", Object.fromEntries(ENVIRONMENTS.map((env) => [env, {}])))),
      registry: storeBacked,
    };
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [declining, reading],
      environments: ENVIRONMENTS,
      project: PROJECT,
      // What the real resolver answers for that project: nothing is out of reach *project-wide*, because
      // `collab` still reads it, and it is out of reach for `board`.
      inapplicable: {
        project: new Map(),
        byWorker: new Map([
          ["board", new Map([["support-r2-credentials", "SUPPORT_BUCKET declined in pithy.config.ts"]])],
        ]),
      },
    });
    expect(check?.missing.map((entry) => entry.worker)).toEqual(["collab", "collab"]);
  });
});
