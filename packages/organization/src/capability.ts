// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailCapability } from "@pithy-sh/email/src/capability";
import type { Migration } from "kysely/migration";
import { OrganizationConfig, type OrganizationConfigInput } from "./config/config";
import { organizationTables } from "./data/tables";
import { registerOrganizationRoutes } from "./http/routes";
import { organizationAdminRoutes } from "./http/scopes";
import type { EnqueueInvitation } from "./mail/invitation";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "./migrations/0001_init";
import { type OwnershipRoles, requireTransferableRoles } from "./ownership/ownership";
import { founderRole, type OrganizationDeleteSweep } from "./provision/provision";
import type { RoleCatalog } from "./roles/roles";
import { organizationExampleSeed } from "./seeds/example";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

/**
 * The tenancy capability: organizations, memberships, the roles a project declares, and the gates that
 * read them.
 *
 * It contributes five tables to the app `DB`, the route surface in `./http/routes.ts`, two control-plane
 * reads, and a worked fixture. `@pithy-sh/auth` is a **hard peer** — a membership is a row keyed by a
 * user id this capability does not own, and every route here resolves a session before it resolves a
 * membership — so a Worker composing tenancy without sign-in is refused at assembly rather than serving
 * routes that could never pass their first gate. `@pithy-sh/email` is optional and fills the invitation
 * seam; `@pithy-sh/audit` and the control-plane seam are read through `c.var`, so both stay optional
 * without a line here.
 *
 * ## The role catalog is an argument, not configuration
 *
 * `organization({ roles, … })` takes the catalog as a value because the adopter's own handlers import
 * its powers — `requirePower("connections:manage")` reads from `src/organization/roles.ts` — and
 * importing a handler's vocabulary out of `pithy.config.ts` is backwards. It also carries literal types,
 * which a Zod-parsed config field could not: the returned capability is generic in the declared power
 * and role unions, so a tool reading `capability.roles` sees the names as written.
 *
 * ## Composing this alongside Better Auth's `organization()` plugin is refused
 *
 * {@link refuseSecondMembershipModel} is the whole of it, and it is the one refusal that belongs here
 * rather than in a store or a gate. Everything else this package checks is a fact about one call; this
 * is a fact about the Worker.
 */

/** The database name every capability sharing the app D1 coordinates on. `DB` is the binding. */
const ORGANIZATION_DATABASE_NAME = "app" as const;

/**
 * The extension kind `@pithy-sh/auth` reports an adopter's Better Auth plugins under, and the id Better
 * Auth's tenancy plugin carries.
 *
 * **Read off core's `Capability.extensions` seam rather than by importing anything.** `better-auth` is
 * not a dependency of this package and must not become one — the check would then pull a sign-in library
 * into every Worker that composes tenancy, to ask a question about a list of strings. The auth capability
 * already derives the plugin's tables and publishes one entry per plugin (`packages/auth/src/capability.ts`),
 * which is a fact about the composed Worker stated in the vocabulary core defines for exactly this.
 */
const BETTER_AUTH_PLUGIN_KIND = "better-auth-plugin";
const BETTER_AUTH_ORGANIZATION_PLUGIN_ID = "organization";

/**
 * The composed email capability, recognized by its shape rather than by `@pithy-sh/email`'s own
 * `isEmailCapability` (#645).
 *
 * Email is an **optional** peer here, and importing the guard — a value — made it a required one at bundle
 * time: wrangler's esbuild resolves every specifier it finds, so a project that delivers its invitations its
 * own way and never installed `@pithy-sh/email` could not bundle organization at all. The `EmailCapability`
 * type is erased before any bundler sees it; this predicate is the same two lines the guard holds, and a
 * composition without email simply finds nothing.
 */
function composedEmail(capabilities: readonly Capability[]): EmailCapability | undefined {
  return capabilities.find(
    (capability): capability is EmailCapability => capability.name === "email" && "emailConfig" in capability,
  );
}

/**
 * Refuse a Worker that composes this capability **and** Better Auth's `organization()` plugin.
 *
 * **Two membership models in one Worker is two answers to "may this person act here", and a Worker with
 * two answers has whichever one the route happened to ask.** The plugin puts an
 * `active_organization_id` column on the session and free-string roles on its own member table; this
 * capability puts the selection in its own table, keeps nothing about a role on the session, and decodes
 * every role through the project's catalog. Both are coherent. Running them together is not: a
 * membership revoked in one is still live in the other, and the two disagree about the single question
 * this package exists to answer.
 *
 * It also collides on the noun. The plugin's tables are `organization`, `member` and `invitation`; this
 * capability's are `pithy_organization_*`. Nothing fails at `pithy migrate` — they are different table
 * names — so without this the composition boots, serves, and quietly holds two rosters.
 *
 * **Raised in `compose`, not in `boot`.** `boot` runs only for a Worker that is about to take requests,
 * and this is a mistake the adopter's toolchain should surface the moment it loads the config —
 * `pithy doctor`, `pithy ui` and `pithy dev` all compose capabilities without serving anything. A
 * refusal an adopter sees sooner is a refusal they fix before a deploy. Nothing here needs a request, a
 * binding, or a database, so nothing here has any reason to wait for one.
 *
 * Names both sides, because the remedy depends on which one they meant to keep and only they know that.
 */
