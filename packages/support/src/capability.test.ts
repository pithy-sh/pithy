// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { unpublishedIn } from "@pithy-sh/core/src/projection/published";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { isSupportCapability, SUPPORT_MIGRATION_ORDER, type SupportCapability, support } from "./capability";
import { SUPPORT_CONTROL_PLANE_SCOPES } from "./http/scopes";
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
    // 404 every management call for exactly the adopters who customized anything.
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

/**
 * The client projection — `virtual:pithy/support`, and the one place a decision about what a browser
 * may know is made. `pithy-sh/pithy#376`.
 *
 * Four halves, on the shape `payments/src/capability.test.ts` established. An **exact-key lock**,
 * because a projection grows by somebody adding a key and the review that would have caught it is
 * this test. A **positive sweep** over the serialized result — every leaf is a fact a browser may
 * know, every key one written out by hand — so a future edit that reached for the taxonomy or an
 * inbox address fails here rather than in a bundle. A **vacuity check**, because a projection that
 * leaked nothing by projecting nothing would pass both of those perfectly. And **the gate this issue
 * was filed for**: the projected `basePath` is where the feedback routes actually mount, measured
 * against the composed route table rather than against the config it came from.
 */

/**
 * A composition that carries something forbidden of every JSON type the sweep can see, so the
 * assertions below have something to be measured by.
 *
 * The bounds are deliberately unlike the defaults. `maxSubjectChars: 200` and `maxBodyChars: 10_000`
 * are what an unconfigured project resolves to, so a projection that ignored config entirely and
 * wrote the defaults down would agree with a default fixture on every number — the one mistake the
 * bounds half of this exists to catch.
 */
const CLIENT_CONFIG = {
  inboundAddresses: ["support@help.example.com"],
  // The taxonomy: a key and the instruction a model reads. Neither is chooser copy, and neither crosses.
  categories: { billing_dispute: "The customer disagrees with a charge they can see on their statement." },
  ai: { model: "@cf/meta/llama-3.1-70b-instruct", maxChars: 4321 },
  guard: { maxPerSenderPerHour: 77, authservId: "mx.acme.example" },
  attachments: { maxBytes: 9_876_543 },
  reply: {
    replyToAddress: "answers@help.example.com",
    // A boolean the config carries and the bundle must not. The leaf half is blind to this whole JSON
    // type by construction — `true` is published, because `enabled` is — so the key half is the only
    // one that can police it, and it needs something to police.
    deliverInApp: true,
    snippets: { refund: { label: "Refund issued", category: "billing", body: "Hi {{name}}, refunded." } },
  },
  search: { fts: true },
  submission: {
    maxSubjectChars: 140,
    maxBodyChars: 6_500,
    maxPerAccountPerHour: 7,
    attachments: { maxCount: 2, maxBytes: 1_234_567, allowedContentTypes: ["image/png", "text/plain"] },
  },
};

/**
 * Every key the projection may carry, at any depth. Seven.
 *
 * **Written out, never `Object.keys(...)` of the projection or its type.** A gate that reads its own
 * subject cannot fail when the subject changes — deriving the permitted set from the thing being
 * policed widens the permission in the same commit that widens the projection, and the test whose
 * whole job is to catch that passes. Adding a key to a browser bundle means editing this line.
 */
const PUBLISHED_CLIENT_KEYS = [
  "enabled",
  "basePath",
  "submission",
  "maxSubjectChars",
  "maxBodyChars",
  "attachments",
  "maxCount",
  "maxBytes",
  "allowedContentTypes",
];

/** Every `METHOD /path` a composed capability actually mounts. The route table, not the config. */
function mountedRoutes(capability: SupportCapability): string[] {
  const app = new Hono<PithyHonoEnv>();
  capability.routes?.(app);
  return app.routes.map((route) => `${route.method} ${route.path}`);
}

