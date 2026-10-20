// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import { ACCOUNT_DELETED, ACCOUNT_SUSPENDED, accountRefusal } from "./lifecycle";

describe("the account refusal codes a screen branches on", () => {
  test("are the kit's own codes, both in the taxonomy at 403", () => {
    const members = KitErrorPayload.options.map((member) => [member.shape.code.value, member.shape.status.value]);
    expect(members).toContainEqual([ACCOUNT_SUSPENDED, 403]);
    expect(members).toContainEqual([ACCOUNT_DELETED, 403]);
  });

  test("accountRefusal names which, and nothing else", () => {
    expect(accountRefusal(ACCOUNT_SUSPENDED)).toBe("suspended");
    expect(accountRefusal(ACCOUNT_DELETED)).toBe("deleted");
    for (const other of [null, undefined, "", "auth/forbidden", "provider_sign_in_refused", "AUTH/ACCOUNT_DELETED"]) {
      expect(accountRefusal(other)).toBeNull();
    }
  });
});
