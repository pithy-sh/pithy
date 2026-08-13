// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { decodeVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { SecretAlreadyExistsError } from "@pithy-sh/secrets/src/error/errors";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { CliAuditEvent } from "../audit/cliAudit";
import { mintDeclaredSecrets, mintedBeforeFailure, mintReportLines, storeSecretMinter } from "./mintSecrets";

/**
 * **A counter around the one producer of key material, so "nothing was minted" is checkable.**
 *
 * Every other property here is observable in what was dispatched. This one is not: a value minted
 * before absence is known, handed to a Workflow, and discarded unread leaves no trace in any request —
 * which is exactly why it survived a review. `mintSecretValue` keeps its real behaviour (the entropy
 * assertions elsewhere in this file still hold); the wrapper only counts.
 */
const mints = vi.hoisted(() => ({ count: 0 }));
vi.mock("@pithy-sh/secrets/src/mintValue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pithy-sh/secrets/src/mintValue")>();
  return {
    ...actual,
    mintSecretValue: (kind: Parameters<typeof actual.mintSecretValue>[0]) => {
      mints.count += 1;
      return actual.mintSecretValue(kind);
    },
  };
});

const entry: SecretRegistryEntry = {
  backend: "cf-secrets-store",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
};

/** A store that records what it was told to write, so a test can read the envelope back. */
function recordingStore() {
  const written = new Map<string, string>();
  return { written, put: async (name: string, value: string) => void written.set(name, value) };
}

describe("storeSecretMinter", () => {
  test("writes a versioned envelope holding one fresh value", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });

    await mint({ binding: "RELEASE_INGEST_SECRET", secretName: "replay-staging-release-ingest-secret", entry });

    const stored = store.written.get("replay-staging-release-ingest-secret");
    expect(stored).toBeDefined();
    const envelope = decodeVersionedValue(stored as string);
    expect(envelope.currentVersion).toBe("1");
    // 32 bytes of CSPRNG entropy, base64url and unpadded.
    expect(envelope.versions["1"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("mints a different value every time — nothing is derived from the name", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });

    await mint({ binding: "A", secretName: "a", entry });
    await mint({ binding: "B", secretName: "b", entry });

    expect(store.written.get("a")).not.toEqual(store.written.get("b"));
  });

  /**
   * The one hard rule of a secrets trail: the event records that a value was written and where, and
   * nothing that could reconstruct it. This asserts against the serialized event, so a value smuggled
   * into any field at any depth fails.
   */
  test("audits the creation and never the value", async () => {
    const store = recordingStore();
    const events: CliAuditEvent[] = [];
    const mint = storeSecretMinter({
      store,
      environment: "staging",
      audit: async (event) => void events.push(event),
    });

    await mint({ binding: "RELEASE_INGEST_SECRET", secretName: "replay-staging-release-ingest-secret", entry });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      environment: "staging",
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: "replay-staging-release-ingest-secret",
    });
    const value = decodeVersionedValue(store.written.get("replay-staging-release-ingest-secret") as string).versions[
      "1"
    ];
    expect(JSON.stringify(events[0])).not.toContain(value);
  });

  /**
   * **The rule `bindingValue()` owns, at a second producer.**
   *
   * A `bootstrap` secret is read straight off its binding by code that runs before the envelope decoder
   * exists — `resolveEncryptionConfig` parses `SECRETS_ENCRYPTION_KEYS` directly — so its store entry
   * carries the current value verbatim, not the `{ currentVersion, versions }` envelope every other
   * secret is stored as. The minter wrote an envelope unconditionally. A Worker bound to that entry
   * fails at its first read, with the binding plainly present.
   *
   * `defineSecretRegistry` admits this exact entry: bootstrap must be `cf-secrets-store`, which is the
   * only backend this minter handles.
   */
  test("a bootstrap secret's entry carries the value, not the envelope", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });
    const bootstrap: SecretRegistryEntry = { ...entry, scope: "global", bootstrap: true };

    await mint({ binding: "BOOTSTRAP_KEY", secretName: "replay-global-bootstrap-key", entry: bootstrap });

    const stored = store.written.get("replay-global-bootstrap-key");
    // The bare minted value: 32 bytes of CSPRNG entropy, base64url and unpadded. Not JSON, not encoded.
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  /**
   * Defence in depth. The caller already asks {@link isMintableSecret} first, so reaching this is a bug —
   * and a bug that would put a random string where a real credential was meant, authenticating against
   * nothing. It refuses rather than inventing.
   */
  test("refuses an entry that declares no value of its own", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });
    const supplied: SecretRegistryEntry = {
      backend: "cf-secrets-store",
      scope: "global",
      rotatable: false,
      valueType: "text",
    };

    await expect(
      mint({ binding: "STRIPE_SECRET_KEY", secretName: "replay-global-stripe", entry: supplied }),
    ).rejects.toThrow(InternalError);
    expect(store.written.size).toBe(0);
  });
});

