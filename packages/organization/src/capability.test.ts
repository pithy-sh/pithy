// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, test } from "vitest";
import { OrganizationAuditActions } from "./audit/actions";
import { isOrganizationCapability, organization } from "./capability";
import { MEMBERSHIPS_TABLE, organizationTables } from "./data/tables";
import { ORGANIZATION_CONTROL_PLANE_SCOPES } from "./http/scopes";
import { ORGANIZATION_MIGRATION_ORDER } from "./migrations/0001_init";
import { defineRoles } from "./roles/roles";

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

/** The academy's: four roles, two of them parallel, nothing excluded from assignment. */
const academy = defineRoles({
  powers: ["sessions:read", "sessions:accept", "sessions:request"],
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
    coach: ["organization:read", "sessions:read", "sessions:accept"],
    student: ["organization:read", "sessions:request"],
  },
  administrativePower: "organization:manage",
});

/** The options every test that does not care about the rest passes. */
const BASE = { roles: dashboard, baseUrl: "https://app.example.test" } as const;

/** An email capability as organization recognizes one: its config, and the enqueue an invitation goes through. */
const EMAIL = {
  name: "email",
  requiredBindings: [],
  emailConfig: {},
  enqueue: async () => ({ jobId: "job-1", status: "pending" }),
} as unknown as Capability;

/** The dashboard's transfer: `owner` is unassignable, and a former owner falls back to `admin`. */
const TRANSFER = { confers: "owner", demotesTo: "admin" } as const;

describe("capability identity", () => {
  test("one name is the migration namespace, the table prefix, the error domain, and the audit domain", () => {
    // `organization` is a single string appearing in five places; if any of them drifts, the composed
    // migration key changes and Kysely re-runs applied migrations on an adopter's database.
    const capability = organization(BASE);
    expect(capability.name).toBe("organization");
    for (const table of Object.keys(organizationTables())) {
      expect(table.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).toMatch(/^pithy_organization_/);
    }
    for (const action of Object.values(OrganizationAuditActions)) expect(action.startsWith("organization/")).toBe(true);
    for (const scope of ORGANIZATION_CONTROL_PLANE_SCOPES) expect(scope.startsWith("organization:")).toBe(true);
  });

  test("the type guard narrows to the resolved config and the catalog in force", () => {
    const capability = organization({ ...BASE, basePath: "/accounts" });
    expect(isOrganizationCapability(capability)).toBe(true);
    expect(capability.organizationConfig.basePath).toBe("/accounts");
    // The catalog is attached rather than copied: a tool reading the matrix in force reads this one.
    expect(capability.organizationRoles).toBe(dashboard);
    expect(isOrganizationCapability({ name: "organization", requiredBindings: [] })).toBe(false);
  });

  test("the admin routes are built from the resolved basePath, never the default", () => {
    // A manifest naming `/organizations` for a Worker mounted at `/accounts` is a client that 404s, and
    // the whole point of the manifest is that a client composes its calls from the Worker.
    const paths = (organization({ ...BASE, basePath: "/accounts" }).adminRoutes ?? []).map((route) => route.path);
    expect(paths).toEqual(["/accounts/admin/organizations", "/accounts/admin/organizations/:organizationId/members"]);
  });
});

describe("bindings and dependencies", () => {
  test("declares the app database and nothing else", () => {
    expect(organization(BASE).requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  test("depends on auth, and on nothing else", () => {
    // Auth is the hard peer: a membership is keyed by a `pithy_auth_users` id this capability does not
    // own, and the roster resolves people through auth's published reader.
    expect(organization(BASE).dependsOn).toEqual(["auth"]);
  });

  test("does not depend on email — a project that delivers its own links still runs", () => {
    // `sendInvitationEmail: false` hands the accept link back to the caller. Making email a hard peer
    // would refuse a Worker that has a perfectly good way to deliver one.
    expect(organization(BASE).dependsOn).not.toContain("email");
  });
});

describe("migrations", () => {
  test("declares the allocated order and composes without collision", () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "organization",
        order: ORGANIZATION_MIGRATION_ORDER,
        migrations: organization(BASE).databases?.app?.migrations ?? {},
      },
    ]);
    expect(Object.keys(registry)).toEqual(["app"]);
  });

  test("the migration order is the one allocated in the CLI's orders table", () => {
    // Never grepped for, never renumbered. Renumbering a released capability renames its composed keys,
    // which makes Kysely read applied migrations as unapplied and re-run them on an adopter's database.
    expect(ORGANIZATION_MIGRATION_ORDER).toBe(1400);
  });

  test("registers its migration under the stable local key", () => {
    expect(Object.keys(organization(BASE).databases?.app?.migrations ?? {})).toEqual(["0001_init"]);
  });

  test("contributes all five tables to the app database", () => {
    expect(Object.keys(organization(BASE).databases?.app?.tables ?? {})).toEqual(Object.keys(organizationTables()));
  });
});