describe("support().client — virtual:pithy/support", () => {
  const projection = resolveClientProjection(composed(CLIENT_CONFIG), { environment: "prod" });

  test("projects exactly three keys, and under submission exactly three more", () => {
    expect(Object.keys(projection).sort()).toEqual(["basePath", "enabled", "submission"]);
    const submission = projection.submission as Record<string, unknown>;
    expect(Object.keys(submission).sort()).toEqual(["attachments", "maxBodyChars", "maxSubjectChars"]);
    expect(Object.keys(submission.attachments as Record<string, unknown>).sort()).toEqual([
      "allowedContentTypes",
      "maxBytes",
      "maxCount",
    ]);
  });

  test("nothing but what a browser may know crosses it, whatever a field is called", () => {
    // Serialized and re-parsed on purpose: `JSON.stringify` is how this reaches a bundle, so what the
    // sweep walks is exactly what an adopter's users receive.
    const inlined: unknown = JSON.parse(JSON.stringify(projection));
    const escaped = unpublishedIn(inlined, {
      // The envelope, the address, and the bounds a compose form holds somebody to. Nothing else.
      leaves: [true, "/support", 140, 6_500, 2, 1_234_567, "image/png", "text/plain"],
      keys: PUBLISHED_CLIENT_KEYS,
    });
    expect(
      escaped,
      `These reached an adopter's users and are not the mount path or a bound a submission form enforces:\n  ${escaped.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the composition really carries everything the sweep is meant to refuse", () => {
    // A gate over nothing passes perfectly. The config the assertion above reads must genuinely hold
    // the taxonomy, the addresses, the model, the mail bounds and a flag, or that test proves nothing.
    const serialized = JSON.stringify(CLIENT_CONFIG);
    for (const withheld of [
      "support@help.example.com",
      "answers@help.example.com",
      "billing_dispute",
      "The customer disagrees with a charge",
      "@cf/meta/llama-3.1-70b-instruct",
      "4321",
      "77",
      "mx.acme.example",
      "9876543",
      "Refund issued",
      // The rate a client cannot pre-enforce honestly, and the two booleans.
      '"maxPerAccountPerHour":7',
      '"deliverInApp":true',
      '"fts":true',
    ]) {
      expect(serialized, withheld).toContain(withheld);
    }
  });

  test("what is meant to cross does cross — a sweep over nothing would pass perfectly", () => {
    const serialized = JSON.stringify(projection);
    expect(serialized).toContain("/support");
    expect(serialized).toContain("140");
    expect(serialized).toContain("6500");
    expect(serialized).toContain("image/png");
    expect(serialized).not.toContain("undefined");
  });

  test("carries the configured bounds, not the kit's defaults", () => {
    // The defaults are 200 and 10_000. A projection that wrote them down would be a second copy of
    // the config rather than a reading of it, and every adopter who tuned a bound would ship a form
    // holding people to a number their handler does not enforce.
    expect(projection.submission).toEqual({
      maxSubjectChars: 140,
      maxBodyChars: 6_500,
      attachments: { maxCount: 2, maxBytes: 1_234_567, allowedContentTypes: ["image/png", "text/plain"] },
    });
  });

  test("attachments off is null, so a screen renders no file picker on one check", () => {
    const off = resolveClientProjection(composed({ submission: { attachments: { enabled: false } } }), {
      environment: "prod",
    });
    expect((off.submission as Record<string, unknown>).attachments).toBeNull();
  });

  test("the submission channel off is { enabled: false } — there is no route for a browser to call", () => {
    // `registerSupportRoutes` does not mount the feedback routes when submission is off; they answer
    // 404. So "composed with the channel closed" has to read the same as "not composed at all", and a
    // screen branches on `enabled` rather than guarding down two levels.
    const closed = composed({ submission: { enabled: false } });
    expect(resolveClientProjection(closed, { environment: "prod" })).toEqual({ enabled: false });
    expect(mountedRoutes(closed).some((route) => route.includes("/feedback"))).toBe(false);
  });

  test("an uncomposed capability is { enabled: false } too", () => {
    expect(resolveClientProjection(undefined, { environment: "prod" })).toEqual({ enabled: false });
  });
});

/**
 * **The gate: move `basePath` and a client that reads the projection follows; one that wrote it down
 * breaks.**
 *
 * Measured against the **composed route table**, never against `capability.basePath` or the option
 * that produced it. Both of those are the projection's own source, so comparing to either would let a
 * projection that faithfully published a path nothing serves pass green — the failure this issue
 * describes, restated one layer in. The route table is the independent authority: it is where a
 * request actually lands.
 */
describe("the address a browser posts a submission to", () => {
  test("**the projected basePath is where the feedback routes actually mount**", () => {
    const moved = composed({ basePath: "/help" });
    const projected = resolveClientProjection(moved, { environment: "prod" }).basePath;
    const routes = mountedRoutes(moved);
    // Built from what the projection published, checked against what the router registered. A
    // projection stuck on `/support` names three routes this table does not contain.
    expect(routes).toEqual(
      expect.arrayContaining([
        `POST ${projected}/feedback`,
        `GET ${projected}/feedback`,
        `GET ${projected}/feedback/:id`,
      ]),
    );
    // And the old address is gone, so a client that hardcoded it gets the 404 this is about.
    expect(routes.some((route) => route.startsWith("POST /support/"))).toBe(false);
  });

  test("the literal, so the gate above cannot be satisfied by an empty route table", () => {
    expect(resolveClientProjection(composed({ basePath: "/help" }), { environment: "prod" }).basePath).toBe("/help");
    expect(resolveClientProjection(composed(), { environment: "prod" }).basePath).toBe("/support");
    expect(mountedRoutes(composed())).toContain("POST /support/feedback");
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
