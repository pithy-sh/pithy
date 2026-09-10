// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { describe, expect, test } from "vitest";
import { appendBinding, generatedFieldDrift, rateLimitNamespaceId, type WranglerStanza } from "./bindingEntries";

/**
 * The generated half of a binding entry: the value the writer derives, and the comparison that notices
 * when a project's stanza no longer holds it (#499).
 *
 * The derivation was made stable so a limiter's budget could not be renumbered by a neighbor being
 * removed. What it was **not** given is a retrofit — nothing rewrites an entry already on disk — and the
 * docstring claimed otherwise for months while a project scaffolded on the positional counter kept `1001`
 * against a green `pithy doctor`. This file pins both halves: the derivation, and the report that is the
 * whole of the remedy.
 */

const LIMITER = BindingSpec.parse({ type: "ratelimit", name: "AUTH_RATE_LIMITER" });
const SCOPE = { project: "acme", env: "dev", capability: "auth" };

describe("rateLimitNamespaceId", () => {
  test("derives the id from the binding name, and nothing else", () => {
    // Reimplemented rather than pasted, on the issue's own method: an expectation copied from the output
    // is a pin on whatever the function does, which is not the same as a pin on what it is meant to do.
    const fnv1a = (binding: string): string => {
      let hash = 0x811c9dc5;
      for (const character of binding) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return String(1000 + (hash % 9000));
    };
    expect(rateLimitNamespaceId("AUTH_RATE_LIMITER")).toBe(fnv1a("AUTH_RATE_LIMITER"));
    expect(rateLimitNamespaceId("AUTH_RATE_LIMITER")).toBe("3093");
  });

  test("two bindings do not share a budget", () => {
    expect(rateLimitNamespaceId("AUTH_RATE_LIMITER")).not.toBe(rateLimitNamespaceId("SUPPORT_RATE_LIMITER"));
  });
});

describe("a binding's declared naming", () => {
  /** The suppression database as `@pithy-sh/email` needs it: one per project, not one per environment. */
  const suppressions = BindingSpec.parse({ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" });

  test("writes the project's one name into whichever stanza it is filling", () => {
    for (const env of ["dev", "staging", "prod"]) {
      const stanza: WranglerStanza = {};
      appendBinding(stanza, suppressions, { ...SCOPE, env, capability: "email" });
      expect(stanza.d1_databases).toEqual([
        { binding: "EMAIL_SUPPRESSIONS", database_name: "acme-global-email-suppressions" },
      ]);
    }
  });

  /**
   * **The environment guard sits below the global branch, and this is the case that says so.**
   *
   * A stanza key the naming scheme refuses proposes nothing for an ordinary binding — a name with an
   * eleven-character environment in it is a name no command would recompute the same way. A global name
   * has no environment segment at all, so none of that applies: withholding it there would leave one
   * stanza pointing at nothing, in the one case where every stanza has to point at the same thing.
   */
  test("proposes a project-global name even in a stanza the naming scheme refuses", () => {
    const scope = { ...SCOPE, env: "integration", capability: "email" };
    const global: WranglerStanza = {};
    appendBinding(global, suppressions, scope);
    expect(global.d1_databases).toEqual([
      { binding: "EMAIL_SUPPRESSIONS", database_name: "acme-global-email-suppressions" },
    ]);

    // And the control beside it: the per-environment binding in the same stanza still proposes nothing,
    // so this is the global branch answering and not the guard having been deleted.
    const scoped: WranglerStanza = {};
    appendBinding(scoped, BindingSpec.parse({ type: "d1", name: "DB" }), scope);
    expect(scoped.d1_databases).toEqual([{ binding: "DB" }]);
  });

  test("proposes the `<thing>` the binding declares, not the binding", () => {
    const stanza: WranglerStanza = {};
    const write = appendBinding(
      stanza,
      BindingSpec.parse({ type: "kv", name: "MEDIA_CACHE", resource: "media" }),
      SCOPE,
    );
    expect(write).toEqual({
      outcome: "written",
      proposed: { binding: "MEDIA_CACHE", env: "dev", name: "acme-dev-media" },
    });
  });

  test("a binding with no opinion is named exactly as it always was", () => {
    const stanza: WranglerStanza = {};
    appendBinding(stanza, BindingSpec.parse({ type: "d1", name: "EMAIL_SUPPRESSIONS" }), SCOPE);
    expect(stanza.d1_databases).toEqual([
      { binding: "EMAIL_SUPPRESSIONS", database_name: "acme-dev-email-suppressions" },
    ]);
  });
});

describe("generatedFieldDrift", () => {
  /** A stanza with one limiter in it, at whatever `namespace_id` the caller says. */
  const stanzaAt = (namespaceId: string): WranglerStanza => ({
    ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: namespaceId, simple: { limit: 20, period: 60 } }],
  });

  test("says nothing about the entry this writer would write itself", () => {
    // The anti-vacuity guard for every case below: what `appendBinding` writes must compare clean, or a
    // report that fired on everything would be indistinguishable from one that fires on the right thing.
    const stanza: WranglerStanza = {};
    appendBinding(stanza, LIMITER, SCOPE);
    expect(generatedFieldDrift(stanza, LIMITER)).toEqual([]);
  });

  test("names both numbers for an id the positional counter produced", () => {
    expect(generatedFieldDrift(stanzaAt("1001"), LIMITER)).toEqual([
      { field: "namespace_id", expected: "3093", actual: "1001" },
    ]);
  });

  test("a tuned limit is the feature working, so it is not reported", () => {
    // `RATE_LIMIT_REQUESTS` is 100 and this stanza says 20. The writer's own comment hands that number to
    // the adopter — reporting it would be calling a tuned limiter drift.
    expect(generatedFieldDrift(stanzaAt("3093"), LIMITER)).toEqual([]);
  });

  test("an unquoted id in a hand-edited stanza is the same value, not a difference", () => {
    const stanza = {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: 3093, simple: { limit: 100, period: 60 } }],
    } as unknown as WranglerStanza;
    expect(generatedFieldDrift(stanza, LIMITER)).toEqual([]);
  });

  test("a binding the stanza does not carry is a missing binding, which something else reports", () => {
    expect(generatedFieldDrift({}, LIMITER)).toEqual([]);
    expect(generatedFieldDrift({ ratelimits: [] }, LIMITER)).toEqual([]);
  });

  test("an entry with no id at all is wrangler's refusal to make, not a wrong number", () => {
    const stanza = {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", simple: { limit: 100, period: 60 } }],
    } as unknown as WranglerStanza;
    expect(generatedFieldDrift(stanza, LIMITER)).toEqual([]);
  });

  test("kinds whose value the kit hands over, or reports elsewhere, are left alone", () => {
    // A D1 `database_name` is a proposal an adopter is meant to be able to change, and a `workflows`
    // entry already has its own comparison in `project/workflows.ts`. Both would be noise here.
    const d1 = BindingSpec.parse({ type: "d1", name: "DB" });
    expect(generatedFieldDrift({ d1_databases: [{ binding: "DB", database_name: "our-own-db" }] }, d1)).toEqual([]);
    const workflow = BindingSpec.parse({
      type: "workflow",
      name: "EMAIL_SENDER",
      className: "EmailSender",
      job: "send",
    });
    expect(
      generatedFieldDrift(
        { workflows: [{ binding: "EMAIL_SENDER", name: "renamed", class_name: "EmailSender", script_name: "old" }] },
        workflow,
      ),
    ).toEqual([]);
  });
});