function refuseSecondMembershipModel(capabilities: readonly Capability[]): void {
  for (const capability of capabilities) {
    for (const extension of capability.extensions ?? []) {
      if (extension.kind !== BETTER_AUTH_PLUGIN_KIND) continue;
      if (extension.id !== BETTER_AUTH_ORGANIZATION_PLUGIN_ID) continue;
      throw new ValidationError({
        message:
          "This Worker composes both @pithy-sh/organization and Better Auth's organization() plugin, and they are two membership models.",
        action:
          "Keep one. Drop organization() from the plugins array in auth({ … }) to use this capability, or drop organization() from the capabilities array to use the plugin.",
        detail: `capability "${capability.name}" declares the better-auth-plugin extension "${extension.id}" alongside the organization capability; both answer whether a caller may act in an account, and a route reads whichever it was written against`,
      });
    }
  }
}

/** What `organization()` takes: the config's input side, plus the two things a schema cannot carry. */
export type OrganizationOptions<Power extends string, Role extends string> = OrganizationConfigInput & {
  /**
   * The project's role catalog, from `defineRoles` in `src/organization/roles.ts`.
   *
   * Required and not defaulted. A starter matrix shipped from here would be a set of role names an
   * adopter never chose, and a role name is stable forever once a membership holds one — so the kit
   * scaffolds the module (`pithy add organization`) and refuses to be the author of it.
   */
  readonly roles: RoleCatalog<Power, Role>;
  /**
   * The two roles a transfer of ownership moves: the one the nominee takes, and the one the previous
   * holder falls back to.
   *
   * **Here rather than in the config schema, because these are role names and Zod cannot know them.** A
   * `z.string()` field would accept a role the catalog never declared and fail at the first transfer,
   * which is the one moment nobody wants to discover a typo.
   *
   * Absent means this project has no two-party transfer and the three ownership routes do not mount —
   * a legitimate shape, and the academy's. It is **not** derived from the catalog: the conferred role
   * could be guessed from a single unassignable role, but the role the previous holder falls back to has
   * no signal at all in {@link RoleCatalog}, and a capability that guessed would silently demote somebody
   * to the wrong thing.
   */
  readonly ownership?: OwnershipRoles<Role>;
  /**
   * Your own tenanted rows, deleted in the transaction that deletes the account — `#570`.
   *
   * Every adopter who composes this has tables keyed on `organizationId`; that is what tenancy is, and
   * this capability cannot see them. Without this it swept its own five and stopped, leaving your rows
   * behind for an account that no longer exists — and for the first adopter those rows were connections
   * to customers' production Workers, so what outlived the deletion was a credential.
   *
   * Return statements rather than doing the work: they join the same `d1.batch`, ahead of this
   * capability's own, so a failure in any of them rolls the account back too. A function that deleted
   * for itself could not be in that transaction, and its failure mode is exactly the bug.
   *
   * You are handed the **binding**, so build a Kysely over your own schema — `myDatabase(d1)
   * .deleteFrom("projects")`. An earlier draft passed this capability's own handle and every adopter
   * naming their own table had to cast it away.
   *
   * Ordered first, so a statement may still read a membership while composing itself.
   */
  readonly onDelete?: OrganizationDeleteSweep;
};

/** The tenancy capability, with its resolved config and the catalog it was composed with attached. */
export interface OrganizationCapability<Power extends string = string, Role extends string = string>
  extends Capability<DatabaseSpecMap, Record<never, never>, "organization"> {
  /** The resolved configuration. */
  organizationConfig: OrganizationConfig;
  /**
   * The catalog every gate in this Worker asks. Attached so a management surface, a test, or the
   * adopter's own code reads the matrix in force rather than a second copy of it.
   */
  organizationRoles: RoleCatalog<Power, Role>;
  /** The transfer's two roles, or `undefined` where this project has no transfer. */
  organizationOwnership: OwnershipRoles<Role> | undefined;
}

/** Whether a composed capability is the tenancy capability — carries its resolved config and catalog. */
export function isOrganizationCapability(capability: Capability): capability is OrganizationCapability {
  return capability.name === "organization" && "organizationConfig" in capability;
}

/**
 * Compose the tenancy capability.
 *
 * The config is parsed at assembly rather than lazily, for the reason every capability here parses at
 * assembly: a `basePath` that does not start with `/`, or an invitation TTL longer than the ceiling,
 * fails on deploy instead of on the day somebody clicks a link. {@link requireTransferableRoles} runs at
 * the same moment and for the same reason — an ownership pair naming a role the catalog does not declare
 * is a catalog mistake, and the first transfer is much too late to hear about it.
 */
