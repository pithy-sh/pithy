// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { CamelCasePlugin } from "kysely";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  defineSecretTable,
  isSecretTableKeyName,
  isSecretTableName,
  type SecretTableOwner,
  type SecretTableOwnerPredicate,
  type SecretTableSecretName,
  type SecretTableValue,
  secretTableContext,
  secretTableIdentifier,
  secretTableOwner,
  secretTablePredicate,
  secretTableRow,
  snakeCase,
} from "./defineSecretTable";

const Webhook = z
  .object({ secret: z.string().meta({ multiline: false }).describe("The signing secret.") })
  .describe("A webhook signing bundle.");

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: {
    userId: z.string().describe("The user the secret belongs to."),
    organizationId: z.string().describe("The organization the user belongs to."),
  },
  secrets: {
    STRIPE_KEY: { valueType: "text", rotatable: true, rotateEveryDays: 90 },
    WEBHOOK_SIG: { valueType: "json", schema: Webhook, rotatable: true },
  },
});

/** The error a call threw, for assertions about its payload. Fails if it threw nothing. */
function thrown(call: () => unknown): PithyError {
  try {
    call();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("defineSecretTable", () => {
  test("names the table it generates, in camelCase for Kysely and snake_case for SQL", () => {
    expect(CustomerSecrets.identifier).toBe("pithySecretsCustomerSecrets");
    expect(CustomerSecrets.sqlName).toBe("pithy_secrets_customer_secrets");
    expect(CustomerSecrets.keyNames).toEqual(["userId", "organizationId"]);
    expect(CustomerSecrets.secretNames).toEqual(["STRIPE_KEY", "WEBHOOK_SIG"]);
  });

  test("a camelCase name snake-cases the way CamelCasePlugin does", () => {
    const table = defineSecretTable({
      name: "billingAccount",
      keys: { accountId: z.string().describe("The account.") },
      secrets: { KEY: { valueType: "text", rotatable: false } },
    });
    expect(table.sqlName).toBe("pithy_secrets_billing_account_secrets");
  });

  test("derives the SQL name through CamelCasePlugin itself, so the migration and every lookup agree", () => {
    // The migration creates the table through the plugin; a sweep looks it up by `sqlName`. One conversion.
    class Probe extends CamelCasePlugin {
      sql(identifier: string): string {
        return this.snakeCase(identifier);
      }
    }
    for (const identifier of ["pithySecretsBillingAccountSecrets", "pithySecretsCustomerAPISecrets", "userID"]) {
      expect(snakeCase(identifier)).toBe(new Probe().sql(identifier));
    }
  });

  test("refuses a name or a key with a run of capitals — one that would not come back from snake_case as itself", () => {
    // `customerAPI` becomes `pithy_secrets_customer_apisecrets`, which reads back as `customerApisecrets`, and a
    // registry row naming it would look up a table nobody created. A row's key columns come back camel-cased
    // the same way, so `userID` would read back as `userId` and every row would lose its owner.
    for (const name of ["customerAPI", "aB", "a"]) {
      expect(isSecretTableName(name)).toBe(false);
      const error = thrown(() =>
        defineSecretTable({
          name,
          keys: { userId: z.string().describe("The user.") },
          secrets: { KEY: { valueType: "text", rotatable: false } },
        }),
      );
      expect(error).toBeInstanceOf(InternalError);
      expect(error.payload.message).toContain("capitals");
    }
    expect(isSecretTableKeyName("userID")).toBe(false);
    const key = thrown(() =>
      defineSecretTable({
        name: "customer",
        keys: { userID: z.string().describe("The user.") },
        secrets: { KEY: { valueType: "text", rotatable: false } },
      }),
    );
    expect(key.payload.message).toContain("userID");
    expect(isSecretTableName("customerApi")).toBe(true);
    expect(snakeCase(secretTableIdentifier("customerApi"))).toBe("pithy_secrets_customer_api_secrets");
  });

  test("refuses the cf-secrets-store backend, naming why", () => {
    const error = thrown(() =>
      defineSecretTable({
        name: "customer",
        keys: { userId: z.string().describe("The user.") },
        secrets: { STRIPE_KEY: { valueType: "text", rotatable: false, backend: "cf-secrets-store" } },
      }),
    );
    expect(error).toBeInstanceOf(InternalError);
    expect(error.payload.message).toContain("STRIPE_KEY");
    expect(error.payload.message).toContain("build time");
  });

  test("accepts the d1 backend stated explicitly", () => {
    expect(() =>
      defineSecretTable({
        name: "customer",
        keys: { userId: z.string().describe("The user.") },
        secrets: { STRIPE_KEY: { valueType: "text", rotatable: false, backend: "d1" } },
      }),
    ).not.toThrow();
  });

  test.each([
    ["an empty name", ""],
    ["a name with an underscore", "customer_billing"],
    ["a name starting with a digit", "1customer"],
    ["a name starting upper-case", "Customer"],
  ])("refuses %s", (_label, name) => {
    expect(() =>
      defineSecretTable({
        name,
        keys: { userId: z.string().describe("The user.") },
        secrets: { KEY: { valueType: "text", rotatable: false } },
      }),
    ).toThrow(InternalError);
  });

  test("refuses a table with no keys — an owner is the point of a declared table", () => {
    expect(() =>
      defineSecretTable({ name: "customer", keys: {}, secrets: { KEY: { valueType: "text", rotatable: false } } }),
    ).toThrow(/at least one key/);
  });

  test("refuses a table with no secrets", () => {
    expect(() =>
      defineSecretTable({ name: "customer", keys: { userId: z.string().describe("The user.") }, secrets: {} }),
    ).toThrow(/at least one secret/);
  });

  test.each(["id", "name", "encryptedValue", "iv", "keyVersion", "valueType", "createdAt", "updatedAt"])(
    "refuses a key named %s, which is a base column",
    (key) => {
      expect(() =>
        defineSecretTable({
          name: "customer",
          keys: { [key]: z.string().describe("Shadowing.") },
          secrets: { KEY: { valueType: "text", rotatable: false } },
        }),
      ).toThrow(/base column/);
    },
  );

  test("refuses a key name that is not a camelCase identifier", () => {
    expect(() =>
      defineSecretTable({
        name: "customer",
        keys: { user_id: z.string().describe("The user.") },
        secrets: { KEY: { valueType: "text", rotatable: false } },
      }),
    ).toThrow(InternalError);
  });

  test("refuses a key that is not a Zod schema", () => {
    expect(() =>
      defineSecretTable({
        name: "customer",
        keys: { userId: "string" as unknown as z.ZodString },
        secrets: { KEY: { valueType: "text", rotatable: false } },
      }),
    ).toThrow(/Zod schema/);
  });

  test("refuses a secret name carrying a separator or a space", () => {
    for (const name of ["STRIPE/KEY", "STRIPE KEY", ""]) {
      expect(() =>
        defineSecretTable({
          name: "customer",
          keys: { userId: z.string().describe("The user.") },
          secrets: { [name]: { valueType: "text", rotatable: false } },
        }),
      ).toThrow(InternalError);
    }
  });

  test("refuses a json secret with no schema, and a bad cadence", () => {
    expect(() =>
      defineSecretTable({
        name: "customer",
        keys: { userId: z.string().describe("The user.") },
        secrets: { KEY: { valueType: "json", rotatable: false } as never },
      }),
    ).toThrow(/Zod schema/);
    expect(() =>
      defineSecretTable({
        name: "customer",
        keys: { userId: z.string().describe("The user.") },
        secrets: { KEY: { valueType: "text", rotatable: true, rotateEveryDays: 0 } },
      }),
    ).toThrow(/rotateEveryDays/);
    expect(() =>
      defineSecretTable({
        name: "customer",
        keys: { userId: z.string().describe("The user.") },
        secrets: { KEY: { valueType: "text", rotatable: "yes" as unknown as boolean } },
      }),
    ).toThrow(/rotatable/);
  });

  test("types the owner, the predicate, the names and the values from the declaration", () => {
    type T = typeof CustomerSecrets;
    expectTypeOf<SecretTableOwner<T>>().toEqualTypeOf<{ userId: string; organizationId: string }>();
    expectTypeOf<SecretTableOwnerPredicate<T>>().toEqualTypeOf<{ userId?: string; organizationId?: string }>();
    expectTypeOf<SecretTableSecretName<T>>().toEqualTypeOf<"STRIPE_KEY" | "WEBHOOK_SIG">();
    expectTypeOf<SecretTableValue<T, "STRIPE_KEY">>().toEqualTypeOf<string>();
    expectTypeOf<SecretTableValue<T, "WEBHOOK_SIG">>().toEqualTypeOf<{ secret: string }>();
  });
});

describe("secretTableOwner", () => {
  test("validates every declared key and returns them", () => {
    expect(secretTableOwner(CustomerSecrets, { userId: "u1", organizationId: "o1" })).toEqual({
      userId: "u1",
      organizationId: "o1",
    });
  });

  test("refuses a missing key and an undeclared key, naming the key and never the value", () => {
    const missing = thrown(() => secretTableOwner(CustomerSecrets, { userId: "u1" }));
    expect(missing).toBeInstanceOf(ValidationError);
    expect(missing.payload.detail).toContain("organizationId");

    const extra = thrown(() => secretTableOwner(CustomerSecrets, { userId: "u1", organizationId: "o1", teamId: "t" }));
    expect(extra.payload.detail).toContain("teamId");
  });

  test("takes an empty key beside a set one — what every row holds in a key added after it was written", () => {
    // An alter adds a key as `text not null default ''`, and an empty key is left out of the bound context,
    // so a row written before the key existed is addressed — and opens — with that key empty.
    expect(secretTableOwner(CustomerSecrets, { userId: "u1", organizationId: "" })).toEqual({
      userId: "u1",
      organizationId: "",
    });
    const nobody = thrown(() => secretTableOwner(CustomerSecrets, { userId: "", organizationId: "" }));
    expect(nobody).toBeInstanceOf(ValidationError);
    expect(nobody.payload.message).toContain("at least one key");
  });

  test("a new row runs every key through its schema — the empty exemption reaches existing rows only", () => {
    const Strict = defineSecretTable({
      name: "member",
      keys: {
        userId: z.string().min(1).describe("The user."),
        organizationId: z.string().uuid().describe("The organization."),
      },
      secrets: { KEY: { valueType: "text", rotatable: false } },
    });
    const owner = { userId: "u1", organizationId: "" };
    // Addressing: `""` reaches a row written before the key existed, and nothing else holds one.
    expect(secretTableOwner(Strict, owner)).toEqual(owner);
    // Creating: the adopter's schema decides, and a uuid key refuses `""`.
    const error = thrown(() => secretTableOwner(Strict, owner, { creating: true }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.payload.detail).toContain("organizationId");
  });

  test("runs the declared schema, so a key's own rule holds at the call", () => {
    const Strict = defineSecretTable({
      name: "connection",
      keys: { installationId: z.string().uuid().describe("The installation.") },
      secrets: { SIGNING_KEY: { valueType: "text", rotatable: true } },
    });
    const error = thrown(() => secretTableOwner(Strict, { installationId: "not-a-uuid-secret-looking-value" }));
    expect(error.payload.detail).toContain("installationId");
    expect(JSON.stringify(error.payload)).not.toContain("not-a-uuid-secret-looking-value");
  });
});

describe("secretTablePredicate", () => {
  test("keeps the keys that were given and drops undefined ones", () => {
    expect(secretTablePredicate(CustomerSecrets, { organizationId: "o1", userId: undefined })).toEqual({
      organizationId: "o1",
    });
  });

  test("refuses an empty predicate — no owner is not an owner", () => {
    const error = thrown(() => secretTablePredicate(CustomerSecrets, {}));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.payload.message).toContain("at least one key");
    // Nor is one made only of empty keys: `{ teamId: "" }` would match every row written before teamId existed.
    expect(() => secretTablePredicate(CustomerSecrets, { userId: "" })).toThrow(ValidationError);
    expect(secretTablePredicate(CustomerSecrets, { userId: "", organizationId: "o1" })).toEqual({
      userId: "",
      organizationId: "o1",
    });
  });

  test("refuses an undeclared key", () => {
    expect(() => secretTablePredicate(CustomerSecrets, { teamId: "t" })).toThrow(ValidationError);
  });
});

describe("secretTableContext", () => {
  test("binds the table, the owner and the secret name, independent of key order", () => {
    const one = secretTableContext("customer", { userId: "u1", organizationId: "o1" }, "STRIPE_KEY");
    const two = secretTableContext("customer", { organizationId: "o1", userId: "u1" }, "STRIPE_KEY");
    expect(one).toBe(two);
    expect(one).not.toBe(secretTableContext("customer", { userId: "u2", organizationId: "o1" }, "STRIPE_KEY"));
    expect(one).not.toBe(secretTableContext("customer", { userId: "u1", organizationId: "o1" }, "WEBHOOK_SIG"));
    expect(one).not.toBe(secretTableContext("other", { userId: "u1", organizationId: "o1" }, "STRIPE_KEY"));
  });

  test("leaves an empty key out, so a key column added later does not change a stored row's context", () => {
    expect(secretTableContext("customer", { userId: "u1", teamId: "" }, "KEY")).toBe(
      secretTableContext("customer", { userId: "u1" }, "KEY"),
    );
  });

  test("cannot collide by composition: a value containing a separator is still one value", () => {
    expect(secretTableContext("customer", { userId: "a", organizationId: "b" }, "KEY")).not.toBe(
      secretTableContext("customer", { userId: 'a","organizationId', organizationId: "b" }, "KEY"),
    );
  });
});

describe("secretTableRow", () => {
  test("is the base row plus one described text column per key", () => {
    const row = secretTableRow(CustomerSecrets);
    expect(Object.keys(row.shape)).toEqual([
      "id",
      "name",
      "encryptedValue",
      "iv",
      "keyVersion",
      "valueType",
      "createdAt",
      "updatedAt",
      "userId",
      "organizationId",
    ]);
    for (const field of Object.values(row.shape)) expect((field as z.ZodType).description).toBeTruthy();
    expect(row.description).toContain("pithy_secrets_customer_secrets");
  });
});
