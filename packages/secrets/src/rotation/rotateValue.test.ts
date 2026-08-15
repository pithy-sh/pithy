// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineSecretRegistry, type SecretRegistryEntry } from "../registry";
import type { ManagedEnvironment } from "../scope";
import { rotateSecretValue, type SecretValueStore } from "./rotateValue";
import type { ValueRotator } from "./valueRotator";

/**
 * **The suite is written against the irreversible failure, not against the happy path.**
 *
 * Every test below that matters asks one of two questions: did anything reach a provider that should not
 * have, and after a provider was reached, could the code have produced a second value? A green happy path
 * proves neither, and `#322` is explicit that the roll-succeeded-store-failed case is the whole design.
 */

const DECLARED: ManagedEnvironment[] = ["staging", "prod"];

/** A `local` secret: minted by the kit, replaced the same way. Email's link-signing key is the real one. */
const local: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
  rotation: { kind: "local" },
};

/** A `manual` secret: a human, in somebody else's console, and no call anywhere. */
const manual: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "text",
  origin: {
    kind: "obtained",
    issuer: "github",
    documentation: "https://github.com/settings/developers",
  },
  rotation: { kind: "manual", issuer: "github", documentation: "https://github.com/settings/developers" },
};

/** A rotator that counts its calls. The count is the assertion in every irreversibility test below. */
function countingRotator(value: string | (() => string)): ValueRotator & { calls: number } {
  const rotator = {
    calls: 0,
    async roll() {
      rotator.calls += 1;
      return { newValue: typeof value === "function" ? value() : value };
    },
  };
  return rotator;
}

/** A `provider` secret with a rotator attached — the adopter-supplied shape #322 describes. */
function provider(rotator: ValueRotator): SecretRegistryEntry {
  return {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    origin: { kind: "helped", issuer: "cloudflare", needs: { cloudflare: ["com.cloudflare.api.account"] } },
    rotation: { kind: "provider", issuer: "cloudflare" },
    rotator,
  };
}

/** A store that records what it was given and can be told to refuse. Never asserts on a value's content. */
function recordingStore(options: { refuse?: (env: ManagedEnvironment) => boolean } = {}): {
  store: SecretValueStore;
  writes: { env: ManagedEnvironment; value: string }[];
  attempts: number;
} {
  const state = {
    writes: [] as { env: ManagedEnvironment; value: string }[],
    attempts: 0,
    store: async (request: { env: ManagedEnvironment; value: string }) => {
      state.attempts += 1;
      if (options.refuse?.(request.env)) throw new Error(`${request.env} refused the write`);
      state.writes.push(request);
    },
  };
  return state;
}

const noSleep = async () => {};

describe("a manual secret", () => {
  test("gets an instruction and calls nothing", async () => {
    const store = recordingStore();
    const outcome = await rotateSecretValue({
      name: "AUTH_GITHUB_CREDENTIALS",
      entry: manual,
      targets: ["staging"],
      store: store.store,
    });
    expect(outcome).toMatchObject({ status: "unchanged", reason: "manual", kind: "manual", rolled: false });
    expect(outcome.recorded).toEqual([]);
    expect(store.attempts).toBe(0);
  });
});

describe("a dry run", () => {
  test("names what would happen and reaches neither the rotator nor the store", async () => {
    const rotator = countingRotator("never-issued");
    const store = recordingStore();
    const outcome = await rotateSecretValue({
      name: "CF_TOKEN",
      entry: provider(rotator),
      targets: ["prod"],
      store: store.store,
      dryRun: true,
    });
    expect(outcome).toMatchObject({ status: "unchanged", reason: "dry-run", rolled: false });
    expect(outcome.stranded).toEqual(["prod"]);
    // The whole value of a dry run at 2am: it proves nothing was rolled, rather than promising it.
    expect(rotator.calls).toBe(0);
    expect(store.attempts).toBe(0);
  });
});

