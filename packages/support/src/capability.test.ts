// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { isSupportCapability, SUPPORT_MIGRATION_ORDER, support } from "./capability";
import { SUPPORT_CONTROL_PLANE_SCOPES } from "./http/guards";
import { supportWorkflows } from "./workflows/specs";

/** The address every build below claims — the one field with no default, on a subdomain as the config insists. */
const INBOUND = ["support@help.example.com"];

/** A support capability with the minimum an adopter must supply. */
function composed(options: Parameters<typeof support>[0] = {}) {
  return support({ inboundAddresses: INBOUND, ...options });
}

describe("support capability", () => {
  test("contributes its five tables to the app database on the DB binding", () => {
    const db = composed().databases?.app;
    expect(db?.binding).toBe("DB");
    expect(Object.keys(db?.tables ?? {})).toEqual([
      "pithySupportThreads",
      "pithySupportMessages",
      "pithySupportAttachments",
      "pithySupportClassifications",
      "pithySupportThreadFlags",
    ]);
  });

  // Table keys are camelCase (CamelCasePlugin emits the snake_case `pithy_support_` SQL); every
  // provided table must be namespaced under the capability so it can't clash with an adopter's.
  test("every provided table is namespaced under pithySupport (the pithy_support_ prefix)", () => {
    for (const name of Object.keys(composed().databases?.app?.tables ?? {})) {
      expect(name.startsWith("pithySupport")).toBe(true);
    }
  });

  test("sorts at 1200, the order allocated to it and stable forever", () => {
    // Renumbering renames every composed migration key, and Kysely then reads applied migrations as
    // unapplied and re-runs them. The literal is here so a change to the constant fails loudly.
    expect(composed().databases?.app?.migrationOrder).toBe(SUPPORT_MIGRATION_ORDER);
    expect(SUPPORT_MIGRATION_ORDER).toBe(1200);
  });

  test("composes only 0001_threads by default — the FTS index is opt-in", () => {
    // An FTS5 virtual table anywhere in a D1 database makes `wrangler d1 export` refuse to dump the
    // whole database. Shipping it by default would cost an adopter their backups for tables that
    // have nothing to do with support, so the default must stay one migration.
    expect(Object.keys(composed().databases?.app?.migrations ?? {})).toEqual(["0001_threads"]);
  });

  test("the migration set is the same whether search.fts is on or off", () => {
    // The FTS index left the ledger deliberately. It is derived from the messages table and
    // rebuildable, so it is provisioned like the bucket and the routing rule — and a config flag that
    // could add or remove a migration was able to corrupt the set shared by every capability in the
    // database, which is a whole-database outage from one capability's setting.
    const off = Object.keys(support({ search: { fts: false } }).databases?.app?.migrations ?? {});
    const on = Object.keys(support({ search: { fts: true } }).databases?.app?.migrations ?? {});
    expect(off).toEqual(["0001_threads"]);
    expect(on).toEqual(off);
  });

  test("requires DB, and leaves the bucket and the classify workflow optional", () => {
    const bindings = Object.fromEntries(composed().requiredBindings.map((binding) => [binding.name, binding]));
    expect(bindings.DB).toMatchObject({ type: "d1", optional: false });
    // An inbox with attachments off never writes an object, and a project that has not provisioned
    // must still boot and still receive mail — a required bucket would break both.
    expect(bindings.SUPPORT_BUCKET).toMatchObject({ type: "r2", optional: true });
    // The workflow binding is derived from the spec rather than typed a second time. Asserting the
    // literal name here is what catches a rename in specs.ts that provisioning would then miss.
    expect(supportWorkflows.classify.binding).toBe("SUPPORT_CLASSIFY");
    expect(bindings.SUPPORT_CLASSIFY).toMatchObject({ type: "workflow", optional: true });
  });

  test("depends on secrets, because attachment presigning reads an R2 credential through it", () => {
    expect(composed().dependsOn).toContain("secrets");
  });

  test("claims inbound mail with an email handler", () => {
    // A Worker has one `email()` entry and the entrypoint fans every message to each capability that
    // declares a handler. No handler means mail arrives and support never sees it.
    expect(typeof composed().email).toBe("function");
  });
});

describe("the admin surface support advertises", () => {
  test("declares an admin route for every management operation, each naming a scope", () => {
    const routes = composed().adminRoutes ?? [];
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => Boolean(route.scope))).toBe(true);
  });

  test("advertises exactly the five scopes support defines — no sixth, and none unused", () => {
    // The scopes are the join key with what `pithy dashboard connect` offers an adopter to grant. A
    // manifest naming a scope outside this set tells a client to ask for a grant nothing checks;
    // a scope in the set that nothing advertises is a permission no client can discover it needs.
    const scopes = new Set((composed().adminRoutes ?? []).map((route) => route.scope));
    expect(scopes).toEqual(new Set(SUPPORT_CONTROL_PLANE_SCOPES));
    expect(SUPPORT_CONTROL_PLANE_SCOPES).toHaveLength(5);
  });

  test("mounts under /support by default", () => {
    const capability = composed();
    expect(capability.basePath).toBe("/support");
    expect((capability.adminRoutes ?? []).every((route) => route.path.startsWith("/support/"))).toBe(true);
  });

  test("a moved base path moves the advertised routes with it", () => {
    // The case that motivated describing routes at all: a manifest naming the default path would
    // 404 every management call for exactly the adopters who customised anything.
    const capability = composed({ basePath: "/inbox" });
    expect(capability.basePath).toBe("/inbox");
    expect((capability.adminRoutes ?? []).map((route) => route.path)).toEqual([
      "/inbox/threads",
      "/inbox/threads/:id",
      "/inbox/threads/:id/archive",
      "/inbox/threads/:id/reply",
      "/inbox/threads/:id/reclassify",
      "/inbox/threads/:id/flags",
      "/inbox/replies",
    ]);
  });
});

describe("isSupportCapability", () => {
  test("narrows the composed capability to its resolved config", () => {
    const capability: Capability = composed();
    expect(isSupportCapability(capability)).toBe(true);
    // The narrowing is the point: the branch below only typechecks if the guard did its job.
    if (isSupportCapability(capability)) expect(capability.supportConfig.inboundAddresses).toEqual(INBOUND);
  });

  test("rejects a foreign capability", () => {
    const other = { name: "email", requiredBindings: [] } as Capability;
    expect(isSupportCapability(other)).toBe(false);
  });
});
