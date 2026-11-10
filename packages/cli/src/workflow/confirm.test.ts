// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { assertTriggerConfirmed, triggerConfirmPhrase } from "./confirm";

/** The refusal a gate threw, so a test reads its code and lines. */
async function refusal(run: Promise<void>): Promise<PithyError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("triggerConfirmPhrase", () => {
  test("names the environment, so a phrase typed for one cannot unlock another", () => {
    expect(triggerConfirmPhrase("prod")).toBe("yes, i really want to trigger prod");
    expect(triggerConfirmPhrase(" Live ")).toBe("yes, i really want to trigger live");
  });
});

describe("assertTriggerConfirmed", () => {
  test("an environment that is not production needs nothing", async () => {
    await expect(assertTriggerConfirmed({ env: "staging", json: true })).resolves.toBeUndefined();
  });

  test("production with the phrase by flag runs, in any case and spacing", async () => {
    await expect(
      assertTriggerConfirmed({ env: "prod", json: true, confirmPhrase: "  YES, I really want to trigger prod " }),
    ).resolves.toBeUndefined();
  });

  test("production with no phrase and nobody to ask is a person's decision", async () => {
    const error = await refusal(assertTriggerConfirmed({ env: "prod", json: true }));
    expect(error.payload.code).toBe("core/person_required");
    expect(error.message).toBe("prod is a production environment.");
    expect(error.payload.action).toBe('Pass --confirm "yes, i really want to trigger prod".');
  });

  test("a wrong phrase is refused, and the prompt is never asked", async () => {
    let asked = false;
    const error = await refusal(
      assertTriggerConfirmed({
        env: "prod",
        json: false,
        confirmPhrase: "yes, i really want to trigger staging",
        prompt: async () => {
          asked = true;
          return "yes, i really want to trigger prod";
        },
      }),
    );
    expect(asked).toBe(false);
    expect(error.payload.code).toBe("core/person_required");
    expect(error.message).toBe("That is not the confirmation phrase for triggering a Workflow in prod.");
  });

  test("at a terminal the phrase may be typed", async () => {
    await expect(
      assertTriggerConfirmed({ env: "prod", json: false, prompt: async () => "yes, i really want to trigger prod" }),
    ).resolves.toBeUndefined();
    const error = await refusal(assertTriggerConfirmed({ env: "prod", json: false, prompt: async () => "yes" }));
    expect(error.message).toBe("Triggering a Workflow in prod was not confirmed.");
  });

  test("an environment the project declares as production is gated too", async () => {
    const error = await refusal(assertTriggerConfirmed({ env: "live", json: true, productionEnvironments: ["live"] }));
    expect(error.payload.code).toBe("core/person_required");
  });
});
