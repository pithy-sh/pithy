// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { defineSeed } from "@pithy-sh/core/src/seed/seed";
import { describe, expect, test, vi } from "vitest";
import {
  assertResetConfirmed,
  assertSeedConfirmed,
  assertSetAllowedForEnv,
  isProductionEnv,
  PRODUCTION_CONFIRM_PHRASE,
  resetConfirmPhrase,
} from "./safety";

describe("assertSetAllowedForEnv", () => {
  const set = defineSeed({ name: "demo", order: 100, environments: ["dev", "staging"] });

  test("passes for a listed environment", () => {
    expect(() => assertSetAllowedForEnv(set, "staging")).not.toThrow();
  });

  test("refuses a disallowed environment with an actionable error", () => {
    expect(() => assertSetAllowedForEnv(set, "prod")).toThrow(PithyError);
    expect(() => assertSetAllowedForEnv(set, "prod")).toThrow(/not allowed in prod/);
  });
});

describe("assertSeedConfirmed", () => {
  test("dev runs freely, with no --yes", async () => {
    await expect(assertSeedConfirmed({ env: "dev", yes: false, json: false })).resolves.toBeUndefined();
  });

  test("staging requires --yes", async () => {
    const failure = await assertSeedConfirmed({ env: "staging", yes: false, json: false }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toMatch(/--yes/);
    await expect(assertSeedConfirmed({ env: "staging", yes: true, json: false })).resolves.toBeUndefined();
  });

  test("a non-dev custom environment escalates like staging — just --yes", async () => {
    await expect(assertSeedConfirmed({ env: "preview", yes: false, json: false })).rejects.toThrow(PithyError);
    await expect(assertSeedConfirmed({ env: "preview", yes: true, json: false })).resolves.toBeUndefined();
  });

  test("production requires --yes even with the phrase", async () => {
    const failure = await assertSeedConfirmed({
      env: "prod",
      yes: false,
      json: false,
      confirmProduction: PRODUCTION_CONFIRM_PHRASE,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toMatch(/--yes/);
  });

  test("production unlocks with the exact --confirm-production phrase (case-insensitive, trimmed)", async () => {
    await expect(
      assertSeedConfirmed({
        env: "prod",
        yes: true,
        json: true,
        confirmProduction: `  ${PRODUCTION_CONFIRM_PHRASE.toUpperCase()}  `,
      }),
    ).resolves.toBeUndefined();
  });

  test("production refuses a wrong --confirm-production phrase", async () => {
    await expect(
      assertSeedConfirmed({ env: "prod", yes: true, json: false, confirmProduction: "yes please" }),
    ).rejects.toThrow(/did not match/);
  });

  test("production in --json without the flag is refused — no prompt is shown", async () => {
    const prompt = vi.fn(async () => PRODUCTION_CONFIRM_PHRASE);
    await expect(assertSeedConfirmed({ env: "prod", yes: true, json: true, prompt })).rejects.toThrow(
      /explicit confirmation phrase/,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  test("production interactively prompts for the phrase and accepts a correct answer", async () => {
    const prompt = vi.fn(async () => `  ${PRODUCTION_CONFIRM_PHRASE}  `);
    await expect(assertSeedConfirmed({ env: "prod", yes: true, json: false, prompt })).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledOnce();
  });

  test("production interactively refuses a wrong answer", async () => {
    const prompt = vi.fn(async () => "nope");
    await expect(assertSeedConfirmed({ env: "prod", yes: true, json: false, prompt })).rejects.toThrow(/did not match/);
  });

  test("a non-canonical prod env name still needs the phrase — --yes alone is refused", async () => {
    // `prod` and `Production` are production-grade: --yes must not be enough to seed them.
    await expect(assertSeedConfirmed({ env: "prod", yes: true, json: true })).rejects.toThrow(
      /explicit confirmation phrase/,
    );
    await expect(assertSeedConfirmed({ env: "Production", yes: true, json: true })).rejects.toThrow(
      /explicit confirmation phrase/,
    );
    // The exact phrase still unlocks it.
    await expect(
      assertSeedConfirmed({ env: "prod", yes: true, json: true, confirmProduction: PRODUCTION_CONFIRM_PHRASE }),
    ).resolves.toBeUndefined();
  });

  test("a project-declared production env name is gated by the phrase, not --yes alone", async () => {
    // `live` is not a built-in prod name; without config it would pass on --yes (the old gap). Declared
    // in `seed.productionEnvironments`, it now demands the phrase like the canonical names.
    const productionEnvironments = ["live", "prod-eu"];
    await expect(assertSeedConfirmed({ env: "live", yes: true, json: true, productionEnvironments })).rejects.toThrow(
      /explicit confirmation phrase/,
    );
    // Case-insensitive match against the declared list.
    await expect(
      assertSeedConfirmed({ env: "PROD-EU", yes: true, json: true, productionEnvironments }),
    ).rejects.toThrow(/explicit confirmation phrase/);
    // The exact phrase unlocks a declared production env.
    await expect(
      assertSeedConfirmed({
        env: "live",
        yes: true,
        json: true,
        productionEnvironments,
        confirmProduction: PRODUCTION_CONFIRM_PHRASE,
      }),
    ).resolves.toBeUndefined();
  });

  test("an undeclared non-canonical env still escalates only to --yes", async () => {
    // `live` is production-grade only if the project says so; undeclared, it stays a staging-like env.
    await expect(assertSeedConfirmed({ env: "live", yes: true, json: true })).resolves.toBeUndefined();
  });
});

describe("isProductionEnv", () => {
  test("recognizes production and prod, case-insensitively and trimmed", () => {
    for (const env of ["prod", "prod", "PROD", " Production "]) expect(isProductionEnv(env)).toBe(true);
  });

  test("treats every other env as non-prod by default", () => {
    for (const env of ["dev", "staging", "preview", "prod-eu"]) expect(isProductionEnv(env)).toBe(false);
  });

  test("recognizes project-declared production env names, unioned with the built-ins and case-insensitive", () => {
    const declared = ["live", "Prod-EU"];
    for (const env of ["live", "LIVE", " prod-eu "]) expect(isProductionEnv(env, declared)).toBe(true);
    // Built-ins still win regardless of the declared list.
    expect(isProductionEnv("prod", declared)).toBe(true);
    // An env neither built-in nor declared stays non-prod.
    expect(isProductionEnv("preview", declared)).toBe(false);
  });
});

/** The payload a run rejected with. */
async function payloadOf(run: Promise<void>): Promise<Record<string, unknown>> {
  const failure = await run.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PithyError);
  return (failure as PithyError).payload as unknown as Record<string, unknown>;
}

/**
 * **A confirmation phrase is a person's to give (#697).** Missing with nobody to ask, mistyped by flag, or
 * mistyped at the prompt, every refusal at the phrase is `core/person_required` — exit 5, so an agent stops
 * and asks rather than trying variations. The action line still names the flag, for the person.
 */
describe("assertSeedConfirmed's refusals, by kind", () => {
  test("production with no phrase and nobody to ask needs a person, and the action names --confirm-production", async () => {
    expect(await payloadOf(assertSeedConfirmed({ env: "prod", yes: true, json: true }))).toMatchObject({
      code: "core/person_required",
      action: `Pass --confirm-production "${PRODUCTION_CONFIRM_PHRASE}" to seed production.`,
    });
    expect((await payloadOf(assertSeedConfirmed({ env: "prod", yes: true, json: false }))).code).toBe(
      "core/person_required",
    );
  });

  test("a wrong --confirm-production needs a person too", async () => {
    const payload = await payloadOf(
      assertSeedConfirmed({ env: "prod", yes: true, json: true, confirmProduction: "yes please" }),
    );
    expect(payload.code).toBe("core/person_required");
  });

  test("a wrong phrase typed at the prompt needs a person, and still says it did not match", async () => {
    const payload = await payloadOf(
      assertSeedConfirmed({ env: "prod", yes: true, json: false, prompt: async () => "no" }),
    );
    expect(payload).toMatchObject({
      code: "core/person_required",
      message: "The production confirmation phrase did not match.",
    });
  });
});

describe("assertResetConfirmed", () => {
  test("dev resets freely", async () => {
    await expect(assertResetConfirmed({ env: "dev", json: true })).resolves.toBeUndefined();
  });

  test("no phrase and nobody to ask needs a person, and the action names --confirm-reset", async () => {
    expect(await payloadOf(assertResetConfirmed({ env: "staging", json: true }))).toMatchObject({
      code: "core/person_required",
      message: "Resetting staging destroys all of its data.",
      action: `Pass --confirm-reset "${resetConfirmPhrase("staging")}" to drop and recreate the staging schema.`,
    });
  });

  test("--json never asks, even when a prompt is supplied", async () => {
    const prompt = vi.fn(async () => resetConfirmPhrase("staging"));
    expect((await payloadOf(assertResetConfirmed({ env: "staging", json: true, prompt }))).code).toBe(
      "core/person_required",
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  test("a wrong --confirm-reset needs a person", async () => {
    const payload = await payloadOf(
      assertResetConfirmed({ env: "staging", json: true, confirmReset: resetConfirmPhrase("prod") }),
    );
    expect(payload).toMatchObject({
      code: "core/person_required",
      message: "That is not the confirmation phrase for resetting staging.",
    });
  });

  test("a wrong phrase typed at the prompt needs a person", async () => {
    const payload = await payloadOf(assertResetConfirmed({ env: "staging", json: false, prompt: async () => "nope" }));
    expect(payload).toMatchObject({ code: "core/person_required", message: "Reset of staging not confirmed." });
  });

  test("the exact phrase unlocks it, by flag or at the prompt", async () => {
    await expect(
      assertResetConfirmed({ env: "staging", json: true, confirmReset: resetConfirmPhrase("staging") }),
    ).resolves.toBeUndefined();
    await expect(
      assertResetConfirmed({ env: "staging", json: false, prompt: async () => ` ${resetConfirmPhrase("staging")} ` }),
    ).resolves.toBeUndefined();
  });
});
