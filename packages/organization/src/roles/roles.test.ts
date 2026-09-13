// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, expectTypeOf, test } from "vitest";
import { defineRoles, isKitPower, KIT_POWERS, type KitPower } from "./roles";

/** The dashboard's catalog: three roles that nest, two powers of its own, `owner` unassignable. */
const dashboard = defineRoles({
  powers: ["connections:read", "connections:manage"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: ["organization:read", "connections:read", "connections:manage", "organization:manage"],
    owner: [
      "organization:read",
      "connections:read",
      "connections:manage",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
    ],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});

/** The academy's: four roles, two of them parallel. The catalog a nesting assumption would refuse. */
const academy = defineRoles({
  powers: ["sessions:read", "sessions:accept", "sessions:request", "students:block", "coaches:block"],
  roles: {
    owner: [
      "organization:read",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
      "sessions:read",
    ],
    admin: ["organization:read", "organization:manage", "members:manage", "sessions:read"],
    coach: ["organization:read", "sessions:read", "sessions:accept", "students:block"],
    student: ["organization:read", "sessions:request", "coaches:block"],
  },
  administrativePower: "organization:manage",
});

describe("the kit's five powers", () => {
  test("are exactly five, and every one is recognized as reserved", () => {
    expect(KIT_POWERS).toHaveLength(5);
    for (const power of KIT_POWERS) expect(isKitPower(power)).toBe(true);
    expect(isKitPower("connections:read")).toBe(false);
  });

  test("are in force whether or not an adopter declared any of their own", () => {
    const minimal = defineRoles({
      roles: { admin: [...KIT_POWERS] },
      administrativePower: "organization:manage",
    });
    expect(minimal.powers).toEqual([...KIT_POWERS]);
    expect(minimal.roleAllows("admin", "members:manage")).toBe(true);
  });

  test("cannot be redeclared, naming the one that collided", () => {
    expect(() =>
      defineRoles({
        powers: ["members:manage"],
        roles: { admin: [...KIT_POWERS] },
        administrativePower: "organization:manage",
      }),
    ).toThrow(/`members:manage` is one of the kit's own powers/);
  });
});

describe("the matrix", () => {
  test("answers what each role holds, in declaration order", () => {
    expect(dashboard.powersOf("member")).toEqual(["organization:read", "connections:read"]);
    expect(dashboard.roleAllows("admin", "connections:manage")).toBe(true);
    expect(dashboard.roleAllows("admin", "members:manage")).toBe(false);
    expect(dashboard.roleAllows("owner", "organization:delete")).toBe(true);
  });

  test("refuses a role holding a power nobody declared — at compile time, and again at runtime", () => {
    expect(() =>
      defineRoles({
        // @ts-expect-error — `connections:manage` is not in this catalog's power set, and `NoInfer`
        // stops it becoming one by being mentioned. The runtime check below is the second line, for a
        // caller reaching this from JavaScript or through a cast.
        roles: { admin: [...KIT_POWERS, "connections:manage"] },
        administrativePower: "organization:manage",
      }),
    ).toThrow(/holds `connections:manage`, which is not a declared power/);
  });

  test("refuses a catalog in which a kit power is held by nobody, naming the power", () => {
    // An account nobody can delete is a catalog mistake, not a runtime state to discover on the day.
    expect(() =>
      defineRoles({
        roles: { admin: ["organization:read", "organization:manage", "members:manage", "billing:manage"] },
        administrativePower: "organization:manage",
      }),
    ).toThrow(/No role holds `organization:delete`/);
  });

  test("refuses an empty catalog", () => {
    expect(() => defineRoles({ roles: {}, administrativePower: "organization:manage" })).toThrow(
      /needs at least one role/,
    );
  });
});

describe("the administrative power", () => {
  test("is named, never inferred from a role spelled `admin`", () => {
    // The academy's owner administers too. Counting the word would have said otherwise.
    expect(academy.administers("owner")).toBe(true);
    expect(academy.administers("admin")).toBe(true);
    expect(academy.administers("coach")).toBe(false);
    expect(academy.administers("student")).toBe(false);
  });

  test("is refused when it names a power nobody declared", () => {
    expect(() =>
      defineRoles({
        roles: { admin: [...KIT_POWERS] },
        // @ts-expect-error — a power outside the declared set does not typecheck either.
        administrativePower: "sessions:read",
      }),
    ).toThrow(/named as the administrative power but is not declared/);
  });

  test("is refused when no role holds it", () => {
    expect(() =>
      defineRoles({
        powers: ["nobody:holds"],
        roles: { admin: [...KIT_POWERS] },
        administrativePower: "nobody:holds",
      }),
    ).toThrow(/could never be administered/);
  });
});

describe("nesting", () => {
  test("is asserted where it is declared", () => {
    // The dashboard's three do nest, and the catalog above declares it. Nothing threw.
    for (const power of dashboard.powersOf("member")) {
      expect(dashboard.roleAllows("admin", power), power).toBe(true);
    }
    for (const power of dashboard.powersOf("admin")) {
      expect(dashboard.roleAllows("owner", power), power).toBe(true);
    }
  });

  test("refuses a claim that does not hold, naming both roles and what is missing", () => {
    expect(() =>
      defineRoles({
        powers: ["sessions:read"],
        roles: {
          member: ["organization:read", "sessions:read"],
          admin: [
            "organization:read",
            "organization:manage",
            "members:manage",
            "billing:manage",
            "organization:delete",
          ],
        },
        administrativePower: "organization:manage",
        nests: ["member", "admin"],
      }),
    ).toThrow(/`admin` is declared to nest above `member` but does not hold `sessions:read`/);
  });

  test("is optional, and a parallel role set composes with nothing refusing it", () => {
    // The academy: `coach` and `student` each hold what the other does not. A kit that assumed
    // nesting would have refused this outright.
    expect(academy.roleAllows("coach", "students:block")).toBe(true);
    expect(academy.roleAllows("student", "students:block")).toBe(false);
    expect(academy.roleAllows("student", "coaches:block")).toBe(true);
    expect(academy.roleAllows("coach", "coaches:block")).toBe(false);
  });

  test("refuses a nests entry that is not a declared role", () => {
    expect(() =>
      defineRoles({
        roles: { admin: [...KIT_POWERS] },
        administrativePower: "organization:manage",
        // @ts-expect-error — and it does not typecheck either.
        nests: ["admin", "ghost"],
      }),
    ).toThrow(/appears in `nests` but is not a declared role/);
  });
});

describe("assignability, derived by exclusion", () => {
  test("every role is assignable unless excluded", () => {
    expect(dashboard.assignableRoles).toEqual(["member", "admin"]);
    // Nothing excluded, so all four — a role added to this catalog is assignable by default, and
    // excluding it is the deliberate act.
    expect(academy.assignableRoles).toEqual(["owner", "admin", "coach", "student"]);
  });

  test("the schema refuses an excluded role at the boundary", () => {
    expect(dashboard.AssignableRole.safeParse("admin").success).toBe(true);
    expect(dashboard.AssignableRole.safeParse("owner").success).toBe(false);
    // Still decodable as a role that exists — it just cannot be handed out.
    expect(dashboard.Role.safeParse("owner").success).toBe(true);
  });

  test("refuses a catalog where nothing is assignable", () => {
    expect(() =>
      defineRoles({
        roles: { admin: [...KIT_POWERS] },
        administrativePower: "organization:manage",
        unassignable: ["admin"],
      }),
    ).toThrow(/nobody could ever be given one/);
  });
});

describe("decoding a role off a row", () => {
  test("refuses a value the catalog does not know", () => {
    // The column is text. A role matching no branch in the matrix would deny everything today and, one
    // refactor later, allow it — so it refuses instead of resolving.
    expect(dashboard.Role.safeParse("superuser").success).toBe(false);
    expect(dashboard.Role.safeParse("").success).toBe(false);
    expect(dashboard.Role.safeParse("Admin").success).toBe(false);
  });
});

describe("the literal types flow through", () => {
  test("a role narrows to the declared union", () => {
    expectTypeOf(dashboard.roles).toEqualTypeOf<readonly ("member" | "admin" | "owner")[]>();
    expectTypeOf(academy.roles).toEqualTypeOf<readonly ("owner" | "admin" | "coach" | "student")[]>();
  });

  test("a power nobody declared does not compile", () => {
    // Never called — the assertions are the compiler's, and calling them would exercise the runtime
    // instead. `tsc` runs over this file in `bun run typecheck`, so an `@ts-expect-error` that stopped
    // being an error fails the build there.
    function pinned(): void {
      // @ts-expect-error — `billing:refund` is not in this catalog's power set.
      dashboard.roleAllows("admin", "billing:refund");
      // @ts-expect-error — nor is a role it does not have.
      dashboard.roleAllows("coach", "organization:read");
    }
    expect(pinned).toBeTypeOf("function");
    // The kit's five always compile, declared or not.
    expectTypeOf(dashboard.roleAllows).toBeCallableWith("admin", "members:manage");
  });

  test("an unknown role holds nothing rather than throwing", () => {
    // The column is text and this function is total in the role. A row written past a bug denies.
    const loose = dashboard as { roleAllows(role: string, power: string): boolean };
    expect(loose.roleAllows("superuser", "organization:read")).toBe(false);
  });

  test("the kit power type is the five names", () => {
    expectTypeOf<KitPower>().toEqualTypeOf<
      "organization:read" | "organization:manage" | "organization:delete" | "members:manage" | "billing:manage"
    >();
  });
});

describe("a role name that is also a property of Object.prototype", () => {
  test("**denies, rather than throwing** — which is what the accessors document", () => {
    // `input.roles["toString"]` finds `Object.prototype.toString`, a function, so `?? []` never fired
    // and `.includes` threw a TypeError. Every role name inside this package is decoded through `Role`
    // first, so it was unreachable here — but the catalog is the adopter's to call directly, and a gate
    // that throws where it documents a denial is the wrong failure for an authorization question.
    for (const hostile of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      const role = hostile as "member";
      expect(() => dashboard.powersOf(role), hostile).not.toThrow();
      expect(dashboard.powersOf(role), hostile).toEqual([]);
      expect(dashboard.roleAllows(role, "organization:read"), hostile).toBe(false);
      expect(dashboard.administers(role), hostile).toBe(false);
    }
  });

  test("and a declared role is unaffected, so the fix did not deny everything", () => {
    expect(dashboard.administers("admin")).toBe(true);
    expect(dashboard.administers("member")).toBe(false);
    expect(dashboard.roleAllows("member", "organization:read")).toBe(true);
  });
});
