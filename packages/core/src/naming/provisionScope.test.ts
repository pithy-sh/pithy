// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError } from "../error/pithyError";
import { FEATURE_ENVIRONMENT, GLOBAL_SCOPE } from "./environment";
import { FEATURE_RESOURCE_KINDS } from "./feature";
import { NAMESPACE_LIMITS } from "./limits";
import {
  type BindingNaming,
  bindingResourceName,
  environmentScope,
  featureScope,
  featureWorkerScriptNames,
  type ProvisionWorkerNames,
} from "./provisionScope";

const PROJECTS = ["acme", "replay", "a", "twenty-six-characters-long"];
const ENVIRONMENTS = ["staging", "prod", "live", "qa"];

/**
 * The bindings every invariant below is swept over — and **a project-global one is in the list**.
 *
 * It has to be. The two invariants in this file ("puts the environment segment in every name", "cannot
 * collide with a deployed environment's names") were green the day `scope` landed, and green for a
 * reason that is not a property of the code: no spec in this fixture exercised the branch. A gate that
 * survives by omitting the case is not a gate, so the case is here and each invariant states what it
 * means for it, rather than being narrowed to skip it.
 */
const BINDINGS: readonly { binding: string; naming: BindingNaming }[] = [
  { binding: "DB", naming: {} },
  { binding: "SESSIONS", naming: {} },
  { binding: "ASSETS", naming: {} },
  { binding: "COLLAB_DB", naming: {} },
  // A `<thing>` segment that is not the binding, and still one resource per environment — the #519 half
  // of the pair, where only the last segment moves.
  { binding: "MEDIA_BUCKET", naming: { resource: "media" } },
  // One resource for the whole project: the #513 case, and the one that leaves the environment segment.
  { binding: "EMAIL_SUPPRESSIONS", naming: { scope: "global" } },
  // Both halves at once, which is the shape `support` actually ships.
  { binding: "SUPPORT_BUCKET", naming: { scope: "global", resource: "support" } },
];

/**
 * Workers as the scaffolder leaves them: a directory under `apps/`, and a deploy name that usually leads
 * with the project and sometimes does not. The two differ in every row, so a scope reading the wrong one
 * composes a different string rather than the same one by coincidence.
 */
const WORKERS: readonly ProvisionWorkerNames[] = [
  { app: "board", script: "replay-board" },
  { app: "api", script: "acme-api" },
  { app: "web", script: "web-app" },
];

