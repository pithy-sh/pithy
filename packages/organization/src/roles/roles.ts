// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { OrganizationInvalidRoleCatalogError } from "../error/errors";

/**
 * Who may do what — declared once, by the adopter, and read by every route.
 *
 * ## Three places, and they are different kinds of thing
 *
 * **The capability owns five power names.** It ships routes — invite, change a role, remove a member,
 * transfer ownership, delete the account — and those routes gate on something, so that something is the
 * kit's and is closed. Reserved exactly as the kit's error domains are reserved: an adopter may not
 * redeclare one, because the capability's own handlers are written against them.
 *
 * **The adopter declares their own powers and the whole matrix**, in a module of their project rather
 * than in a config literal, because their route code imports the typed powers and importing from
 * `pithy.config.ts` into a handler is backwards. `defineRoles` is the house pattern —
 * `defineErrorPayload`, `defineSecretRegistry`, `defineSupportCategories`.
 *
 * **D1 holds the instances.** `member.role` is a string from the declared set, decoded on read and
 * refused when unrecognized — never asserted. A role that matches no branch in a matrix would deny
 * everything today and, one refactor later, allow it.
 *
 * ## Two unrelated role sets have to coexist, and that is the whole design
 *
 * A dashboard's `owner`/`admin`/`member` nest: every power a member holds an admin holds. A coaching
 * academy's `coach` and `student` are parallel and each holds what the other does not. **A kit that
 * assumed nesting would refuse the academy outright**, so nesting is asserted only where it is
 * declared — {@link RoleCatalogInput.nests} — and asserted properly there, because for a set where it
 * does hold it is a real property worth holding.
 *
 * ## `administrativePower` is named, never inferred from a role spelled `admin`
 *
 * It is what the "this account always keeps somebody who can administer it" invariant counts over. A
 * catalog where an owner also administers does not become unadministrable when its one admin leaves —
 * which is exactly what counting a role name would have concluded.
 *
 * ## A role name is stable forever once a row holds one
 *
 * Renaming `coach` orphans every membership carrying it, and nothing in this capability can repair
 * that. The same class of rule as the project name and a `migrationOrder`.
 */

/**
 * The five powers this capability's own routes gate on.
 *
 * Closed, and reserved against redeclaration. They are the five operations any tenancy model has —
 * read the account, change it, end it, manage who is in it, and answer for the bill — which is why a
 * product's own powers always sit *beside* them rather than replacing them.
 */
export const KIT_POWERS = [
  "organization:read",
  "organization:manage",
  "organization:delete",
  "members:manage",
  "billing:manage",
] as const;

/** One of the kit's five reserved powers. */
export type KitPower = (typeof KIT_POWERS)[number];

/** Whether a name is one the kit reserves. */
export function isKitPower(power: string): power is KitPower {
  return (KIT_POWERS as readonly string[]).includes(power);
}

/**
 * The kit powers a catalog must place somewhere.
 *
 * Every one of these gates a route this capability ships, so a catalog in which no role holds one
 * describes an account where that route can never be used by anybody. Refused at boot, naming the
 * power: that is a catalog mistake, not a runtime state somebody should discover on the day they try.
 */
const REQUIRED_KIT_POWERS: readonly KitPower[] = KIT_POWERS;

/** What an adopter hands {@link defineRoles}. */
export interface RoleCatalogInput<Power extends string = never, Role extends string = string> {
  /**
   * The powers this product adds, under its own names.
   *
   * Optional: a project happy with the kit's five declares none. A name the kit reserves is refused
   * here, naming it — the same rule that reserves kit domains in `defineErrorPayload`.
   */
  readonly powers?: readonly Power[];
  /*
    **Everything below is `NoInfer`, and that is what makes the compile-time refusals real.**

    Without it a type parameter widens to accommodate whatever it is given: naming `sessions:read` as
    the administrative power would *make* `sessions:read` a declared power, and listing a role in
    `nests` that `roles` does not have would make it a declared role. Both mistakes would then be caught
    only at runtime, which is a weaker promise than the one this signature makes. `NoInfer` pins the
    two sets to `powers` and to the keys of `roles`, so the rest are checked against them.
  */
  /**
   * Every role, and every power it holds. Written out per role rather than composed with spreads,
   * because the value of a matrix is that a reviewer can see it without evaluating anything.
   */
  readonly roles: Readonly<Record<Role, readonly NoInfer<KitPower | Power>[]>>;
  /**
   * The power the last-administrator invariant counts over.
   *
   * Required, and refused if nothing declares it. An account nobody can administer is not a state to
   * arrive at, and the only way to keep that true is to know which power means *administers*.
   */
  readonly administrativePower: NoInfer<KitPower | Power>;
  /**
   * Roles that nest, weakest first — each holding everything the one before it holds.
   *
   * Optional, and asserted where given: a catalog claiming a nesting that does not hold is refused at
   * boot, naming both roles. Omitting it is not a weaker catalog, it is a different shape of one.
   */
  readonly nests?: readonly NoInfer<Role>[];
  /**
   * Roles nobody may hand another person — the dashboard's `owner`, which moves only by a two-party
   * transfer.
   *
   * **Assignability is derived by exclusion**, so a role added to the catalog is assignable by default
   * and excluding it is the deliberate act. The alternative fails the quiet way: a new role nobody can
   * be given, discovered when somebody asks why the dropdown is short.
   */
  readonly unassignable?: readonly NoInfer<Role>[];
}

