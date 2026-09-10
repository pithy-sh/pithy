// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import {
  backendRoutedDispatcher,
  type PreflightSecretDispatcher,
  type SecretRotationCloseRequest,
  type SecretRotationOpenRequest,
} from "@pithy-sh/secrets/src/cli/dispatch";
import { currentValue, initialVersionedValue, type VersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { runWriteSecret, type WriteSecretParams } from "@pithy-sh/secrets/src/management/writeSecret";
import { WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";
import type { SecretRegistry, SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { RotationTracker } from "@pithy-sh/secrets/src/store/rotationTracker";
import type { SystemSecretsStore } from "@pithy-sh/secrets/src/store/systemSecretsStore";
import { describe, expect, test } from "vitest";
import type { SecretsStore } from "../provision/store";
import { runSecretRotation, type SecretRotationDispatcher } from "./rotateSecrets";
import { storeSecretWriter } from "./storeSecretWrites";

/**
 * # A rotation refuses in front of the issuer on **both** backends, and the order is the assertion (#517)
 *
 * The first half of this fix gave `storeSecretWriter` a pre-flight and taught `rotateSecretValue` to ask
 * it above the irreversible line. It left `d1` — the more common backend — exactly as it was, because the
 * seam was optional and an absent method reads like nothing to ask. Measured, that is: `pithy secrets
 * rotate` calls the issuer, takes delivery of a new credential, dispatches an `update`, and the manager
 * answers `Secret 'X' does not exist`. The old credential is dead at the issuer, the new one existed only
 * in the process raising that error, and the operator's next move is a console.
 *
 * ## Why every case here asserts a call *order* rather than an exit code
 *
 * Because the exit code was already right. The command exited non-zero throughout the window the defect
 * was live — it exited non-zero *because* the credential was gone. So a test that reads a status, or a
 * message, or an outcome, agrees with the bug: the only thing that distinguishes the fixed ordering from
 * the broken one is **whether the rotator was called at all**. Each case therefore drives the real
 * `rotateSecretValue`, through the real `runSecretRotation`, over the real writers and the real router,
 * against a recording rotator and a recording destination — and asserts the sequence of everything that
 * happened, plus the three facts that make a refusal survivable:
 *
 * - the rotator was called **zero** times,
 * - no ledger row was opened, so no history records an attempt that never started,
 * - and the credential the issuer holds is still the one the Worker holds.
 *
 * ## What is real, and what stands in
 *
 * Real: the registry entries, `runSecretRotation`, `rotateSecretValue`, `backendRoutedDispatcher`,
 * `WorkflowSecretDispatcher` (both its write path and its pre-flight), `storeSecretWriter`, and the
 * composition `commands/secrets.ts` builds for `pithy secrets rotate`. A stand-in: the transport under
 * the manager (one function answering the Workflows REST client's `dispatchAndPoll`) and the account's
 * Secrets Store. Both record what they were asked, in order, into the same log the rotator writes to —
 * which is what makes an ordering assertion possible at all.
 */

const PROJECT = "replay";
const DECLARED = ["staging", "prod"] as const;
const ENV: ManagedEnvironment = "prod";

/** Everything that happened, in the order it happened. One log across the rotator and both destinations. */
type Journal = string[];

/**
 * The issuer, as the one thing a rotation cannot undo: it holds a live credential, and rolling replaces it.
 *
 * `current` is what a Worker would present today. A refusal that lands in front of it leaves it untouched,
 * which is the difference between *run the command again* and *open a console now*.
 */
function issuer(journal: Journal) {
  const state = { current: "live-credential", rolls: 0 };
  return {
    state,
    rotator: {
      async roll() {
        state.rolls += 1;
        state.current = `issued-${state.rolls}`;
        journal.push("roll");
        return { newValue: state.current };
      },
    },
  };
}

/** A `provider` secret on the named backend, rotated by the recording issuer above. */
function entry(backend: SecretRegistryEntry["backend"], rotator: SecretRegistryEntry["rotator"]): SecretRegistryEntry {
  return {
    backend,
    scope: "environment",
    rotatable: true,
    valueType: "text",
    rotation: { kind: "provider", issuer: "cloudflare", documentation: "https://example.invalid/rotate" },
    rotator,
  } as SecretRegistryEntry;
}

function registry(secret: SecretRegistryEntry): SecretRegistry {
  return { THE_SECRET: secret } as SecretRegistry;
}

/**
 * One environment's manager, as the Workflows client sees it: the manager's **own write core** behind a
 * transport that records what it was asked.
 *
 * `runWriteSecret` rather than a stand-in for it, because the refusal this whole issue turns on is that
 * function's — `update` on a name the store does not hold — and a fake that merely wrote would agree with
 * the defect instead of reproducing it. So the same code answers the probe and the write, which is also
 * the property the pre-flight depends on: two reads of one store through one function cannot disagree.
 *
 * `reachable: false` is a manager that was never provisioned — the dispatch itself throws, which is the
 * other refusal a `d1` rotation owns and the one no amount of retrying at the write could soften.
 */
function manager(journal: Journal, options: { holds?: Record<string, string>; reachable?: boolean } = {}) {
  const rows = new Map<string, VersionedValue>();
  for (const [name, value] of Object.entries(options.holds ?? {})) rows.set(name, initialVersionedValue(value));
  const store = {
    has: async (name: string) => rows.has(name),
    put: async (name: string, value: VersionedValue) => {
      rows.set(name, value);
    },
    delete: async (name: string) => {
      rows.delete(name);
    },
  } as unknown as SystemSecretsStore;
  // No history and none recorded: the ledger row is dispatched separately, and is asserted as a mode on
  // the wire rather than as a row here.
  const tracker = {
    getLatestSuccess: async () => null,
    recordBaseline: async () => {},
    purgeHistory: async () => {},
  } as unknown as RotationTracker;
  const client = {
    async dispatchAndPoll(workflow: string, params: { mode: string }) {
      if (options.reachable === false) throw new Error("no such Workflow: the manager is not deployed");
      journal.push(params.mode);
      expect(workflow).toBe(`${PROJECT}-${ENV}-secrets-write`);
      if (params.mode === "rotation-open") return { outcome: "opened", rotationId: 1 };
      if (params.mode === "rotation-close") return { outcome: "closed" };
      return { outcome: await runWriteSecret({ store, tracker }, params as WriteSecretParams) };
    },
  };
  /** What the environment's D1 holds, in the clear — this store stands in for the encrypting one. */
  const held = (name: string) => {
    const row = rows.get(name);
    return row === undefined ? null : currentValue(row);
  };
  return { held, dispatcher: new WorkflowSecretDispatcher(client as never, PROJECT) };
}

/** The account's one Secrets Store, recording every question and every write into the shared journal. */
function store(journal: Journal, entries: Map<string, string>): SecretsStore {
  return {
    storeId: "store-1",
    exists: async (name) => {
      journal.push("store:exists");
      return entries.has(name);
    },
    put: async (name, value) => {
      journal.push("store:put");
      entries.set(name, value);
    },
    remove: async (name) => {
      journal.push("store:remove");
      return entries.delete(name);
    },
  };
}

/**
 * The object `pithy secrets rotate` actually rotates through — `commands/secrets.ts`' composition, kept
 * here in the same shape: the router decides the write and the pre-flight, and the ledger is the manager's
 * alone because `pithy_secrets_rotations` lives in its D1.
 */
function rotationDispatcher(
  managed: WorkflowSecretDispatcher,
  storeWriter: PreflightSecretDispatcher,
): SecretRotationDispatcher {
  const routed = backendRoutedDispatcher({ d1: managed, "cf-secrets-store": storeWriter });
  return {
    dispatch: (request) => routed.dispatch(request),
    preflight: (request) => routed.preflight(request),
    openRotation: (request: SecretRotationOpenRequest) => managed.openRotation(request),
    closeRotation: (request: SecretRotationCloseRequest) => managed.closeRotation(request),
  };
}

/** A store writer nothing in a `d1` case may reach — arriving there would be a routing bug, not a pass. */
function noStore(journal: Journal): PreflightSecretDispatcher {
  return storeSecretWriter({
    store: async () => {
      journal.push("store:opened-by-a-d1-rotation");
      throw new Error("a d1 rotation reached the account's Secrets Store");
    },
    scope: (env) => environmentScope(PROJECT, env),
  });
}

/** A manager a `cf-secrets-store` case still needs, for the ledger row — and for nothing else. */
function ledgerOnly(journal: Journal) {
  return manager(journal, {});
}

async function rotate(secrets: SecretRegistry, dispatcher: SecretRotationDispatcher) {
  return await runSecretRotation(secrets, dispatcher, {
    name: "THE_SECRET",
    env: ENV,
    environments: DECLARED,
    attempts: 1,
  });
}

/**
 * Run the rotation and hand back whatever it did — the outcome, or the refusal it threw.
 *
 * **The refusal is caught rather than asserted, so that it is not the first thing asserted.** A case that
 * opens with `rejects.toThrow` dies on the throw when the ordering regresses, and the message it prints is
 * about a promise that resolved — which is the least useful sentence available, because the run it
 * describes rolled a live credential and lost it. Caught here, the first assertion each case makes is the
 * one that names the rotator.
 */
async function attempt(secrets: SecretRegistry, dispatcher: SecretRotationDispatcher): Promise<unknown> {
  return await rotate(secrets, dispatcher).catch((error: unknown) => error);
}

describe("a d1 rotation asks the manager before it asks the issuer", () => {
  /**
   * **The measured defect, as an ordering.** `update` on a secret the manager does not hold: the answer
   * is knowable with one probe, and until #517 it arrived at the write, with the credential already
   * rolled. Here the journal ends at the probe.
   */
  test("a secret the manager does not hold is refused with the rotator never called", async () => {
    const journal: Journal = [];
    const issued = issuer(journal);
    const managed = manager(journal, {});

    const refusal = await attempt(
      registry(entry("d1", issued.rotator)),
      rotationDispatcher(managed.dispatcher, noStore(journal)),
    );

    expect(issued.state.rolls, "the rotator was called for a rotation the manager was always going to refuse").toBe(0);
    // The whole run, in order. `roll` never appears, and neither does a row.
    expect(journal).toEqual(["probe"]);
    expect(issued.state.current, "the credential the Worker holds was retired for nothing").toBe("live-credential");
    expect(refusal).toMatchObject({ payload: { code: "secrets/not_found" } });
  });

  /** The other refusal a `d1` write owns: no manager to reach at all. Also knowable, also asked first. */
  test("an unreachable manager is refused with the rotator never called", async () => {
    const journal: Journal = [];
    const issued = issuer(journal);
    const managed = manager(journal, { reachable: false });

    const refusal = await attempt(
      registry(entry("d1", issued.rotator)),
      rotationDispatcher(managed.dispatcher, noStore(journal)),
    );

    expect(issued.state.rolls, "the rotator was called before anything asked whether the manager exists").toBe(0);
    expect(journal).toEqual([]);
    expect(issued.state.current).toBe("live-credential");
    expect(refusal).toMatchObject({ message: expect.stringContaining("not deployed") });
  });

  /**
   * The positive control, and the reason the negative ones mean something: when the pre-flight passes,
   * the roll happens **after** the row is opened and the write happens after the roll. One order, stated.
   */
  test("a secret the manager holds rotates, and the roll lands between the row and the write", async () => {
    const journal: Journal = [];
    const issued = issuer(journal);
    const managed = manager(journal, { holds: { THE_SECRET: "the-previous-credential" } });

    const outcome = await rotate(
      registry(entry("d1", issued.rotator)),
      rotationDispatcher(managed.dispatcher, noStore(journal)),
    );

    expect(outcome).toMatchObject({ status: "rotated", rolled: true, recorded: [ENV] });
    expect(journal).toEqual(["probe", "rotation-open", "roll", "update", "rotation-close"]);
    expect(issued.state.rolls).toBe(1);
    // And the environment now holds what the issuer issued, rather than what it held before.
    expect(managed.held("THE_SECRET")).toBe(issued.state.current);
  });
});

describe("a cf-secrets-store rotation asks the account before it asks the issuer", () => {
  /** The half that was already fixed, asserted the same way so the two backends answer as one. */
  test("an entry that is not there is refused with the rotator never called", async () => {
    const journal: Journal = [];
    const issued = issuer(journal);
    const entries = new Map<string, string>();
    const managed = ledgerOnly(journal);
    const writer = storeSecretWriter({
      store: async () => store(journal, entries),
      scope: (env) => environmentScope(PROJECT, env),
    });

    const refusal = await attempt(
      registry(entry("cf-secrets-store", issued.rotator)),
      rotationDispatcher(managed.dispatcher, writer),
    );

    expect(issued.state.rolls, "the rotator was called for a rotation the account was always going to refuse").toBe(0);
    expect(journal).toEqual(["store:exists"]);
    expect(issued.state.current).toBe("live-credential");
    expect([...entries]).toEqual([]);
    expect(refusal).toMatchObject({ payload: { code: "secrets/not_found" } });
  });

  /** An unreachable store, which is what a project with no `SECRETS_STORE_ID` has. */
  test("an unreachable store is refused with the rotator never called", async () => {
    const journal: Journal = [];
    const issued = issuer(journal);
    const managed = ledgerOnly(journal);
    const writer = storeSecretWriter({
      store: async () => {
        throw new Error("SECRETS_STORE_ID is not set");
      },
      scope: (env) => environmentScope(PROJECT, env),
    });

    const refusal = await attempt(
      registry(entry("cf-secrets-store", issued.rotator)),
      rotationDispatcher(managed.dispatcher, writer),
    );

    expect(issued.state.rolls, "the rotator was called before anything asked whether the store exists").toBe(0);
    expect(journal).toEqual([]);
    expect(issued.state.current).toBe("live-credential");
    expect(refusal).toMatchObject({ message: expect.stringContaining("SECRETS_STORE_ID") });
  });

  /** And the same positive control, over the store's own address. */
  test("a live entry rotates, and the roll lands between the row and the write", async () => {
    const journal: Journal = [];
    const issued = issuer(journal);
    const address = environmentScope(PROJECT, ENV).secretEntry("THE_SECRET", "environment");
    const entries = new Map<string, string>([[address, "the-previous-envelope"]]);
    const managed = ledgerOnly(journal);
    const writer = storeSecretWriter({
      store: async () => store(journal, entries),
      scope: (env) => environmentScope(PROJECT, env),
    });

    const outcome = await rotate(
      registry(entry("cf-secrets-store", issued.rotator)),
      rotationDispatcher(managed.dispatcher, writer),
    );

    expect(outcome).toMatchObject({ status: "rotated", rolled: true, recorded: [ENV] });
    // The pre-flight's question, the row, the roll, then the write's own question and the write.
    expect(journal).toEqual(["store:exists", "rotation-open", "roll", "store:exists", "store:put", "rotation-close"]);
    expect(entries.get(address)).toContain(issued.state.current);
  });
});