describe("a local rotation", () => {
  test("mints a value, stores it, and reports the environments it reached", async () => {
    const store = recordingStore();
    const outcome = await rotateSecretValue({
      name: "EMAIL_LINK_SIGNING_KEY",
      entry: local,
      targets: DECLARED,
      store: store.store,
    });
    expect(outcome).toMatchObject({ status: "rotated", kind: "local", rolled: false });
    expect(outcome.recorded).toEqual(DECLARED);
    expect(outcome.stranded).toEqual([]);
    // One value across every target: that is what a fan-out of one rotation means, and two would be the
    // split `mintDeclaredSecrets` exists to refuse.
    expect(new Set(store.writes.map((write) => write.value)).size).toBe(1);
  });

  test("a store that will not take it is `failed`, not `unrecorded` — nothing was rolled anywhere", async () => {
    const store = recordingStore({ refuse: () => true });
    const outcome = await rotateSecretValue({
      name: "EMAIL_LINK_SIGNING_KEY",
      entry: local,
      targets: ["staging"],
      store: store.store,
      attempts: 2,
      sleep: noSleep,
    });
    // The distinction the exit codes turn on. A local mint touches no third party, so the previous value
    // is still live and the honest answer is "run it again" rather than "go to a console".
    expect(outcome.status).toBe("failed");
    expect(outcome.rolled).toBe(false);
    expect(outcome.stranded).toEqual(["staging"]);
  });
});

describe("a provider rotation", () => {
  test("rolls once and records it", async () => {
    const rotator = countingRotator("issued-1");
    const store = recordingStore();
    const outcome = await rotateSecretValue({
      name: "CF_TOKEN",
      entry: provider(rotator),
      targets: ["prod"],
      store: store.store,
    });
    expect(outcome).toMatchObject({ status: "rotated", kind: "provider", rolled: true });
    expect(outcome.recorded).toEqual(["prod"]);
    expect(rotator.calls).toBe(1);
  });

  /**
   * **The test the whole issue is written around.**
   *
   * The store is made to fail after the roll has succeeded. Two things must hold, and only the second is
   * obvious: the run must report `unrecorded` rather than `failed`, and the retries must have reused the
   * value the roll returned rather than asking for another. A rotator called twice here is the defect that
   * turns a recoverable store failure into a lost credential — caused by the retry meant to save it.
   */
  test("a store that will not take it is `unrecorded`, and the retries never roll again", async () => {
    let issued = 0;
    const rotator = countingRotator(() => `issued-${++issued}`);
    const store = recordingStore({ refuse: () => true });
    const outcome = await rotateSecretValue({
      name: "CF_TOKEN",
      entry: provider(rotator),
      targets: ["prod"],
      store: store.store,
      attempts: 3,
      sleep: noSleep,
    });

    expect(outcome.status).toBe("unrecorded");
    expect(outcome.rolled).toBe(true);
    expect(outcome.recorded).toEqual([]);
    expect(outcome.stranded).toEqual(["prod"]);
    expect(outcome.attempts).toBe(3);
    // The rotator answered, so this is a fact rather than a guess and the report may say *was rolled*.
    expect(outcome.rollFailed).toBeUndefined();
    // One roll, three store attempts. The second number moving is fine; the first is the incident.
    expect(rotator.calls).toBe(1);
    expect(store.attempts).toBe(3);
  });

  test("a partial fan-out names the environments still holding the retired credential", async () => {
    const rotator = countingRotator("issued-1");
    const store = recordingStore({ refuse: (env) => env === "prod" });
    const outcome = await rotateSecretValue({
      name: "CF_TOKEN",
      entry: { ...provider(rotator), scope: "global" },
      targets: DECLARED,
      store: store.store,
      attempts: 2,
      sleep: noSleep,
    });

    // Recorded somewhere is still unrecorded *there*, and there is where the dead credential is in use.
    expect(outcome.status).toBe("unrecorded");
    expect(outcome.recorded).toEqual(["staging"]);
    expect(outcome.stranded).toEqual(["prod"]);
    expect(rotator.calls).toBe(1);
  });

  test("a rotator that throws is `unrecorded` — it may have rolled, and `may have` needs a human", async () => {
    const store = recordingStore();
    const entry = provider({
      async roll() {
        throw new Error("the account rolled, then the connection dropped");
      },
    });
    const outcome = await rotateSecretValue({
      name: "CF_TOKEN",
      entry,
      targets: ["prod"],
      store: store.store,
    });
    expect(outcome.status).toBe("unrecorded");
    expect(outcome.rolled).toBe(true);
    // And flagged as a guess rather than a fact. The report reads *may have been rolled*, and the remedy
    // starts with checking the issuer — rolling again on one that already rolled makes a second orphan.
    expect(outcome.rollFailed).toBe(true);
    expect(store.attempts).toBe(0);
  });

  test("a rotator that answers with nothing usable is `unrecorded`, and nothing is stored", async () => {
    const store = recordingStore();
    const entry = provider({
      async roll() {
        return { newValue: "" };
      },
    });
    const outcome = await rotateSecretValue({ name: "CF_TOKEN", entry, targets: ["prod"], store: store.store });
    expect(outcome.status).toBe("unrecorded");
    // An empty string is not a credential, and writing one would replace a live value with nothing.
    expect(store.attempts).toBe(0);
  });
});

