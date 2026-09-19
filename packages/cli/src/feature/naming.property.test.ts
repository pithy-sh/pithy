// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import {
  FEATURE_RESOURCE_KINDS,
  type FeatureIdentity,
  featureSecretEntryName,
  featureWorkflowName,
  isFeatureOwnedName,
} from "@pithy-sh/core/src/naming/feature";
import { MAX_ISSUE_DIGITS } from "@pithy-sh/core/src/naming/limits";
import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { workflowHostName, workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { secretsRotateWorkflowName, secretsWriteWorkflowName } from "@pithy-sh/secrets/src/manager/dispatcher";
import {
  managerCfApiTokenName,
  managerCfApiTokenSecretName,
  masterKeySecretName,
} from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { vectorIndexName } from "@pithy-sh/vector/src/provision/provisionVector";
import { describe, expect, test } from "vitest";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { ratelimitClaimName } from "./ratelimits";

/**
 * **Feature names are injective across projects (#643, finding 1 of the review of 8858558c).**
 *
 * The maintainer's invariant — nothing is shared between a feature and any other feature, staging or prod, in
 * this project or another in the same account — is a statement about names, because every Cloudflare namespace a
 * feature writes into is flat and account-wide. So it is tested as a property of the namers, not as a spot check:
 * universes of projects, environments and feature branches are generated — projects that are prefixes of each
 * other, projects that end in an environment's name, branches whose slugs are prefixes of each other or end in
 * another binding's name, leading-zero issues, the longest legal project, slugs long enough to truncate — and
 * every name every namer composes for each of them is collected. **No name may belong to two owners when either
 * of them is a feature.**
 *
 * The same pass proves the ownership check the isolation gates use (`isFeatureOwnedName`) is exact: each
 * feature name is its own feature's and no other's, and no environment name is any feature's.
 *
 * Environment-against-environment across projects is not asserted: `acme`'s `staging` and `acme-staging`'s
 * environments share one flat `<project>-<env>-<thing>` shape that predates features, and nothing here changed it.
 */

/** A small deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

const LONGEST_PROJECT = `p${"q".repeat(MAX_PROJECT_NAME - 1)}`;

/** Projects chosen to be prefixes of each other and to end where an environment or a feature could begin. */
const PROJECT_POOL = [
  "acme",
  "acme-x",
  "acme-staging",
  "acme-prod",
  "acme-global",
  "acme-f12",
  "acme-f12-x",
  "acme-f0643-feature",
  "a",
  "a-b",
  "f",
  "x1",
  "acme-12-x",
  LONGEST_PROJECT,
  `${LONGEST_PROJECT.slice(0, MAX_PROJECT_NAME - 2)}-z`,
];

const ENV_POOL = ["staging", "prod", "qa", "x", "x-1", "x-prod", "stage-2"];

/** Issues, including a leading zero, which is the same feature as without it. */
const ISSUE_POOL = ["1", "12", "643", "0643", "00012", "9".repeat(MAX_ISSUE_DIGITS)];

/** Slugs that are prefixes of each other, end in another name's segments, carry a marker, or truncate. */
const SLUG_POOL = [
  "x",
  "x-prod",
  "x-global",
  "x-prod-db",
  "feature-address",
  "feature-address-2",
  "f3-y",
  "x-f3-y",
  "billing-refunds-alpha-and-a-great-deal-more-text-than-fits",
  "billing-refunds-beta-and-a-great-deal-more-text-than-fits",
  `${"s".repeat(70)}-one`,
  `${"s".repeat(70)}-two`,
];

const BINDINGS = ["DB", "PROD_DB", "X_PROD_DB", "SECRETS", "MEDIA_BUCKET", "USER_NOTIFICATION_PREFERENCES_STORE"];
const APPS = ["api", "email", "web", "prod-api", "f3-y", "db", "x-prod"];
const SECRETS = ["SECRETS_ENCRYPTION_KEYS", "AUTH_SESSION_SECRET", "PROD_TOKEN", "X_PROD_DB"];
const JOBS = ["send", "write", "rotate", "reconcile"];
const INDEXES = ["notes", "prod-notes"];
const LIMITERS = ["1001", "2001", "AUTH_RATE_LIMITER"];

/** The canonical issue, computed here rather than borrowed from the namer under test. */
const canonical = (issue: string): string => issue.replace(/^0+(?=\d)/, "");

type Owner = { kind: "env"; project: string; env: string } | { kind: "feature"; identity: FeatureIdentity };

function ownerKey(owner: Owner): string {
  return owner.kind === "env"
    ? `${owner.project}|env|${owner.env}`
    : `${owner.identity.project}|feature|${canonical(owner.identity.issue)}|${owner.identity.slug}`;
}

/** Every account-wide name a declared environment (or the project's `global` scope) composes. */
function environmentNames(project: string, env: string): string[] {
  const names: string[] = [];
  const add = (compose: () => string): void => {
    try {
      names.push(compose());
    } catch (error) {
      // A composer refusing a combination is not a name; anything but a refusal is a bug.
      if (!(error instanceof PithyError)) throw error;
    }
  };
  if (env === "global") {
    const global = resourceNames(project).global;
    for (const binding of BINDINGS) for (const kind of FEATURE_RESOURCE_KINDS) add(() => global[kind](binding));
    for (const secret of SECRETS) add(() => global.secretEntry(secret));
    add(() => managerCfApiTokenName(project));
    add(() => managerCfApiTokenSecretName(project));
    return names;
  }
  const scope = environmentScope(project, env);
  const facade = resourceNames(project).env(env);
  for (const binding of BINDINGS) {
    for (const kind of FEATURE_RESOURCE_KINDS) add(() => scope.resource(binding, kind, {}));
  }
  for (const secret of SECRETS) add(() => scope.secretEntry(secret, "environment"));
  for (const app of APPS) add(() => scope.worker({ app, script: `${project}-${app}` }, `${project}-${env}-${app}`));
  for (const spec of HOST_WORKERS) {
    add(() => workflowHostName({ project, capability: spec.capability, env }));
    for (const job of JOBS) add(() => workflowScriptName({ project, capability: spec.capability, job, env }));
  }
  for (const index of INDEXES) {
    add(() => vectorIndexName(project, index, env));
    add(() => facade.vectorizeIndex(index));
  }
  if (env === "staging" || env === "prod") {
    add(() => masterKeySecretName(project, env));
    add(() => managerWorkerName(project, env));
    add(() => secretsWriteWorkflowName(project, env));
    add(() => secretsRotateWorkflowName(project, env));
  }
  return names;
}

/** Every account-wide name one feature composes: the same namers, handed the feature. */
function featureNames(identity: FeatureIdentity): string[] {
  const { project } = identity;
  const scope = featureScope(identity);
  const names: string[] = [];
  for (const binding of BINDINGS) {
    for (const kind of FEATURE_RESOURCE_KINDS) names.push(scope.resource(binding, kind, {}));
  }
  for (const secret of SECRETS) {
    names.push(scope.secretEntry(secret, "environment"), scope.secretEntry(secret, "global"));
    names.push(featureSecretEntryName(identity, secret));
  }
  for (const app of APPS) names.push(scope.worker({ app, script: `${project}-${app}` }));
  for (const spec of HOST_WORKERS) {
    names.push(workflowHostName({ ...scope.workflowHost, capability: spec.capability }));
    for (const job of JOBS) {
      names.push(workflowScriptName({ ...scope.workflowHost, capability: spec.capability, job }));
      names.push(featureWorkflowName(identity, spec.capability, job));
    }
  }
  for (const index of INDEXES) names.push(vectorIndexName(project, index, "feature", identity));
  names.push(masterKeySecretName(project, "feature", identity));
  names.push(managerWorkerName(project, "feature", identity));
  names.push(secretsWriteWorkflowName(project, "feature", identity));
  for (const limiter of LIMITERS) names.push(ratelimitClaimName(identity, limiter, "1234567890"));
  return names;
}

/** Can this project have features at all? One whose name carries an `f<digits>` segment cannot (#643). */
function featuresRefused(project: string): boolean {
  try {
    featureScope({ project, issue: "1", slug: "x" }).resource("DB", "d1", {});
    return false;
  } catch (error) {
    if (error instanceof PithyError) return true;
    throw error;
  }
}

/** One universe: a few projects, each with environments and features, all in one account. */
function universe(random: () => number): { owners: Owner[] } {
  const projects = new Set<string>();
  const count = 2 + Math.floor(random() * 3);
  while (projects.size < count) projects.add(pick(random, PROJECT_POOL));
  const owners: Owner[] = [];
  for (const project of projects) {
    owners.push({ kind: "env", project, env: "global" });
    for (const env of ENV_POOL) if (random() < 0.6) owners.push({ kind: "env", project, env });
    if (featuresRefused(project)) continue;
    for (let i = 0; i < 4; i += 1) {
      owners.push({
        kind: "feature",
        identity: { project, issue: pick(random, ISSUE_POOL), slug: pick(random, SLUG_POOL) },
      });
    }
  }
  return { owners };
}

/** Name → the owners that compose it. */
function namesOf(owners: readonly Owner[]): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const owner of owners) {
    const names = owner.kind === "env" ? environmentNames(owner.project, owner.env) : featureNames(owner.identity);
    for (const name of names) {
      const set = byName.get(name) ?? new Set<string>();
      set.add(ownerKey(owner));
      byName.set(name, set);
    }
  }
  return byName;
}