describe("configuration is validated at assembly", () => {
  test("a basePath that is not a path fails on deploy rather than at the first request", () => {
    expect(() => organization({ ...BASE, basePath: "organizations" })).toThrow();
  });

  test("an invitation that outlives the ceiling fails on deploy", () => {
    expect(() => organization({ ...BASE, invitationTtlDays: 400 })).toThrow();
  });

  test("the shipped defaults are the ones the config argues for", () => {
    const config = organization(BASE).organizationConfig;
    expect(config.basePath).toBe("/organizations");
    expect(config.invitationTtlDays).toBe(14);
    // Shorter than an invitation: an offer to take responsibility for an account, not to join one.
    expect(config.nominationTtlDays).toBe(7);
  });
});

describe("the ownership pair", () => {
  test("is checked against the catalog at assembly, not at the first transfer", () => {
    // `admin` is assignable, so one role change would confer it — and every offer-and-acceptance below
    // would be theater. The first transfer is much too late to hear about that.
    expect(() => organization({ ...BASE, ownership: { confers: "admin", demotesTo: "member" } })).toThrow(
      /can be given out by a role change/,
    );
  });

  test("a role the catalog does not declare is refused, naming the declared ones", () => {
    expect(() =>
      // @ts-expect-error — the literal types refuse this at compile time too, which is the first gate.
      organization({ ...BASE, ownership: { confers: "chairman", demotesTo: "admin" } }),
    ).toThrow(/not a role this catalog declares/);
  });

  test("a valid pair is attached, so both ends of a transfer read one constant", () => {
    expect(organization({ ...BASE, ownership: TRANSFER }).organizationOwnership).toEqual(TRANSFER);
  });

  test("omitting it composes — a product where nobody signs for the bill is a real shape", () => {
    // The academy's: four roles, nothing unassignable, no transfer. The three ownership routes simply
    // do not mount.
    const capability = organization({ roles: academy, baseUrl: "https://academy.example.test" });
    expect(capability.organizationOwnership).toBeUndefined();
    expect(isOrganizationCapability(capability)).toBe(true);
  });
});

/**
 * The one refusal that is about the Worker rather than about a call.
 *
 * A gate nobody has seen fail is not a gate, so the plugin is planted and the refusal is read.
 */
