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
