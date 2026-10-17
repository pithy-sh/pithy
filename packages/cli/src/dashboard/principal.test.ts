// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { type RegisteringPrincipalSeams, requireRegisteringPrincipal } from "./principal";

/**
 * The one rule every registration goes through (#721): who sanctioned this credential is read from a
 * signed-in session, never typed, and without one nothing is registered — in every environment.
 */

const SESSION_TOKEN = "oauth-access-token";
const ACCOUNT_TOKEN = "cfat_0123456789";

function seams(overrides: Partial<RegisteringPrincipalSeams> = {}): RegisteringPrincipalSeams {
  return {
    credentials: () => ({ accountId: "acc_1", apiToken: SESSION_TOKEN }),
    isSession: (token) => token === SESSION_TOKEN,
    getUser: async () => ({ id: "cf-user-1", email: "ada@example.com" }),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("requireRegisteringPrincipal", () => {
  test("records the signed-in session's email, which nobody typed", async () => {
    expect(await requireRegisteringPrincipal({ account: null }, seams())).toBe("ada@example.com");
  });

  test("refuses an account token, and names the sign-in", async () => {
    const error = await refusal(
      requireRegisteringPrincipal(
        { account: null },
        seams({ credentials: () => ({ accountId: "acc_1", apiToken: ACCOUNT_TOKEN }) }),
      ),
    );
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.message).toMatch(/signed-in session/);
    expect(error.payload.action).toContain("pithy cloudflare connect");
  });

  test("never asks an account token who it is — a token name cannot leave an organization", async () => {
    let asked = false;
    await refusal(
      requireRegisteringPrincipal(
        { account: null },
        seams({
          credentials: () => ({ accountId: "acc_1", apiToken: ACCOUNT_TOKEN }),
          getUser: async () => {
            asked = true;
            return { email: "ci@example.com" };
          },
        }),
      ),
    );
    expect(asked).toBe(false);
  });

  test("refuses when there is no credential at all, and names the sign-in", async () => {
    const error = await refusal(requireRegisteringPrincipal({ account: null }, seams({ credentials: () => null })));
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.action).toContain("pithy cloudflare connect");
  });

  test("refuses a session that names no email", async () => {
    const error = await refusal(
      requireRegisteringPrincipal({ account: null }, seams({ getUser: async () => ({ id: "cf-user-1" }) })),
    );
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.action).toContain("pithy cloudflare connect");
  });

  test("refuses a session whose email is not one, rather than recording whatever came back", async () => {
    const error = await refusal(
      requireRegisteringPrincipal({ account: null }, seams({ getUser: async () => ({ email: "not an address" }) })),
    );
    expect(error.payload.code).toBe("core/precondition_failed");
  });

  test("refuses when Cloudflare cannot be asked, and keeps the reason", async () => {
    const error = await refusal(
      requireRegisteringPrincipal(
        { account: null },
        seams({
          getUser: async () => {
            throw new Error("socket hang up");
          },
        }),
      ),
    );
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.detail).toContain("socket hang up");
  });

  test("lets a credential fault through as itself, so a mismatched account reads as one", async () => {
    const mismatch = new ConflictError({ message: "Wrong account." });
    const error = await refusal(
      requireRegisteringPrincipal(
        { account: null },
        seams({
          credentials: () => {
            throw mismatch;
          },
        }),
      ),
    );
    expect(error).toBe(mismatch);
  });
});