/** The resolved catalog: the matrix, plus the schemas and predicates every route reads it through. */
export interface RoleCatalog<Power extends string, Role extends string> {
  /** Every power in force — the kit's five, then the adopter's, in declaration order. */
  readonly powers: readonly (KitPower | Power)[];
  /** Every role, in declaration order. */
  readonly roles: readonly Role[];
  /** The power the last-administrator invariant counts over. */
  readonly administrativePower: KitPower | Power;
  /** The roles one member may give another: every role except those excluded. */
  readonly assignableRoles: readonly Role[];
  /** Every power a role holds, in the order the matrix declares them. */
  powersOf(role: Role): readonly (KitPower | Power)[];
  /** Whether a role holds a power. The whole authorization question, asked once. */
  roleAllows(role: Role, power: KitPower | Power): boolean;
  /** Whether a role administers — holds {@link administrativePower}. Never "is it spelled admin". */
  administers(role: Role): boolean;
  /** Decode a role off a D1 row. Refuses a value the catalog does not know. */
  readonly Role: z.ZodEnum<Record<Role, Role>>;
  /** Decode a role somebody is trying to assign. Refuses an excluded one at the boundary. */
  readonly AssignableRole: z.ZodEnum<Record<Role, Role>>;
}

/** Refuse a catalog, naming what is wrong with it. */
function refuse(message: string, action: string, detail: string): never {
  throw new OrganizationInvalidRoleCatalogError({ message, action, detail });
}

/**
 * What one role holds, or nothing at all.
 *
 * `Object.hasOwn` rather than a bare index, so a name that happens to exist on `Object.prototype` is
 * absent here exactly as any other undeclared name is. See the note at the accessors that call it.
 */
function held<Power extends string, Role extends string>(
  matrix: Record<Role, readonly Power[]>,
  role: Role,
): readonly Power[] {
  return Object.hasOwn(matrix, role) ? matrix[role] : [];
}

/**
 * Declare this project's roles and the powers they hold.
 *
 * Validated here, at the moment the constant is written, rather than at the first refusal. Everything
 * it checks is a fact about the declaration and nothing about a request, so there is no reason for the
 * failure to wait for one.
 *
 * `const` type parameters carry the literals through, so `catalog.roles` is a union of the names as
 * written and `roleAllows` refuses — at compile time — a power nobody declared.
 */