describe("composing alongside Better Auth's organization() plugin", () => {
  /** An auth capability as `auth({ plugins: [organization()] })` reports itself. */
  function authWith(id: string): Capability {
    return {
      name: "auth",
      requiredBindings: [],
      extensions: [{ kind: "better-auth-plugin", id, tables: ["organization", "member", "invitation"] }],
    };
  }

  /**
   * Run the composition the way `createBackend` does — beside an email capability, which the default config
   * mails invitations through and which a Worker without one is refused over (see the block below).
   */
  function compose(capability: Capability, alongside: readonly Capability[]): void {
    capability.compose?.({ capabilities: [EMAIL, ...alongside, capability] });
  }

  test("is refused, naming both", () => {
    const capability = organization(BASE);
    let thrown: PithyError | undefined;
    try {
      compose(capability, [authWith("organization")]);
    } catch (error) {
      thrown = error as PithyError;
    }
    expect(thrown).toBeDefined();
    // Both sides, because the remedy depends on which one they meant to keep and only they know that.
    expect(thrown?.payload.message).toContain("@pithy-sh/organization");
    expect(thrown?.payload.message).toContain("organization() plugin");
    expect(thrown?.payload.action).toContain("Keep one.");
    // The detail names the capability that declared it, for the log. The client message does not need to.
    expect(thrown?.payload.detail).toContain("auth");
  });

  test("a Worker without the plugin composes fine", () => {
    // The other half of the gate: a refusal that fired on every composition would be indistinguishable
    // from a broken capability.
    expect(() => compose(organization(BASE), [])).not.toThrow();
    expect(() => compose(organization(BASE), [{ name: "auth", requiredBindings: [] }])).not.toThrow();
  });

  test("another Better Auth plugin is not the plugin", () => {
    // `two-factor` adds tables and endpoints and answers nothing about membership. Refusing it would be
    // refusing every project that composes anything at all.
    expect(() => compose(organization(BASE), [authWith("two-factor")])).not.toThrow();
  });

  test("an extension of another kind that happens to be called organization is not it", () => {
    // The kind is half the key. Without it, any future extension vocabulary using the obvious noun
    // would refuse every Worker composing tenancy, which is a gate that has become a bug.
    const other: Capability = {
      name: "someday",
      requiredBindings: [],
      extensions: [{ kind: "someday-plugin", id: "organization" }],
    };
    expect(() => compose(organization(BASE), [other])).not.toThrow();
  });

  test("the extension vocabulary this reads is the one @pithy-sh/auth writes", () => {
    // The gate is keyed on two strings another package emits, and nothing in the type system ties them
    // together — `CapabilityExtension.kind` and `.id` are free text by design. Pinned here rather than
    // trusted, because the failure mode is silent: auth renames its kind, this refusal stops firing, and
    // a Worker with two membership models boots and serves.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "auth", "src", "capability.ts"),
      "utf8",
    );
    expect(source).toContain('kind: "better-auth-plugin"');
  });
});

describe("the example fixture", () => {
  /** The one seed set the capability contributes. */
  function seed(catalog: Parameters<typeof organization>[0]["roles"]) {
    const sets = organization({ roles: catalog, baseUrl: "https://app.example.test" }).seeds ?? [];
    expect(sets).toHaveLength(1);
    return sets[0];
  }

  test("is example-only and never reaches production", () => {
    const set = seed(dashboard);
    expect(set?.example).toBe(true);
    expect(set?.environments).toEqual(["dev", "staging"]);
  });

  test("writes the project's own role names, not the kit's idea of them", () => {
    // A fixture holding `"admin"` in a project whose roles are `coach` and `student` writes memberships
    // every gate correctly refuses — a demo that looks seeded and behaves as though nobody is a member.
    const memberships = seed(academy)?.d1?.find((group) => group.table === MEMBERSHIPS_TABLE);
    const roles = new Set((memberships?.rows ?? []).map((row) => (row as { role: string }).role));
    // The academy's first assignable administering role, and its first assignable non-administering one.
    expect([...roles].sort()).toEqual(["coach", "owner"]);
  });

  test("puts one person in two accounts, which is the only reason a chooser exists", () => {
    const memberships = seed(dashboard)?.d1?.find((group) => group.table === MEMBERSHIPS_TABLE);
    const rows = (memberships?.rows ?? []) as { userId: string; organizationId: string }[];
    const accounts = (id: string) => new Set(rows.filter((row) => row.userId === id).map((row) => row.organizationId));
    expect(accounts(EXAMPLE_GRACE.id).size).toBe(2);
    expect(accounts(EXAMPLE_ADA.id).size).toBe(1);
    expect(accounts(EXAMPLE_ALAN.id).size).toBe(1);
  });

  test("seeds no acting selection, because a selection belongs to a session", () => {
    // A session id is minted by `@pithy-sh/auth` at sign-in. A fixture that guessed one would write a
    // row pointing at nobody.
    expect(seed(dashboard)?.d1?.some((group) => group.table.includes("Acting"))).toBe(false);
  });

  test("the seeded invitation is un-redeemable — nothing hashes to its digest", () => {
    // A real digest means shipping the token that produces it, and a fixture carrying a redeemable
    // invitation is a working credential in every dev database that ever seeds it.
    const invitations = seed(dashboard)?.d1?.find((group) => group.table.includes("Invitations"));
    const rows = (invitations?.rows ?? []) as { tokenDigest: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.tokenDigest).toContain("seed-invitation-digest");
  });
});