/** Every name two owners share, when either of them is a feature. */
function featureCollisions(byName: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const found: string[] = [];
  for (const [name, owners] of byName) {
    if (owners.size < 2) continue;
    if ([...owners].some((key) => key.includes("|feature|"))) found.push(`${name} <- ${[...owners].join(" & ")}`);
  }
  return found;
}

const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1);

describe("feature names across projects", () => {
  test("the reviewer's case: acme's feature/12-x-prod and project acme-f12-x's prod share no name", () => {
    const owners: Owner[] = [
      { kind: "env", project: "acme-f12-x", env: "prod" },
      { kind: "env", project: "acme-f12-x", env: "global" },
      { kind: "feature", identity: { project: "acme", issue: "12", slug: "x-prod" } },
      { kind: "feature", identity: { project: "acme", issue: "12", slug: "x-global" } },
    ];
    expect(featureCollisions(namesOf(owners))).toEqual([]);
  });

  test("a project whose name carries an f<digits> segment is refused features, and says so", () => {
    for (const project of ["acme-f12-x", "acme-f12", "f1", "a-f0-b"]) {
      expect(featuresRefused(project), project).toBe(true);
    }
    for (const project of ["acme", "f", "acme-f", "acme-fx12", "acme-12-x"]) {
      expect(featuresRefused(project), project).toBe(false);
    }
  });

  test.each(SEEDS)("seed %i: no name is two owners' when either is a feature", (seed) => {
    const { owners } = universe(rng(seed));
    expect(featureCollisions(namesOf(owners))).toEqual([]);
  });

  test.each(SEEDS)("seed %i: every feature name is its own feature's and nobody else's", (seed) => {
    const { owners } = universe(rng(seed));
    const features = owners.flatMap((owner) => (owner.kind === "feature" ? [owner.identity] : []));
    const envs = owners.flatMap((owner) => (owner.kind === "env" ? [owner] : []));
    for (const identity of features) {
      for (const name of featureNames(identity)) {
        for (const other of features) {
          const same = ownerKey({ kind: "feature", identity: other }) === ownerKey({ kind: "feature", identity });
          expect({ name, other, owned: isFeatureOwnedName(other, name) }).toEqual({ name, other, owned: same });
        }
      }
    }
    for (const env of envs) {
      for (const name of environmentNames(env.project, env.env)) {
        for (const identity of features)
          expect({ name, owned: isFeatureOwnedName(identity, name) }).toEqual({ name, owned: false });
      }
    }
  });

  test("a leading zero names the same feature, not a second one", () => {
    const a = featureNames({ project: "acme", issue: "643", slug: "foo" });
    const b = featureNames({ project: "acme", issue: "0643", slug: "foo" });
    expect(b).toEqual(a);
  });
});
