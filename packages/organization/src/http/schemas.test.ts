// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CreateOrganization, createOrganizationBody } from "./schemas";

/**
 * The one thing about the request schemas that is not obvious from reading them.
 *
 * {@link createOrganizationBody} narrows a **module-level const** for a project that derives its short
 * names. If that narrowing were in place rather than a new schema, one composed capability would decide
 * for every other one in the isolate — and the failure would be a project that never set `slugs`
 * refusing every `slug` its own clients send, on the day an unrelated Worker in the same bundle turned
 * derivation on. It is a property of the Zod version rather than of this file, which is exactly why it
 * is pinned here instead of assumed.
 */
describe("createOrganizationBody", () => {
  test("narrowing for one project leaves the shared schema alone", () => {
    const derived = createOrganizationBody("derived");
    expect(derived.safeParse({ name: "Acme", slug: "acme" }).success).toBe(false);
    expect(derived.safeParse({ name: "Acme" }).success).toBe(true);

    expect(createOrganizationBody("chosen").safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
    expect(CreateOrganization.safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
  });

  test("the refusal names the field, so a client knows which one to drop", () => {
    const refused = createOrganizationBody("derived").safeParse({ name: "Acme", slug: "acme" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["slug"]);
  });

  test("either way the name is still required and still bounded", () => {
    for (const slugs of ["chosen", "derived"] as const) {
      const body = createOrganizationBody(slugs);
      expect(body.safeParse({}).success, slugs).toBe(false);
      expect(body.safeParse({ name: "" }).success, slugs).toBe(false);
      expect(body.safeParse({ name: "a".repeat(129) }).success, slugs).toBe(false);
    }
  });
});