export function organization<const Power extends string = never, const Role extends string = string>(
  options: OrganizationOptions<Power, Role>,
): OrganizationCapability<Power, Role> {
  const { roles, ownership, onDelete, ...configInput } = options;
  const resolved = OrganizationConfig.parse(configInput);

  // The transfer's roles, checked against the catalog they will be spent against. `nominate` and
  // `acceptNomination` check the same pair per call; this is the same rule asked once, early, where the
  // answer is a deploy failure rather than a 400 in front of somebody handing over their company.
  if (ownership) requireTransferableRoles(roles, ownership);

  // **And the catalog has to leave somebody who could found an account at all.**
  //
  // `defineRoles` deliberately does not ask this: it does not know that anything founds organizations,
  // and a validator that assumed a caller's use is a validator that refuses a legitimate one. This
  // capability does found them, so it asks here — once, at assembly — and the answer is a deploy
  // failure rather than a refusal in front of the first person who ever presses Create. The value is
  // thrown away; what is wanted is the throw. `provision/provision.ts` carries the rule, and this is
  // the same rule asked earlier, in the one place that knows it applies.
  founderRole(roles);

  const migrations: Record<string, Migration> = { "0001_init": organization_0001_init };

  /**
   * The email seam, filled by `compose`.
   *
   * A mutable slot rather than an argument, because `compose` runs after the factory: the routes are
   * registered at assembly and need a way to reach an enqueue that does not exist yet.
   */
  const wiring: { enqueue: EmailCapability["enqueue"] | undefined } = { enqueue: undefined };

  // One binding. Every tenancy table lives in the app database, beside the `pithy_auth_users` rows the
  // roster resolves people through — the one join this capability makes across a capability boundary,
  // and it makes it through `@pithy-sh/auth`'s published reader rather than by naming its columns.
  const requiredBindings: BindingSpecInput[] = [{ type: "d1", name: "DB" }];

  const capability = defineCapability({
    name: "organization",
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    // Auth is the one hard peer. A membership is keyed by a user id from `pithy_auth_users`, the roster
    // resolves people through auth's published `getUsers`, and every route but the public accept screen
    // begins with a session. Email is deliberately **not** here: a project that delivers its invitation
    // links its own way sets `sendInvitationEmail: false` and everything else still runs.
    dependsOn: ["auth"],
    config: OrganizationConfig,
    compose: ({ capabilities }) => {
      // The refusal first, so a Worker holding two membership models never gets as far as wiring mail
      // for one of them.
      refuseSecondMembershipModel(capabilities);
      const email = composedEmail(capabilities);
      // An invitation the config says to mail, in a Worker with no email to mail it through, used to be found
      // out by the first person to invite someone. Refused here instead, by name (#645 review).
      if (resolved.sendInvitationEmail && email === undefined) {
        throw new ValidationError({
          message: "Invitations are mailed, and no email is composed in this Worker.",
          action:
            "Add `email(...)` to this Worker's capabilities in pithy.config.ts — the one that composes organization — or set `sendInvitationEmail: false` and deliver the link yourself.",
          detail:
            "`sendInvitationEmail` defaults to true. The invite route mails through the email capability composed beside it, and without one every invitation would be refused as it was made.",
        });
      }
      wiring.enqueue = email?.enqueue;
    },
    requiredBindings,
    databases: {
      [ORGANIZATION_DATABASE_NAME]: {
        binding: "DB",
        tables: organizationTables(),
        migrationOrder: ORGANIZATION_MIGRATION_ORDER,
        migrations,
      },
    },
    // Built from the resolved `basePath`, never the default: an adopter who mounts this at `/accounts`
    // gets a manifest naming their paths, where a client assuming the default would 404.
    adminRoutes: organizationAdminRoutes(resolved.basePath),
    routes: registerOrganizationRoutes({
      catalog: roles,
      config: resolved,
      ownership,
      onDelete,
      enqueue: (env) => {
        const enqueue = wiring.enqueue;
        if (!enqueue) return undefined;
        // The email capability owns the `DB` and `EMAIL_SENDER` bindings and the from-identity; tenancy
        // passes only the request env and the high-level input, and never names an email binding itself.
        return ((input) => enqueue(env as never, input)) as EnqueueInvitation;
      },
    }),
    // Built against the catalog this Worker composed, not a constant: a fixture holding `"admin"` in a
    // project whose roles are `coach` and `student` writes memberships every gate correctly refuses.
    seeds: [organizationExampleSeed(roles)],
  });

  return Object.assign(capability, {
    organizationConfig: resolved,
    organizationRoles: roles,
    organizationOwnership: ownership,
  });
}