describe("what it refuses before anything is called", () => {
  /** Every refusal below must leave the store untouched — that is the property, not the message. */
  async function refusal(name: string, entry: SecretRegistryEntry, targets: ManagedEnvironment[] = ["staging"]) {
    const store = recordingStore();
    const error = await rotateSecretValue({ name, entry, targets, store: store.store }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(store.attempts).toBe(0);
    expect(error).toBeInstanceOf(PithyError);
    return error as PithyError;
  }

  test("a secret that declares no rotation", async () => {
    const error = await refusal("PAYMENTS_STRIPE", {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "text",
    });
    expect(error.payload.message).toContain("does not declare how it rotates");
  });

  test("a provider secret with no rotator names the issuer and both ways out", async () => {
    const error = await refusal("TURNSTILE_SECRET", {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "json",
      schema: z.object({ key: z.string().describe("The widget secret.") }).describe("A turnstile widget secret."),
      origin: { kind: "obtained", issuer: "cloudflare", documentation: "https://developers.cloudflare.com/turnstile/" },
      rotation: { kind: "provider", issuer: "cloudflare" },
    });
    expect(error.payload.message).toContain("cloudflare");
    expect(error.payload.action).toContain("pithy secrets update TURNSTILE_SECRET");
  });

  test("the master key, which every other secret is read through", async () => {
    const error = await refusal("SECRETS_ENCRYPTION_KEYS", {
      backend: "cf-secrets-store",
      scope: "global",
      rotatable: false,
      valueType: "json",
      bootstrap: true,
      schema: z.object({ currentVersion: z.string().describe("The active version.") }).describe("An EncryptionConfig."),
      origin: { kind: "minted", recipe: { kind: "encryptionConfig" } },
      rotation: { kind: "local" },
    });
    // Replacing it here would leave every stored secret sealed under a key nothing holds.
    expect(error.payload.message).toContain("every other secret is read through");
  });

  test("a keyspace", async () => {
    const error = await refusal("CONNECTION_SIGNING_KEY", {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "text",
      keyed: true,
    });
    expect(error.payload.message).toContain("keyspace");
  });
});

describe("the declaration and the code cannot disagree", () => {
  const rotator = countingRotator("x");

  test("a rotator on a local secret is refused at define time", () => {
    expect(() => defineSecretRegistry({ KEY: { ...local, rotator } })).toThrow(/rotation must be provider/);
  });

  test("a rotator on a manual secret is refused at define time", () => {
    expect(() => defineSecretRegistry({ KEY: { ...manual, rotator } })).toThrow(/rotation must be provider/);
  });

  test("a rotator on a provider secret is accepted", () => {
    expect(() => defineSecretRegistry({ KEY: provider(rotator) })).not.toThrow();
  });
});