export function defineRoles<const Power extends string = never, const Role extends string = string>(
  input: RoleCatalogInput<Power, Role>,
): RoleCatalog<Power, Role> {
  const declared = input.powers ?? [];

  // The kit's names are reserved, not merely taken. An adopter redeclaring one would be writing a
  // second definition of a power this capability's own handlers already gate on.
  for (const power of declared) {
    if (isKitPower(power)) {
      refuse(
        `\`${power}\` is one of the kit's own powers and cannot be redeclared.`,
        "Pick a name under your own vocabulary, or drop it — the kit's five are already in force.",
        `declared power ${JSON.stringify(power)} collides with a reserved kit power`,
      );
    }
  }

  const duplicates = declared.filter((power, at) => declared.indexOf(power) !== at);
  if (duplicates.length > 0) {
    refuse(
      `The power \`${duplicates[0]}\` is declared twice.`,
      "Declare each power once.",
      `duplicate declared powers: ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  const powers: readonly (KitPower | Power)[] = [...KIT_POWERS, ...declared];
  const known = new Set<string>(powers);
  const roles = Object.keys(input.roles) as Role[];

  if (roles.length === 0) {
    refuse(
      "A role catalog needs at least one role.",
      "Declare the roles this product has, and what each one may do.",
      "roles is empty",
    );
  }

  // Every power a role holds has to be one that exists. A typo here would otherwise be a role quietly
  // holding nothing, which denies everything today and is invisible until somebody is refused.
  for (const role of roles) {
    for (const power of input.roles[role]) {
      if (!known.has(power)) {
        refuse(
          `The role \`${role}\` holds \`${power}\`, which is not a declared power.`,
          "Add it to `powers`, or correct the spelling.",
          `role ${role} references undeclared power ${JSON.stringify(power)}`,
        );
      }
    }
  }

  if (!known.has(input.administrativePower)) {
    refuse(
      `\`${input.administrativePower}\` is named as the administrative power but is not declared.`,
      "Name one of the kit's five, or declare it in `powers`.",
      `administrativePower ${JSON.stringify(input.administrativePower)} is not in the power set`,
    );
  }

  // A power this capability's own routes gate on that no role holds is a route nobody can ever use.
  // Named individually, because the fix differs per power.
  for (const power of REQUIRED_KIT_POWERS) {
    if (!roles.some((role) => input.roles[role].includes(power))) {
      refuse(
        `No role holds \`${power}\`, so nothing this catalog describes could ever use it.`,
        "Give it to whichever role is meant to have it.",
        `kit power ${power} is held by no declared role`,
      );
    }
  }

  if (!roles.some((role) => input.roles[role].includes(input.administrativePower))) {
    refuse(
      `No role holds \`${input.administrativePower}\`, so this organization could never be administered.`,
      "Give the administrative power to at least one role.",
      `administrativePower ${input.administrativePower} is held by no declared role`,
    );
  }

  // Nesting, asserted where it is claimed. A catalog that merely intends it would let a demotion grant
  // a power a promotion had taken away, which is the one thing nesting is asserted to rule out.
  const nests = input.nests ?? [];
  for (const role of nests) {
    if (!roles.includes(role)) {
      refuse(
        `\`${role}\` appears in \`nests\` but is not a declared role.`,
        "List only declared roles, weakest first.",
        `nests references undeclared role ${JSON.stringify(role)}`,
      );
    }
  }
  for (let at = 1; at < nests.length; at += 1) {
    const weaker = nests[at - 1] as Role;
    const stronger = nests[at] as Role;
    const missing = input.roles[weaker].filter((power) => !input.roles[stronger].includes(power));
    if (missing.length > 0) {
      refuse(
        `\`${stronger}\` is declared to nest above \`${weaker}\` but does not hold ${missing.map((power) => `\`${power}\``).join(", ")}.`,
        "Give the stronger role everything the weaker one holds, or drop the claim from `nests`.",
        `nesting ${weaker} -> ${stronger} fails on: ${missing.join(", ")}`,
      );
    }
  }

  const excluded = new Set<string>(input.unassignable ?? []);
  for (const role of excluded) {
    if (!roles.includes(role as Role)) {
      refuse(
        `\`${role}\` is excluded from assignment but is not a declared role.`,
        "List only declared roles.",
        `unassignable references undeclared role ${JSON.stringify(role)}`,
      );
    }
  }
  const assignableRoles = roles.filter((role) => !excluded.has(role));
  if (assignableRoles.length === 0) {
    refuse(
      "Every role is excluded from assignment, so nobody could ever be given one.",
      "Leave at least one role assignable.",
      `all ${roles.length} roles are in unassignable`,
    );
  }

  const asEnum = (names: readonly Role[]): z.ZodEnum<Record<Role, Role>> =>
    z.enum(Object.fromEntries(names.map((name) => [name, name])) as Record<Role, Role>);

  return {
    powers,
    roles,
    administrativePower: input.administrativePower,
    assignableRoles,
    /*
      Total in the role, deliberately. The types say a role is one of the declared names, and D1 says it
      is text — so a row written past a bug, or by a build that knew a role this one does not, would
      otherwise throw here. **Unknown holds nothing**, which denies; the caller that wants a refusal with
      a reason parses through `Role` first, and `acting` does exactly that.

      **`held` rather than `input.roles[role] ?? []`, and the difference is not pedantry.** That
      expression reaches `Object.prototype` for `"toString"`, `"constructor"`, `"valueOf"` and their
      neighbors — the lookup finds a *function*, `??` does not fire because the value is not nullish,
      and `.includes` throws a `TypeError`. Every role name inside this package is decoded through `Role`
      first so it was unreachable here, but the catalog is the adopter's to call directly and
      `catalog.roleAllows(someRole, power)` from their own handler is the advertised use. A gate that
      throws where it documents a denial is the wrong failure for an authorization question.
    */
    powersOf: (role) => held(input.roles, role),
    roleAllows: (role, power) => held(input.roles, role).includes(power),
    administers: (role) => held(input.roles, role).includes(input.administrativePower),
    Role: asEnum(roles).describe(
      "One of this project's declared roles, as `defineRoles` named them. Decoded off a membership row, never asserted — a value this catalog does not know refuses rather than falling through the matrix.",
    ) as z.ZodEnum<Record<Role, Role>>,
    AssignableRole: asEnum(assignableRoles).describe(
      "A role one member may give another — every declared role except the ones excluded, derived by exclusion so a role added to the catalog is assignable by default.",
    ) as z.ZodEnum<Record<Role, Role>>,
  };
}

/** The kit's five powers, as a catalog-agnostic Zod enum. For manifests and admin surfaces. */
export const KitPower = z
  .enum(Object.fromEntries(KIT_POWERS.map((power) => [power, power])) as Record<KitPower, KitPower>)
  .describe(
    "One of the five powers this capability's own routes gate on. Reserved: an adopter's catalog may hold them but may not redeclare them.",
  );
