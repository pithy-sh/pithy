// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type ActualColumn, schemaDrift, snake } from "./schemaDrift";

/** A column that accepts an insert which omits it. */
function optional(name: string): ActualColumn {
  return { name, notNull: false, hasDefault: false };
}

/** A column that refuses an insert which omits it. */
function required(name: string): ActualColumn {
  return { name, notNull: true, hasDefault: false };
}

const ACCOUNT = { pithyAuthAccounts: { fields: { accountId: {}, providerId: {}, userId: {} } } };

describe("schemaDrift", () => {
  test("a table that holds exactly what Better Auth writes has no drift", () => {
    expect(
      schemaDrift(ACCOUNT, {
        pithy_auth_accounts: [optional("id"), required("account_id"), required("provider_id"), required("user_id")],
      }),
    ).toEqual([]);
  });

  test("a column Better Auth writes and the table lacks is drift (#451)", () => {
    expect(
      schemaDrift(ACCOUNT, { pithy_auth_accounts: [optional("id"), required("account_id"), required("user_id")] }),
    ).toEqual(["pithy_auth_accounts.provider_id: missing"]);
  });

  test("a NOT NULL column with no default that Better Auth never writes is drift (#787)", () => {
    // The shape that broke every sign-in on 1.7.3: `0001_init` required `issuer`, and nothing wrote it.
    expect(
      schemaDrift(ACCOUNT, {
        pithy_auth_accounts: [
          optional("id"),
          required("issuer"),
          required("account_id"),
          required("provider_id"),
          required("user_id"),
        ],
      }),
    ).toEqual(["pithy_auth_accounts.issuer: required, and Better Auth never writes it"]);
  });

  test("a column Better Auth never writes is fine when an insert can omit it", () => {
    // Nullable is what `0003` leaves `issuer`; a default is the other way out the upgrade guide names.
    expect(
      schemaDrift(ACCOUNT, {
        pithy_auth_accounts: [
          optional("id"),
          optional("issuer"),
          { name: "tier", notNull: true, hasDefault: true },
          required("account_id"),
          required("provider_id"),
          required("user_id"),
        ],
      }),
    ).toEqual([]);
  });

  test("a model with no table is one finding, not one per column", () => {
    expect(schemaDrift(ACCOUNT, {})).toEqual(["pithy_auth_accounts: no such table"]);
    expect(schemaDrift(ACCOUNT, { pithy_auth_accounts: [] })).toEqual(["pithy_auth_accounts: no such table"]);
  });

  test("a renamed field is compared by the column name it writes", () => {
    const renamed = { pithyAuthAccounts: { fields: { accountId: { fieldName: "subject" } } } };
    expect(schemaDrift(renamed, { pithy_auth_accounts: [optional("id"), required("subject")] })).toEqual([]);
  });

  test("snake-cases the way CamelCasePlugin does", () => {
    expect(snake("pithyAuthRateLimit")).toBe("pithy_auth_rate_limit");
    expect(snake("accessTokenExpiresAt")).toBe("access_token_expires_at");
    expect(snake("id")).toBe("id");
  });
});
