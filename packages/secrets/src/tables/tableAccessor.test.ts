// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineSecretRegistry } from "../registry";
import { SecretsAccessor } from "../secretsStore";
import { defineSecretTable } from "./defineSecretTable";
import { SecretTableAccessor, type SecretTableIO } from "./tableAccessor";

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: {
    userId: z.string().describe("The user."),
    organizationId: z.string().describe("The organization."),
  },
  secrets: {
    STRIPE_KEY: { valueType: "text", rotatable: true },
    WEBHOOK_SIG: {
      valueType: "json",
      schema: z.object({ secret: z.string().meta({ multiline: false }).describe("The secret.") }).describe("A bundle."),
      rotatable: false,
    },
  },
});

/** I/O that is never reached: these tests are about what compiles and what is refused before the store. */
const unreachable: SecretTableIO = async () => {
  throw new Error("the store was opened");
};

describe(".table(T) — what compiles", () => {
  test("accepts only declared secret names and only declared key fields", () => {
    const t = new SecretTableAccessor(CustomerSecrets, unreachable);
    const owner = { userId: "u", organizationId: "o" };
    expectTypeOf(t.get<"STRIPE_KEY">).returns.resolves.toEqualTypeOf<string>();
    expectTypeOf(t.get<"WEBHOOK_SIG">).returns.resolves.toEqualTypeOf<{ secret: string }>();
    // Each of these is a compile error, which is the assertion; the calls themselves never run.
    const rejected = [
      // @ts-expect-error — an undeclared secret name.
      () => t.get(owner, "NOPE"),
      // @ts-expect-error — an undeclared key field.
      () => t.get({ ...owner, teamId: "t" }, "STRIPE_KEY"),
      // @ts-expect-error — a partial owner where the whole one is needed.
      () => t.put({ userId: "u" }, "STRIPE_KEY", "sk"),
      // @ts-expect-error — a json secret's value has its schema's shape.
      () => t.put(owner, "WEBHOOK_SIG", "a string"),
      // @ts-expect-error — a text secret's value is a string.
      () => t.put(owner, "STRIPE_KEY", { secret: "x" }),
      // @ts-expect-error — a predicate may only name declared keys.
      () => t.deleteWhere({ teamId: "t" }),
      // @ts-expect-error — and list is held to the same rule.
      () => t.list({ teamId: "t" }),
    ];
    expect(rejected).toHaveLength(7);
    // A partial owner is exactly what the owner-wide calls take.
    expectTypeOf(t.list).parameter(0).toEqualTypeOf<{ userId?: string; organizationId?: string }>();
    expectTypeOf(t.deleteWhere).parameter(0).toEqualTypeOf<{ userId?: string; organizationId?: string }>();
  });

  test("an accessor built without table I/O says so, rather than reaching a store it does not have", () => {
    const accessor = new SecretsAccessor(defineSecretRegistry({}), {});
    expect(() => accessor.table(CustomerSecrets)).toThrow(InternalError);
  });

  test("subset carries the table I/O through, so a capability's slice can reach its tables", async () => {
    const opened: string[] = [];
    const io: SecretTableIO = async (table) => {
      opened.push(table.name);
      throw new Error("stop here");
    };
    const accessor = new SecretsAccessor(defineSecretRegistry({}), {}, undefined, {}, io);
    const slice = accessor.subset(defineSecretRegistry({}));
    await expect(slice.table(CustomerSecrets).get({ userId: "u", organizationId: "o" }, "STRIPE_KEY")).rejects.toThrow(
      "stop here",
    );
    expect(opened).toEqual(["customer"]);
  });

  test("redacts itself", () => {
    expect(JSON.stringify({ t: new SecretTableAccessor(CustomerSecrets, unreachable) })).toBe(
      '{"t":"[SecretTable customer]"}',
    );
  });
});