/** A dispatcher that records every request, so a test can read what the manager was asked to do. */
function recordingDispatcher() {
  const sent: SecretWriteRequest[] = [];
  return {
    sent,
    dispatch: async (request: SecretWriteRequest) => void sent.push(request),
    probe: async () => false,
  };
}

/**
 * **The deployed managers, one per environment, modelled to their contract and no further.**
 *
 * Each environment's manager owns a separate store keyed by a separate master key, and the CLI can
 * neither read one nor coordinate two. So the only two behaviours that matter here are the two the
 * manager guarantees, and each is pinned in the worker runtime by `writeSecret.workers.test.ts` rather
 * than assumed here: `create` refuses a name that is already present, and `probe` reports presence
 * without writing anything.
 *
 * `breakOn` is the fault injector, and it takes the **phase** as well as the environment. That is not
 * decoration: an environment unreachable from the start now fails during probing, before anything is
 * written anywhere, and the half-written state this gate is about needs a manager that answered a probe
 * and then died. A predicate that could not tell those apart would test the easy one.
 */
function fakeManagers(environments: readonly string[]) {
  const stores = new Map<string, Map<string, string>>(environments.map((env) => [env, new Map()]));
  const store = (env: string) => stores.get(env) as Map<string, string>;
  type Fault = { env: string; phase: "probe" | "write" };
  let fail: (fault: Fault) => boolean = () => false;
  return {
    /** Break every call matching `predicate` — the network loss, the manager that was never deployed. */
    breakOn(predicate: (fault: Fault) => boolean) {
      fail = predicate;
    },
    heal() {
      fail = () => false;
    },
    /** What an environment actually holds. Test-only: nothing in the product reads a stored value. */
    value(env: string, name: string): string | undefined {
      return store(env).get(name);
    },
    async probe(request: { env: string; name: string }): Promise<boolean> {
      if (fail({ env: request.env, phase: "probe" })) throw new Error(`${request.env} unreachable`);
      return store(request.env).has(request.name);
    },
    async dispatch(request: SecretWriteRequest): Promise<void> {
      if (fail({ env: request.env, phase: "write" })) throw new Error(`${request.env} unreachable`);
      const entries = store(request.env);
      if (request.mode === "delete") {
        entries.delete(request.name);
        return;
      }
      if (request.mode === "create" && entries.has(request.name)) {
        throw new SecretAlreadyExistsError({ message: `Secret '${request.name}' already exists.` });
      }
      entries.set(request.name, request.value as string);
    },
  };
}

/** The two shapes the kit ships: a per-environment session secret, and a global link-signing key. */
const sessionSecret: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
};
const linkKey: SecretRegistryEntry = {
  backend: "d1",
  scope: "global",
  rotatable: true,
  valueType: "text",
  devValue: "random",
};

/** The default declaration: least-production first, which is the order provisioning walks. */
const environments = ["staging", "prod"] as const;