/** The scope segment a binding's name must carry: the stanza it lives in, or `global` if it said so. */
function owningScope(stanza: string, naming: BindingNaming): string {
  return naming.scope === GLOBAL_SCOPE ? GLOBAL_SCOPE : stanza;
}

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
   * **The gate.** Every name a scope produces carries the segment of the scope that *owns* the thing —
   * this environment for everything it owns alone, and `global` for the resources the whole project
   * shares.
   *
   * This is the invariant an environment passed beside a feature's namer broke: it composed
   * `<project>-f<issue>-<slug>-db` and wrote it into the `staging` stanza, so `staging`'s `DB` was a
   * feature's database under a name naming no environment at all. The stanza and the namer were two
   * arguments, and nothing held them together.
   *
   * A global binding is not a hole in that. `global` is a scope beside the environments and never one of
   * them — an environment may not even be *called* it — so the segment still answers "who owns this",
   * and a feature's `f241` would still fail here.
   */
  it("puts its owning scope's segment in every name it composes", () => {
    for (const project of PROJECTS) {
      for (const env of ENVIRONMENTS) {
        const scope = environmentScope(project, env);
        for (const { binding, naming } of BINDINGS) {
          for (const kind of FEATURE_RESOURCE_KINDS) {
            const name = scope.resource(binding, kind, naming);
            expect(hasSegment(name, owningScope(scope.stanza, naming))).toBe(true);
            // The other half, and the one that makes the line above worth its `global` branch: a
            // project resource carries the environment's segment nowhere, or it would be one resource
            // per environment wearing a shared name.
            if (naming.scope === GLOBAL_SCOPE) expect(hasSegment(name, scope.stanza)).toBe(false);
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
    expect(scope.resource("DB", "d1", {})).toBe("replay-staging-db");
    expect(scope.resource("SESSIONS", "kv", {})).toBe("replay-staging-sessions");
    expect(scope.resource("ASSETS", "r2", {})).toBe("replay-staging-assets");
  });

  /**
   * A binding that says nothing composes byte for byte what it composed before `scope` and `resource`
   * existed — the whole reason both are `.optional()` and neither is defaulted. `kebab` runs inside the
   * one composer, so the binding name reaches it verbatim and comes out as it always did.
   */
  it("changes nothing for a binding with no opinion", () => {
    const scope = environmentScope("replay", "staging");
    for (const { binding } of BINDINGS) {
      for (const kind of FEATURE_RESOURCE_KINDS) {
        expect(scope.resource(binding, kind, {})).toBe(scope.resource(binding, kind, { scope: "environment" }));
      }
    }
    expect(scope.resource("EMAIL_SUPPRESSIONS", "d1", {})).toBe("replay-staging-email-suppressions");
    expect(scope.resource("SUPPORT_BUCKET", "r2", {})).toBe("replay-staging-support-bucket");
  });

  /**
   * The two fields, doing the two things #513 and #519 need them to do: one resource for the project,
   * and a `<thing>` segment that is not the binding.
   */
  it("names a project-global resource once, under `global`", () => {
    const scope = environmentScope("acme", "staging");
    expect(scope.resource("EMAIL_SUPPRESSIONS", "d1", { scope: "global" })).toBe("acme-global-email-suppressions");
    expect(scope.resource("SUPPORT_BUCKET", "r2", { scope: "global", resource: "support" })).toBe(
      "acme-global-support",
    );
    expect(scope.resource("MEDIA_BUCKET", "r2", { resource: "media" })).toBe("acme-staging-media");
  });

  /** And the point of it: every environment resolves a global binding to the identical string. */
  it("gives every environment the same name for a project-global resource", () => {
    const names = new Set(
      ENVIRONMENTS.map((env) =>
        environmentScope("acme", env).resource("EMAIL_SUPPRESSIONS", "d1", { scope: "global" }),
      ),
    );
    expect([...names]).toEqual(["acme-global-email-suppressions"]);
  });

  /**
   * A named environment's Worker script name is wrangler's own — `<script>-<env>` — because that is
   * what every `wrangler deploy --env <name>` has already deployed under. Renaming it would orphan the
   * deployment and every `service` binding pointing at it.
   */
  it("names a Worker as wrangler already deploys it", () => {
    const scope = environmentScope("replay", "staging");
    expect(scope.worker({ app: "board", script: "replay-board" })).toBe("replay-board-staging");
    // A name the stanza already carries wins over the fallback (#580).
    expect(scope.worker({ app: "board", script: "replay-board" }, "replay-staging-board")).toBe("replay-staging-board");
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
    for (const { binding, naming } of BINDINGS) {
      for (const kind of FEATURE_RESOURCE_KINDS) {
        expect(hasSegment(scope.resource(binding, kind, naming), "f241")).toBe(true);
      }
    }
    for (const worker of WORKERS) {
      expect(hasSegment(scope.worker(worker), "f241")).toBe(true);
    }
  });

  it("composes the names a feature's resources are provisioned under", () => {
    const scope = featureScope(identity);
    expect(scope.resource("DB", "d1", {})).toBe("replay-f241-environments-db-d1");
    expect(scope.worker({ app: "board", script: "replay-board" })).toBe("replay-f241-environments-board");
  });

  /**
   * **The gate for #587: a feature Worker is `<project>-f<issue>-<slug>-<app>`, composed from its directory.**
   *
   * It was composed from the deploy name, which already leads with the project, so every feature Worker
   * carried it twice — `replay-f241-environments-replay-board`. Stated as the exact string over projects
   * that are a prefix of no worker's directory, so a doubled segment cannot satisfy it by coincidence, and
   * over a deploy name that does not lead with the project at all (`web-app`), so a scope that strips a
   * `<project>-` prefix off the deploy name instead of reading the directory fails too.
   *
   * **What it does not see.** This holds the scope. It does not hold a caller that hands the scope the
   * wrong names — `{ app: script, script }` passes here and doubles the project in a real run. That half is
   * `provision.test.ts`'s ("one address per feature Worker"), which runs `provisionFeature` over scaffolded
   * directories and compares the deploy name, the report and every service target. Nor does it see a name
   * composed without a scope at all: `featureWorkerName` takes a plain string and cannot tell a directory
   * from a deploy name.
   */
  it("names a feature Worker from its directory, so the project appears once", () => {
    for (const project of PROJECTS) {
      const scope = featureScope({ project, issue: "241", slug: "environments" });
      for (const worker of WORKERS) {
        expect(scope.worker(worker)).toBe(`${project}-f241-environments-${worker.app}`);
        // A declared name is ignored — a feature's is the kit's, recomputed rather than read.
        expect(scope.worker(worker, `${project}-staging-${worker.app}`)).toBe(
          `${project}-f241-environments-${worker.app}`,
        );
      }
    }
  });

  /**
   * The length budget, measured against the corrected shape. `acme-f1-` is 8 characters and the slug 20,
   * so a 34-character directory lands exactly on the Worker cap of 63 and survives verbatim. The doubled
   * shape spent five more characters on a second `acme-` and paid for them by hashing the slug — the
   * segment that says which branch this is.
   */
  it("fits a feature Worker at the cap without spending it on the project twice", () => {
    const scope = featureScope({ project: "acme", issue: "1", slug: "s".repeat(20) });
    const app = "w".repeat(NAMESPACE_LIMITS.worker.maxLength - "acme-f1-".length - 20 - 1);
    const name = scope.worker({ app, script: `acme-${app}` });
    expect(name).toBe(`acme-f1-${"s".repeat(20)}-${app}`);
    expect(name.length).toBe(NAMESPACE_LIMITS.worker.maxLength);
  });

  /**
   * **A feature takes the naming and ignores it, and the asymmetry against `secretEntry` is deliberate.**
   * A global secret is a value the feature *reads*, so it binds the project's copy. A global database is
   * a resource the feature would *migrate* — `provisionFeature` runs `pithy migrate` over everything it
   * names — so honoring `global` here would point one branch's schema changes at the project's live
   * suppression list, and point teardown at it afterwards. A feature owns every resource it names.
   */
  it("gives a feature its own resource even where the binding says the project shares one", () => {
    const scope = featureScope(identity);
    for (const naming of [{}, { scope: "global" as const }, { scope: "global" as const, resource: "support" }]) {
      expect(scope.resource("EMAIL_SUPPRESSIONS", "d1", naming)).toBe("replay-f241-environments-email-suppressions-d1");
    }
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
   *
   * **Including the project-global ones**, which is the case that would matter most: a feature colliding
   * with `<project>-global-email-suppressions` is a branch migrating and then deleting the project's
   * live suppression list. It cannot, because the feature ignores the naming and keeps its `f<issue>`
   * marker — but that is a property to assert, not one to trust, so the fixture carries the case.
   */
  it("cannot collide with a deployed environment's names", () => {
    const feature = featureScope(identity);
    const deployed = ENVIRONMENTS.map((env) => environmentScope("replay", env));
    for (const { binding, naming } of BINDINGS) {
      for (const kind of FEATURE_RESOURCE_KINDS) {
        const name = feature.resource(binding, kind, naming);
        for (const scope of deployed) expect(scope.resource(binding, kind, naming)).not.toBe(name);
      }
    }
  });
});

/**
 * What `pithy feature destroy` looks for (#592): the name a feature Worker deploys under now, and the one
 * it deployed under before #587. Literals, so a shape cannot pass by being composed wrongly twice.
 */
describe("featureWorkerScriptNames", () => {
  const identity = { project: "replay", issue: "69", slug: "demo" };

  it("names the single-project shape first, then the doubled one a feature deployed before #587 still runs", () => {
    expect(featureWorkerScriptNames(identity, { app: "board", script: "replay-board" })).toEqual([
      "replay-f69-demo-board",
      "replay-f69-demo-replay-board",
    ]);
  });

  it("names one script when the deploy name is the directory, so nothing is looked for twice", () => {
    expect(featureWorkerScriptNames(identity, { app: "board", script: "board" })).toEqual(["replay-f69-demo-board"]);
  });

  it("leads with exactly the name the feature scope deploys under", () => {
    const worker: ProvisionWorkerNames = { app: "collaboration-realtime-gateway", script: "replay-collab" };
    expect(featureWorkerScriptNames(identity, worker)[0]).toBe(featureScope(identity).worker(worker));
  });
});

describe("bindingResourceName", () => {
  /**
   * The overload's whole point: a capability's own namer — `suppressionDatabaseName`,
   * `supportBucketName` — has no environment, because its resource has none. It states the declaration
   * and gets the project's one name, through the same expression `pithy add` and `pithy provision`
   * compose with. Two expressions for that name is #513.
   */
  it("composes a project-global name from the declaration alone, with no scoped composer to supply", () => {
    expect(bindingResourceName("acme", "EMAIL_SUPPRESSIONS", "d1", { scope: GLOBAL_SCOPE })).toBe(
      "acme-global-email-suppressions",
    );
    expect(bindingResourceName("acme", "SUPPORT_BUCKET", "r2", { scope: GLOBAL_SCOPE, resource: "support" })).toBe(
      "acme-global-support",
    );
  });

  it("takes the scoped composer for everything else, and hands it the resolved thing", () => {
    const seen: string[] = [];
    const name = bindingResourceName("acme", "MEDIA_BUCKET", "r2", { resource: "media" }, (thing) => {
      seen.push(thing);
      return `acme-staging-${thing}`;
    });
    expect(seen).toEqual(["media"]);
    expect(name).toBe("acme-staging-media");
  });

  /**
   * The second wall behind the overloads, reached the only way a caller can reach it — by defeating the
   * types. A name with a scope segment nobody chose is worse than a refusal, because it is written into a
   * `wrangler.jsonc` and provisioned against.
   */
  it("refuses a scoped name when the caller has no scope to compose it in", () => {
    const untyped = bindingResourceName as (
      project: string,
      binding: string,
      kind: "d1",
      naming: BindingNaming,
    ) => string;
    expect(() => untyped("acme", "DB", "d1", {})).toThrowError(PithyError);
    try {
      untyped("acme", "DB", "d1", {});
    } catch (error) {
      expect((error as PithyError).payload.code).toBe("core/internal");
      expect((error as PithyError).payload.detail).toContain("DB");
    }
  });
});
