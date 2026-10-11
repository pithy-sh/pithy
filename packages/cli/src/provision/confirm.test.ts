// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { assertProvisionConfirmed, provisionConfirmPhrase } from "./confirm";

describe("assertProvisionConfirmed", () => {
  test("a non-production environment provisions on --yes alone", async () => {
    await expect(assertProvisionConfirmed({ env: "staging", yes: true, json: true })).resolves.toBeUndefined();
  });

  test("a non-production environment still needs --yes", async () => {
    await expect(assertProvisionConfirmed({ env: "staging", yes: false, json: true })).rejects.toThrow(PithyError);
  });

  /** The whole point: `--yes` is not enough for production, and never becomes enough. */
  test("--yes does not unlock production", async () => {
    const failure = await assertProvisionConfirmed({ env: "prod", yes: true, json: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toContain(provisionConfirmPhrase("prod"));
  });

  test("the exact phrase unlocks it", async () => {
    await expect(
      assertProvisionConfirmed({
        env: "prod",
        yes: true,
        json: true,
        confirmPhrase: provisionConfirmPhrase("prod"),
      }),
    ).resolves.toBeUndefined();
  });

  test("a wrong phrase is refused even with --yes", async () => {
    await expect(
      assertProvisionConfirmed({ env: "prod", yes: true, json: true, confirmPhrase: "yes" }),
    ).rejects.toThrow(PithyError);
  });

  /**
   * The phrase names its environment, so one typed for `staging` cannot be pasted into a command
   * targeting `prod` — the reason `pithy seed --redo`'s phrase is environment-specific too.
   */
  test("a phrase for another environment does not unlock this one", async () => {
    await expect(
      assertProvisionConfirmed({
        env: "prod",
        yes: true,
        json: true,
        confirmPhrase: provisionConfirmPhrase("staging"),
      }),
    ).rejects.toThrow(PithyError);
  });

  /** A project whose production environment is called `live` declares it, and is gated identically. */
  test("a declared production environment is gated by name, not by spelling", async () => {
    await expect(
      assertProvisionConfirmed({ env: "live", yes: true, json: true, productionEnvironments: ["live"] }),
    ).rejects.toThrow(PithyError);
    await expect(
      assertProvisionConfirmed({
        env: "live",
        yes: true,
        json: true,
        productionEnvironments: ["live"],
        confirmPhrase: provisionConfirmPhrase("live"),
      }),
    ).resolves.toBeUndefined();
  });

  test("an interactive operator can type the phrase instead of passing it", async () => {
    await expect(
      assertProvisionConfirmed({
        env: "prod",
        yes: true,
        json: false,
        prompt: async () => provisionConfirmPhrase("prod"),
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * **Nobody to ask and a wrong answer are two failures (#697).** A production provision with no phrase and
 * no prompt fails `input/required`, naming `--confirm`; a phrase that was typed and is wrong stays
 * `validation/invalid_input`, because the caller has already answered.
 */
describe("assertProvisionConfirmed's refusals, by kind", () => {
  /** The payload a run rejected with. */
  async function payloadOf(run: Promise<void>): Promise<Record<string, unknown>> {
    const failure = await run.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    return (failure as PithyError).payload as unknown as Record<string, unknown>;
  }

  test("production with no phrase and nobody to ask is input/required, naming --confirm", async () => {
    expect(await payloadOf(assertProvisionConfirmed({ env: "prod", yes: true, json: true }))).toMatchObject({
      code: "input/required",
      flag: "--confirm",
      action: `Pass --confirm "${provisionConfirmPhrase("prod")}".`,
    });
  });

  test("a prompt is never asked under --json, even when one is supplied", async () => {
    let asked = false;
    const payload = await payloadOf(
      assertProvisionConfirmed({
        env: "prod",
        yes: true,
        json: true,
        prompt: async () => {
          asked = true;
          return provisionConfirmPhrase("prod");
        },
      }),
    );
    expect(payload.code).toBe("input/required");
    expect(asked).toBe(false);
  });

  test("a wrong --confirm is invalid input, not a missing answer", async () => {
    const payload = await payloadOf(
      assertProvisionConfirmed({ env: "prod", yes: true, json: true, confirmPhrase: "yes" }),
    );
    expect(payload.code).toBe("validation/invalid_input");
    expect(payload).not.toHaveProperty("flag");
  });

  test("a wrong phrase typed at the prompt is invalid input too", async () => {
    const payload = await payloadOf(
      assertProvisionConfirmed({ env: "prod", yes: true, json: false, prompt: async () => "yes" }),
    );
    expect(payload).toMatchObject({
      code: "validation/invalid_input",
      message: "Provisioning prod was not confirmed.",
    });
  });
});