describe("mintDeclaredSecrets", () => {
  /**
   * `create`, never `update` and never an upsert. `update` would replace a live minted key on every
   * run — a second session secret signs everyone out — and `create` is also the only mode that
   * *raises* when the name is already there, which is what stops a run losing a race quietly.
   */
  test("dispatches create — the mode that refuses rather than replaces or skips", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret },
      dispatcher,
      probe: dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.sent[0]).toMatchObject({
      env: "staging",
      mode: "create",
      name: "auth-session-secret",
      valueType: "text",
      rotatable: true,
    });
  });

  /**
   * `global` is a promise that every environment holds the same value. Email signs a link in one
   * environment and verifies it in whichever one the recipient's click reaches; a value minted per
   * environment would make every such link fail, and only for real users.
   */
  test("a global secret is minted once and reaches every environment carrying that one value", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { "email-link-signing-key": linkKey },
      dispatcher,
      probe: dispatcher,
      environments: ["staging", "prod"],
    });

    expect(dispatcher.sent.map((request) => request.env)).toEqual(["staging", "prod"]);
    expect(new Set(dispatcher.sent.map((request) => request.value)).size).toBe(1);
  });

  /**
   * The mirror of the rule above, and the reason this owns the environment loop rather than a caller.
   * A staging session secret that also signs prod sessions makes the environment boundary decorative.
   */
  test("an environment secret is minted afresh for each environment", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret },
      dispatcher,
      probe: dispatcher,
      environments: ["staging", "prod"],
    });

    expect(dispatcher.sent.map((request) => request.env)).toEqual(["staging", "prod"]);
    expect(new Set(dispatcher.sent.map((request) => request.value)).size).toBe(2);
  });

  test("mints a fresh value per secret and reports the names, never the values", async () => {
    const dispatcher = recordingDispatcher();

    const minted = await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret, "email-link-signing-key": linkKey },
      dispatcher,
      probe: dispatcher,
      environments: ["staging"],
    });

    expect(minted).toEqual([
      { name: "auth-session-secret", environments: ["staging"], created: ["staging"] },
      { name: "email-link-signing-key", environments: ["staging"], created: ["staging"] },
    ]);
    const values = dispatcher.sent.map((request) => request.value);
    expect(new Set(values).size).toBe(2);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("leaves a supplied secret alone — a random string authenticates against nothing", async () => {
    const dispatcher = recordingDispatcher();
    const supplied: SecretRegistryEntry = {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "json",
      schema: z.object({ clientSecret: z.string().describe("The OAuth app's client secret.") }),
    };

    await mintDeclaredSecrets({
      registry: { "auth-google-credentials": supplied },
      dispatcher,
      probe: dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toEqual([]);
  });

  test("leaves a Secrets Store secret alone — provisioning binds and creates those in one pass", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { CONNECTION_KEY_ENCRYPTION_KEY: { ...entry } },
      dispatcher,
      probe: dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toEqual([]);
  });

  test("leaves a keyspace alone — its members exist only at runtime", async () => {
    const dispatcher = recordingDispatcher();
    const keyspace: SecretRegistryEntry = {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "text",
      keyed: true,
    };

    await mintDeclaredSecrets({
      registry: { CONNECTION_SIGNING_KEY: keyspace },
      dispatcher,
      probe: dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toEqual([]);
  });

  /**
   * **The invariant, under a fault.** A `global` secret is *defined* by holding one value in every
   * environment — a link signed in staging is verified by whichever environment the recipient's click
   * reaches. Per-environment absence checks cannot preserve a cross-environment property, and the
   * `ensure` dispatch proved it: a run that wrote staging and then lost prod, re-run, minted a *second*
   * value, found staging present and skipped it, and wrote the new value to prod. Two environments, two
   * values, no error, and every link signed by one refused by the other.
   *
   * So the partial state is refused. Loudly, by name, with the environments that hold it and the ones
   * that do not — because the repair is a decision about a live signing key, and the tool does not get
   * to make it silently.
   */
  test("a global secret left half-written is refused, never completed with a second value", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    const registry = { "email-link-signing-key": linkKey };
    const run = () => mintDeclaredSecrets({ registry, dispatcher: managers, probe: managers, environments });

    // Run one: prod answers the probe, then dies before its write.
    managers.breakOn(({ env, phase }) => env === "prod" && phase === "write");
    await expect(run()).rejects.toThrow();
    const staged = managers.value("staging", "email-link-signing-key");
    expect(staged).toBeDefined();
    expect(managers.value("prod", "email-link-signing-key")).toBeUndefined();

    // Run two, with prod back. It must not mint a second value into the gap.
    managers.heal();
    await expect(run()).rejects.toThrow(ConflictError);
    expect(managers.value("prod", "email-link-signing-key")).toBeUndefined();
    expect(managers.value("staging", "email-link-signing-key")).toBe(staged);
  });

  /**
   * The other half of asking first: an environment that cannot be reached at all is discovered *before*
   * any value is written, so a run against a half-deployed project leaves nothing behind to reconcile.
   * Under `ensure` the same run wrote staging and then failed, which is how the split started.
   */
  test("an unreachable environment stops the run before anything is written anywhere", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    managers.breakOn(({ env }) => env === "prod");

    await expect(
      mintDeclaredSecrets({
        registry: { "email-link-signing-key": linkKey },
        dispatcher: managers,
        probe: managers,
        environments,
      }),
    ).rejects.toThrow();

    expect(managers.value("staging", "email-link-signing-key")).toBeUndefined();
    expect(managers.value("prod", "email-link-signing-key")).toBeUndefined();
  });

  /** The refusal has to be readable at 2am: which secret, which environments hold it, which do not. */
  test("the refusal names the secret and both sides of the split", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    const registry = { "email-link-signing-key": linkKey };
    managers.breakOn(({ env, phase }) => env === "prod" && phase === "write");
    await expect(
      mintDeclaredSecrets({ registry, dispatcher: managers, probe: managers, environments }),
    ).rejects.toThrow();

    managers.heal();
    await expect(
      mintDeclaredSecrets({ registry, dispatcher: managers, probe: managers, environments }),
    ).rejects.toMatchObject({
      payload: {
        message: expect.stringContaining("email-link-signing-key"),
        detail: expect.stringContaining("prod"),
      },
    });
  });

  /**
   * **The refusal used to offer a repair no command can perform (#324).** Its first branch read *"give
   * the others the same value with `pithy secrets create`"* — and for these secrets nobody can. They are
   * `d1`, minted from `crypto.getRandomValues`, sealed under a master key that never leaves the manager
   * Worker. There is no way to read the value out of the environment that has it, so the operator who
   * reached for the first branch found no way to take a single step of it.
   *
   * The gate is the **set of commands the action offers**, extracted from the text rather than compared
   * to it: a menu whose first item cannot be chosen fails whatever words surround it.
   */
  test("the refusal offers only the command that can actually be run", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    const registry = { "email-link-signing-key": linkKey };
    managers.breakOn(({ env, phase }) => env === "prod" && phase === "write");
    await expect(
      mintDeclaredSecrets({ registry, dispatcher: managers, probe: managers, environments }),
    ).rejects.toThrow();
    managers.heal();

    const refusal = await mintDeclaredSecrets({
      registry,
      dispatcher: managers,
      probe: managers,
      environments,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConflictError);
    const action = (refusal as ConflictError).payload.action ?? "";
    expect([...new Set(action.match(/pithy secrets [a-z]+/g) ?? [])]).toEqual(["pithy secrets rm"]);
    // The remedy destroys a live signing key, so the refusal says so rather than letting an operator
    // discover it by running the command.
    expect(action).toMatch(/destroys/);
  });

  /**
   * **The report entry used to be pushed after the delivery loop, so a throw inside it took the whole
   * record with it (#324).** The environments already written held a new secret and the run reported
   * nothing created — the operator arrived at the next run's refusal with no record of what happened.
   *
   * Asserted against the fake managers' own stores as well as the report, so the report is checked
   * against what landed rather than against itself.
   */
  test("a fan-out that dies part-way reports the environments it wrote", async () => {
    const declared = ["staging", "canary", "prod"] as const;
    const managers = fakeManagers(declared);
    managers.breakOn(({ env, phase }) => env === "prod" && phase === "write");

    const failure = await mintDeclaredSecrets({
      registry: { "email-link-signing-key": linkKey },
      dispatcher: managers,
      probe: managers,
      environments: declared,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(mintedBeforeFailure(failure)).toEqual([
      { name: "email-link-signing-key", environments: ["staging", "canary", "prod"], created: ["staging", "canary"] },
    ]);
    expect(managers.value("staging", "email-link-signing-key")).toBeDefined();
    expect(managers.value("canary", "email-link-signing-key")).toBeDefined();
    expect(managers.value("prod", "email-link-signing-key")).toBeUndefined();
  });

  /** Nothing landed, so nothing is claimed. The carrier reports emptiness, not a plan. */
  test("a run that fails before writing anything reports nothing created", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    managers.breakOn(({ env }) => env === "prod");

    const failure = await mintDeclaredSecrets({
      registry: { "email-link-signing-key": linkKey },
      dispatcher: managers,
      probe: managers,
      environments,
    }).catch((error: unknown) => error);

    expect(mintedBeforeFailure(failure)).toEqual([]);
  });

  /** The accounting for the secrets that finished survives the one that does not. */
  test("a secret already accounted for is still reported when a later one fails", async () => {
    const declared = ["staging", "canary", "prod"] as const;
    const managers = fakeManagers(declared);
    for (const env of declared) {
      await managers.dispatch({ env, mode: "create", name: "auth-session-secret", value: "theirs" });
    }
    managers.breakOn(({ env, phase }) => env === "prod" && phase === "write");

    const failure = await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret, "email-link-signing-key": linkKey },
      dispatcher: managers,
      probe: managers,
      environments: declared,
    }).catch((error: unknown) => error);

    expect(mintedBeforeFailure(failure)).toEqual([
      { name: "auth-session-secret", environments: ["staging", "canary", "prod"], created: [] },
      { name: "email-link-signing-key", environments: ["staging", "canary", "prod"], created: ["staging", "canary"] },
    ]);
  });

  /**
   * **The two defects meet here.** The operator who hits the refusal needs to know what the run that
   * reached it wrote — that is what makes the destructive remedy safe to perform. So the report rides
   * on the refusal, and the refusal itself is unchanged: carried, never replaced.
   */
  test("the refusal carries what the same run created before it", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    // The global key is in staging only — the split. The session secret is absent everywhere, and sorts
    // first, so this run creates it and then refuses.
    await managers.dispatch({ env: "staging", mode: "create", name: "email-link-signing-key", value: "theirs" });

    const refusal = await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret, "email-link-signing-key": linkKey },
      dispatcher: managers,
      probe: managers,
      environments,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConflictError);
    expect(mintedBeforeFailure(refusal)).toEqual([
      { name: "auth-session-secret", environments: ["staging", "prod"], created: ["staging", "prod"] },
    ]);
  });

  /**
   * One renderer for the run that finishes and the run that fails part-way. Two would let the partial
   * report be phrased as a plan — "already in staging, prod" for a secret prod never received.
   */
  test("the report lines say created where a value landed, and never name an environment it missed", async () => {
    const declared = ["staging", "canary", "prod"] as const;
    const managers = fakeManagers(declared);
    managers.breakOn(({ env, phase }) => env === "prod" && phase === "write");

    const failure = await mintDeclaredSecrets({
      registry: { "email-link-signing-key": linkKey },
      dispatcher: managers,
      probe: managers,
      environments: declared,
    }).catch((error: unknown) => error);

    expect(mintReportLines(mintedBeforeFailure(failure))).toEqual([
      "email-link-signing-key created in staging, canary.",
    ]);
  });

  /**
   * A complete run is idempotent and, crucially, **mints nothing on the way past**. Absence is asked
   * first, so a re-run generates no key material at all — the speculative 256-bit value that used to be
   * minted per secret per run, handed to a Workflow, and discarded unread is simply never created.
   */
  test("a re-run over a fully provisioned project dispatches nothing and mints nothing", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    const registry = { "auth-session-secret": sessionSecret, "email-link-signing-key": linkKey };

    await mintDeclaredSecrets({ registry, dispatcher: managers, probe: managers, environments });
    const before = environments.map((env) => managers.value(env, "email-link-signing-key"));

    const writes: SecretWriteRequest[] = [];
    const second = await mintDeclaredSecrets({
      registry,
      dispatcher: {
        dispatch: async (request) => void writes.push(request),
      },
      probe: managers,
      environments,
    });

    expect(writes).toEqual([]);
    expect(second).toEqual([
      { name: "auth-session-secret", environments: ["staging", "prod"], created: [] },
      { name: "email-link-signing-key", environments: ["staging", "prod"], created: [] },
    ]);
    expect(environments.map((env) => managers.value(env, "email-link-signing-key"))).toEqual(before);
  });

  /**
   * **R1-b, and the reason it needed a counter.** `mintSecretValue` used to be called for every
   * declared secret on every run, before absence could be known — necessarily, since only the manager
   * can answer for a `d1` secret. So `pithy secrets provision`, run nightly by a pipeline, generated
   * fresh 256-bit key material for already-provisioned secrets and deposited it, unused, in Workflow
   * instance params that Cloudflare retains.
   *
   * Asking first is what removes the exposure rather than narrowing it: on a provisioned project no key
   * material is generated at all, so there is nothing to leave anywhere.
   */
  test("generates no key material at all for secrets that already exist", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    const registry = { "auth-session-secret": sessionSecret, "email-link-signing-key": linkKey };
    const options = { registry, dispatcher: managers, probe: managers, environments };

    await mintDeclaredSecrets(options);
    expect(mints.count).toBeGreaterThan(0);

    mints.count = 0;
    await mintDeclaredSecrets(options);

    expect(mints.count).toBe(0);
  });

  /**
   * The narrow window probing leaves open: two runs both find a global secret absent, and one writes
   * between the other's probe and its own write. `create` is what closes it — it refuses a name already
   * there, so the loser fails rather than fanning its own value into the environments the winner has
   * not reached yet.
   */
  test("a concurrent run that wrote first makes this one fail rather than diverge", async () => {
    const managers = fakeManagers(["staging", "prod"]);
    const registry = { "email-link-signing-key": linkKey };

    // Probe sees nothing; another operator's run lands in staging before this one writes.
    const racing = {
      probe: async () => false,
      dispatch: managers.dispatch,
    };
    await managers.dispatch({ env: "staging", mode: "create", name: "email-link-signing-key", value: "theirs" });

    await expect(mintDeclaredSecrets({ registry, dispatcher: racing, probe: racing, environments })).rejects.toThrow(
      SecretAlreadyExistsError,
    );
    expect(managers.value("staging", "email-link-signing-key")).toBe("theirs");
    expect(managers.value("prod", "email-link-signing-key")).toBeUndefined();
  });

  test("audits each creation by name, and never carries a value", async () => {
    const dispatcher = recordingDispatcher();
    const events: CliAuditEvent[] = [];

    await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret },
      dispatcher,
      probe: dispatcher,
      environments: ["staging"],
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      environment: "staging",
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: "auth-session-secret",
    });
    expect(JSON.stringify(events[0])).not.toContain(dispatcher.sent[0]?.value);
  });
});
