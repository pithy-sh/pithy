// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError } from "../error/pithyError";
import { FEATURE_RESOURCE_KINDS } from "./feature";
import { environmentScope, FEATURE_ENVIRONMENT, featureScope } from "./provisionScope";

const PROJECTS = ["acme", "replay", "a", "twenty-six-characters-long"];
const ENVIRONMENTS = ["staging", "prod", "live", "qa"];
const BINDINGS = ["DB", "SESSIONS", "ASSETS", "COLLAB_DB"];
const WORKERS = ["board", "acme-api", "web"];

/** Is `segment` a whole hyphen-delimited segment of `name`? Never a substring match. */
function hasSegment(name: string, segment: string): boolean {
  return name.split("-").includes(segment);
}

describe("environmentScope", () => {
  it("writes into the stanza it is named for", () => {
    for (const env of ENVIRONMENTS) {
      expect(environmentScope("acme", env).stanza).toBe(env);
    }
  });

  /**
   * **The gate.** Every name a scope produces carries that scope's own environment segment.
   *
   * This is the invariant `pithy feature provision --env staging` broke: it composed
   * `<project>-f<issue>-<slug>-db` and wrote it into the `staging` stanza, so `staging`'s `DB` was a
   * feature's database under a name naming no environment at all. The stanza and the namer were two
   * arguments, and nothing held them together.
   */
  it("puts the environment segment in every name it composes", () => {
    for (const project of PROJECTS) {
      for (const env of ENVIRONMENTS) {
        const scope = environmentScope(project, env);
        for (const binding of BINDINGS) {
          for (const kind of FEATURE_RESOURCE_KINDS) {
            expect(hasSegment(scope.resource(binding, kind), scope.stanza)).toBe(true);
          }
        }
        for (const worker of WORKERS) {
          expect(hasSegment(scope.worker(worker), scope.stanza)).toBe(true);
        }
      }
    }
  });

  it("composes <project>-<env>-<binding>, the rule every other namer follows", () => {
    const scope = environmentScope("replay", "staging");
    expect(scope.resource("DB", "d1")).toBe("replay-staging-db");
    expect(scope.resource("SESSIONS", "kv")).toBe("replay-staging-sessions");
    expect(scope.resource("ASSETS", "r2")).toBe("replay-staging-assets");
  });

  /**
   * A named environment's Worker script name is wrangler's own — `<script>-<env>` — because that is
   * what every `wrangler deploy --env <name>` has already deployed under. Renaming it would orphan the
   * deployment and every `service` binding pointing at it.
   */
  it("names a Worker as wrangler already deploys it", () => {
    expect(environmentScope("replay", "staging").worker("replay-board")).toBe("replay-board-staging");
  });

  /**
   * A Secrets Store entry name is the only partition an account-flat store has, so it follows the
   * same rule every other name does — except for a `global` secret, which is one value every
   * environment binds and therefore carries the reserved `global` segment instead.
   */
  it("scopes an environment secret to the environment and a global one to `global`", () => {
    const scope = environmentScope("replay", "staging");
    expect(scope.secretEntry("SECRETS_ENCRYPTION_KEYS", "environment")).toBe("replay-staging-secrets-encryption-keys");
    expect(scope.secretEntry("STRIPE_API_KEY", "global")).toBe("replay-global-stripe-api-key");
  });

  it("refuses an environment no name may carry", () => {
    expect(() => environmentScope("acme", "production")).toThrow(PithyError);
    expect(() => environmentScope("acme", "global")).toThrow(PithyError);
  });
});

describe("featureScope", () => {
  const identity = { project: "replay", issue: "241", slug: "environments" };

  it("writes into the one stanza a feature has", () => {
    expect(featureScope(identity).stanza).toBe(FEATURE_ENVIRONMENT);
  });

  /**
   * A feature's names carry no environment segment — a feature *is* an environment — so the invariant
   * takes its own form here: every name carries the `f<issue>` marker that makes it a feature's, and
   * that is what teardown recomputes and what tells it apart from a deployed environment's.
   */
  it("puts the feature marker in every name it composes", () => {
    const scope = featureScope(identity);
    for (const binding of BINDINGS) {
      for (const kind of FEATURE_RESOURCE_KINDS) {
        expect(hasSegment(scope.resource(binding, kind), "f241")).toBe(true);
      }
    }
    for (const worker of WORKERS) {
      expect(hasSegment(scope.worker(worker), "f241")).toBe(true);
    }
  });

  it("composes the names feature provision already provisioned under", () => {
    const scope = featureScope(identity);
    expect(scope.resource("DB", "d1")).toBe("replay-f241-environments-db-d1");
    expect(scope.worker("replay-board")).toBe("replay-f241-environments-replay-board");
  });

  /**
   * **A feature's own master key, under its own name.** `deprovisionSecrets` preserves a key unless
   * explicitly asked, because losing it orphans every stored secret. For an ephemeral environment that
   * reasoning inverts — nothing outlives it — so the key is the feature's and goes with it. Which
   * means it must be named the feature's, or teardown would delete an environment's.
   */
  it("gives a feature its own environment-scoped secret entries, and shares the global ones", () => {
    const scope = featureScope(identity);
    expect(scope.secretEntry("SECRETS_ENCRYPTION_KEYS", "environment")).toBe(
      "replay-f241-environments-secrets-encryption-keys",
    );
    // A `global` secret is one account-level value every environment binds. A feature binds the
    // project's, so feature-scoping it would mint a second copy of a value that is meant to be one.
    expect(scope.secretEntry("STRIPE_API_KEY", "global")).toBe("replay-global-stripe-api-key");
  });

  it("cannot collide with a deployed environment's secret entries either", () => {
    const feature = featureScope(identity);
    for (const env of ENVIRONMENTS) {
      expect(environmentScope("replay", env).secretEntry("SECRETS_ENCRYPTION_KEYS", "environment")).not.toBe(
        feature.secretEntry("SECRETS_ENCRYPTION_KEYS", "environment"),
      );
    }
  });

  /**
   * No feature name may collide with a deployed environment's, in either direction — the account's
   * namespaces are flat, so a collision is one environment adopting another's database.
   */
  it("cannot collide with a deployed environment's names", () => {
    const feature = featureScope(identity);
    const deployed = ENVIRONMENTS.map((env) => environmentScope("replay", env));
    for (const binding of BINDINGS) {
      for (const kind of FEATURE_RESOURCE_KINDS) {
        const name = feature.resource(binding, kind);
        for (const scope of deployed) expect(scope.resource(binding, kind)).not.toBe(name);
      }
    }
  });
});