describe("the manifest matches the capability", () => {
  /** The shipped manifest, parsed through the schema the CLI parses it with. */
  const manifest = CapabilityManifest.parse(
    JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "pithy.manifest.json"), "utf8") as string,
    ),
  );

  test("declares the same name, namespace, package, peers and bindings", () => {
    const capability = organization(BASE);
    expect(manifest.name).toBe(capability.name);
    expect(manifest.migrationNamespace).toBe(capability.name);
    expect(manifest.package).toBe("@pithy-sh/organization");
    expect([...manifest.peerCapabilities].sort()).toEqual([...(capability.dependsOn ?? [])].sort());
    expect(manifest.requiredBindings.map((binding) => `${binding.type}:${binding.name}`)).toEqual(
      capability.requiredBindings.map((binding) => `${binding.type}:${binding.name}`),
    );
  });

  test("every config option it advertises is one the config schema accepts", () => {
    // A manifest option the schema does not know is a line `pithy add` writes into pithy.config.ts that
    // the capability then ignores — silently, because an unknown key is stripped rather than refused.
    const known = new Set(Object.keys(organization(BASE).organizationConfig));
    for (const option of manifest.configOptions)
      expect([option.key, known.has(option.key)]).toEqual([option.key, true]);
  });

  test("declares the role catalog as a seam it always needs", () => {
    // There is no configuration under which the module is unnecessary, so it hangs off no option.
    expect(manifest.seams).toEqual(["organizationRoles"]);
  });

  test("the rationale argues the case against Better Auth's plugin, rather than assuming it", () => {
    // This is the paragraph an adopter reads to decide, and the question they will actually ask is why
    // not the plugin their auth library already ships.
    expect(manifest.whenToEnable).toMatch(/Better Auth/);
    expect(manifest.whenToEnable).toMatch(/refused at boot/);
    // And the property that makes the model worth the tables: a 404 that leaks nothing.
    expect(manifest.whenToEnable).toMatch(/byte-identical/);
  });

  test("the scaffold says the starter matrix is not the adopter's matrix", () => {
    // The one cost that is paid later and cannot be undone by editing the file.
    expect(manifest.scaffold.join(" ")).toContain("stable forever");
    expect(manifest.scaffold.join(" ")).toContain("src/organization/roles.ts");
  });
});

describe("a catalog nobody could found an account with", () => {
  test("is refused at assembly, not on the first Create", () => {
    // `defineRoles` cannot ask this — it does not know anything founds organizations. This capability
    // does, so it asks once, here, where the answer is a deploy failure rather than a refusal in front
    // of the first person who presses the button.
    const unfoundable = defineRoles({
      roles: {
        member: ["organization:read"],
        owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
      },
      administrativePower: "organization:manage",
      // Every role that administers is excluded from assignment, so nothing can be conferred on a
      // founder and no account could ever come into existence.
      unassignable: ["owner"],
    });
    expect(() => organization({ roles: unfoundable })).toThrow(/nobody who could found an organization/);
  });

  test("and a catalog that leaves one composes", () => {
    expect(() => organization({ roles: dashboard })).not.toThrow();
  });
});

/**
 * **Invitations the config says to mail are refused at assembly without email in the Worker** (#645 review).
 *
 * `sendInvitationEmail` defaults to true, and the invite route mails through the email capability composed beside
 * it. Without one, the first invitation anybody made was refused, and nothing before that said so — the same
 * silence as an email composed in another Worker, which this Worker's route cannot reach either.
 */
describe("the email an invitation is mailed through", () => {
  const assemble = (config: Parameters<typeof organization>[0], alongside: readonly Capability[]) => {
    const capability = organization(config);
    try {
      capability.compose?.({ capabilities: [...alongside, capability] });
      return undefined;
    } catch (error) {
      return (error as PithyError).payload;
    }
  };

  test("mailing invitations with no email in this Worker is refused, naming email and both fixes", () => {
    const said = assemble(BASE, []);
    expect(said?.message).toBe("Invitations are mailed, and no email is composed in this Worker.");
    expect(said?.action).toContain("Add `email(...)` to this Worker's capabilities");
    expect(said?.action).toContain("`sendInvitationEmail: false`");
  });

  test("with email beside it, it composes", () => {
    expect(assemble(BASE, [EMAIL])).toBeUndefined();
  });

  test("a project that delivers the link itself needs no email", () => {
    expect(assemble({ ...BASE, sendInvitationEmail: false }, [])).toBeUndefined();
  });
});
