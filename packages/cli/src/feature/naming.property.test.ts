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
import { MAX_ISSUE_DIGITS, NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
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

/**
 * **Feature names are injective across projects, and exact (#643).**
 *
 * The maintainer's invariant — nothing is shared between a feature and any other feature, staging or prod, in
 * this project or another in the same account — is a statement about names, because every Cloudflare namespace a
 * feature writes into is flat and account-wide. So it is tested as a property of the namers, not as a spot check.
 *
 * **Everything is generated, nothing drawn from a list** (the review of 4828e1fc: twelve fixed slugs could reach
 * neither of its findings). Projects run from one character to the longest legal, as prefixes of each other and
 * ending where an environment or a feature marker could begin. Issues run to {@link MAX_ISSUE_DIGITS} digits, with
 * leading zeros, and several features of one project share each one. Slugs are one to three characters, hex that
 * is the hash prefix of a sibling's slug (what a truncated name used to carry), long ones at, one past and far past
 * the project's budget, and slugs sharing a prefix or a first letter. **No name may belong to two owners when
 * either of them is a feature**, ownership (`isFeatureOwnedName`) must be exact, and a slug must be refused
 * exactly when it is longer than its project's budget.
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

type Random = () => number;

const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (random: Random, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = `${LETTERS}0123456789`;
const HEX = "0123456789abcdef";

/** A run of characters from `alphabet`. */
const chars = (random: Random, alphabet: string, length: number): string =>
  Array.from({ length }, () => pick(random, alphabet.split(""))).join("");

/**
 * A kebab name of exactly `length` characters, starting with a letter and never with a doubled or trailing hyphen,
 * from `alphabet` — the shape a project name, a branch slug and an environment all take.
 */
function kebabOf(random: Random, length: number, alphabet = ALNUM): string {
  let out = pick(random, LETTERS.split(""));
  while (out.length < length) {
    const room = length - out.length;
    const hyphen = room >= 2 && !out.endsWith("-") && random() < 0.2;
    out += hyphen ? "-" : pick(random, alphabet.split(""));
  }
  return out;
}

/** The FNV-1a digest a truncated feature name used to carry — computed here, not borrowed from the namer. */
function fnv6(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** Environment names: generated, and a few that end where a feature's slug could. */
function environments(random: Random): string[] {
  const envs = new Set(["staging", "prod"]);
  const count = between(random, 1, 4);
  for (let i = 0; i < count; i += 1) {
    const env = kebabOf(random, between(random, 1, 7), LETTERS);
    if (!/^f[0-9]/.test(env)) envs.add(env);
  }
  return [...envs];
}

/** Projects: generated at every legal length, some prefixes of each other, some carrying an f<digits> segment. */
function projects(random: Random): string[] {
  const out = new Set<string>();
  const count = between(random, 2, 3);
  while (out.size < count) {
    const roll = random();
    const previous = [...out];
    let project: string;
    if (roll < 0.35) project = kebabOf(random, MAX_PROJECT_NAME);
    else if (roll < 0.45 && previous.length > 0) {
      // A prefix of another, or another with a segment on the end: the pair a prefix match confuses.
      const base = pick(random, previous);
      project =
        random() < 0.5
          ? `${base}-${kebabOf(random, between(random, 1, 4))}`
          : base.slice(0, between(random, 1, base.length));
    } else if (roll < 0.55) project = `${kebabOf(random, between(random, 1, 6), LETTERS)}-f${between(random, 0, 99)}`;
    else project = kebabOf(random, between(random, 1, MAX_PROJECT_NAME));
    project = project.replace(/-+$/, "").slice(0, MAX_PROJECT_NAME).replace(/-+$/, "");
    if (/^[a-z]/.test(project)) out.add(project);
  }
  return [...out];
}

/** An issue of one to six digits, sometimes zero-padded: `0643` is `643`. */
function issueOf(random: Random): string {
  const width = random() < 0.4 ? MAX_ISSUE_DIGITS : between(random, 1, MAX_ISSUE_DIGITS);
  const digits = String(between(random, 10 ** (width - 1), 10 ** width - 1));
  const padded = random() < 0.2 ? `0${digits}` : digits;
  return padded.length > MAX_ISSUE_DIGITS ? digits : padded;
}

/**
 * Slugs for one project and issue: short, hash-looking, at and beyond the budget, and sharing prefixes and first
 * letters with each other. `budget` is the longest that fits, computed by this test's own arithmetic.
 */
function slugsFor(random: Random, budget: number, count: number): string[] {
  const out: string[] = [];
  const lengths = [budget - 1, budget, budget + 1, budget + 2, budget + 20].filter((length) => length >= 1);
  for (let i = 0; i < count; i += 1) {
    const roll = random();
    let slug: string;
    if (roll < 0.2) slug = kebabOf(random, between(random, 1, 3));
    else if (roll < 0.35) slug = `${pick(random, LETTERS.split(""))}${chars(random, HEX, between(random, 0, 2))}`;
    else if (roll < 0.5 && out.length > 0) {
      // The hash prefix a truncated sibling name carried, as a whole slug of its own.
      const hash = fnv6(pick(random, out));
      const hex = hash.slice(0, between(random, 1, 3));
      slug = /^[a-z]/.test(hex) ? hex : `${pick(random, LETTERS.split(""))}${hex}`.slice(0, 3);
    } else if (roll < 0.75) slug = kebabOf(random, pick(random, lengths));
    else if (out.length > 0) {
      // A shared prefix, or the same first letters: what a truncated head kept.
      const base = pick(random, out);
      const keep = between(random, 1, Math.min(base.length, 4));
      slug = `${base.slice(0, keep)}${kebabOf(random, Math.max(1, pick(random, lengths) - keep)).slice(0)}`;
    } else slug = kebabOf(random, between(random, 4, 12));
    slug = slug.replace(/--+/g, "-").replace(/-+$/, "");
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) out.push(slug);
  }
  return out;
}

/** Many slugs of one first letter, most at or past the budget: what a truncated `<letter>-<hash>` had to tell apart. */
function crowdedSlugs(random: Random, budget: number, count: number): string[] {
  const letter = pick(random, LETTERS.split(""));
  return Array.from({ length: count }, () => {
    const length = Math.max(2, budget + between(random, -1, 12));
    return `${letter}${kebabOf(random, length - 1, LETTERS)}`.replace(/--+/g, "-").replace(/-+$/, "");
  });
}

const BINDINGS = ["DB", "PROD_DB", "X_PROD_DB", "SECRETS", "MEDIA_BUCKET", "EMAIL_SUPPRESSIONS"];
const APPS = ["api", "email", "web", "prod-api", "f3-y", "db", "x-prod"];
const SECRETS = ["SECRETS_ENCRYPTION_KEYS", "AUTH_SESSION_SECRET", "PROD_TOKEN", "X_PROD_DB"];
const JOBS = ["send", "write", "rotate", "reconcile"];
const INDEXES = ["notes", "prod-notes"];

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

/** One name a feature composes, with the cap of the namespace it is composed into. */
interface Named {
  name: string;
  limit: number;
}

/** Every account-wide name one feature composes, with its namespace's cap: the same namers, handed the feature. */
function featureNamed(identity: FeatureIdentity): Named[] {
  const { project } = identity;
  const scope = featureScope(identity);
  const out: Named[] = [];
  const add = (limit: number, name: string): void => void out.push({ name, limit });
  const { r2, secretEntry, worker, workflow, vectorizeIndex } = NAMESPACE_LIMITS;
  for (const binding of BINDINGS) {
    for (const kind of FEATURE_RESOURCE_KINDS) add(r2.maxLength, scope.resource(binding, kind, {}));
  }
  for (const secret of SECRETS) {
    add(secretEntry.maxLength, scope.secretEntry(secret, "environment"));
    add(secretEntry.maxLength, scope.secretEntry(secret, "global"));
    add(secretEntry.maxLength, featureSecretEntryName(identity, secret));
  }
  for (const app of APPS) add(worker.maxLength, scope.worker({ app, script: `${project}-${app}` }));
  for (const spec of HOST_WORKERS) {
    add(worker.maxLength, workflowHostName({ ...scope.workflowHost, capability: spec.capability }));
    for (const job of JOBS) {
      add(workflow.maxLength, workflowScriptName({ ...scope.workflowHost, capability: spec.capability, job }));
      add(workflow.maxLength, featureWorkflowName(identity, spec.capability, job));
    }
  }
  // The longest <capability>-<job> the kit declares, which is what sets most budgets.
  add(workflow.maxLength, workflowScriptName({ ...scope.workflowHost, capability: "media", job: "audio-transcribe" }));
  for (const index of INDEXES) add(vectorizeIndex.maxLength, vectorIndexName(project, index, "feature", identity));
  add(secretEntry.maxLength, masterKeySecretName(project, "feature", identity));
  add(worker.maxLength, managerWorkerName(project, "feature", identity));
  add(workflow.maxLength, secretsWriteWorkflowName(project, "feature", identity));
  return out;
}

/** One name of each family a feature composes: a resource, an entry, a Worker, a Workflow and an index. */
function sampleNames(identity: FeatureIdentity): string[] {
  const scope = featureScope(identity);
  return [
    scope.resource("DB", "d1", {}),
    scope.secretEntry("PROD_TOKEN", "environment"),
    scope.worker({ app: "api", script: `${identity.project}-api` }),
    workflowScriptName({ ...scope.workflowHost, capability: "email", job: "send" }),
    vectorIndexName(identity.project, "notes", "feature", identity),
  ];
}

/** Every account-wide name one feature composes. */
function featureNames(identity: FeatureIdentity): string[] {
  return featureNamed(identity).map((named) => named.name);
}

/**
 * **The longest slug this project and issue can carry, by this test's own arithmetic** — never the namer's.
 * Every name is composed with a one-character slug; each namespace's cap less that name, plus the one character,
 * is the room that name leaves, and the budget is the least of them. `null` when the project can have no features.
 */
function budgetOf(project: string, issue: string): number | null {
  const key = `${project}|${issue}`;
  if (budgets.has(key)) return budgets.get(key) as number | null;
  const budget = featuresRefused(project)
    ? null
    : Math.min(...featureNamed({ project, issue, slug: "a" }).map(({ name, limit }) => limit - (name.length - 1)));
  budgets.set(key, budget);
  return budget;
}

const budgets = new Map<string, number | null>();

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

/** The names a feature composes, or `null` when a namer refuses it. Anything but a refusal is a bug. */
function composed(identity: FeatureIdentity): string[] | null {
  try {
    return featureNames(identity);
  } catch (error) {
    if (error instanceof PithyError) return null;
    throw error;
  }
}

/** One universe per seed, generated once: three properties read it. */
const universes = new Map<number, ReturnType<typeof generate>>();
function universe(seed: number): ReturnType<typeof generate> {
  const found = universes.get(seed) ?? generate(rng(seed));
  universes.set(seed, found);
  return found;
}

/** One universe: a few projects, each with environments and features, all in one account. */
function generate(random: Random): { owners: Owner[]; refused: { identity: FeatureIdentity; budget: number }[] } {
  const owners: Owner[] = [];
  const refused: { identity: FeatureIdentity; budget: number }[] = [];
  for (const project of projects(random)) {
    owners.push({ kind: "env", project, env: "global" });
    for (const env of environments(random)) owners.push({ kind: "env", project, env });
    // Two issues per project, each shared by many branches: siblings are where truncation collided. Half the
    // universes crowd one of them, the way a busy issue on a long project name does: hundreds of branches, one
    // first letter, most of them at or past the budget.
    const crowded = random() < 0.5;
    for (const [index, issue] of [issueOf(random), issueOf(random)].entries()) {
      const budget = budgetOf(project, issue);
      if (budget === null) continue;
      const slugs = crowded && index === 0 ? crowdedSlugs(random, budget, 160) : slugsFor(random, budget, 36);
      for (const slug of slugs) {
        const identity = { project, issue, slug };
        if (composed(identity) === null) refused.push({ identity, budget });
        else owners.push({ kind: "feature", identity });
      }
    }
  }
  return { owners, refused };
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

/** Every (name, feature) pair where ownership says other than the truth. */
function ownershipErrors(owners: readonly Owner[]): string[] {
  const errors: string[] = [];
  const features = owners.flatMap((owner) => (owner.kind === "feature" ? [owner.identity] : []));
  const envs = owners.flatMap((owner) => (owner.kind === "env" ? [owner] : []));
  for (const identity of features) {
    const key = ownerKey({ kind: "feature", identity });
    // One name per namer family is enough here: ownership reads the head and the slug, which every name of one
    // feature shares. The collision property above takes every name.
    for (const name of sampleNames(identity)) {
      for (const other of features) {
        const same = ownerKey({ kind: "feature", identity: other }) === key;
        if (isFeatureOwnedName(other, name) !== same) {
          errors.push(
            `${name}: ${JSON.stringify(other)} ${same ? "does not own" : "owns"} it (from ${JSON.stringify(identity)})`,
          );
        }
      }
    }
  }
  for (const env of envs) {
    for (const name of environmentNames(env.project, env.env)) {
      for (const identity of features) {
        if (isFeatureOwnedName(identity, name))
          errors.push(`${name}: ${identity.slug} owns ${env.project} ${env.env}'s`);
      }
    }
  }
  return errors;
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
    const { owners } = universe(seed);
    expect(featureCollisions(namesOf(owners))).toEqual([]);
  });

  test.each(SEEDS)("seed %i: every feature name is its own feature's and nobody else's", (seed) => {
    const { owners } = universe(seed);
    expect(ownershipErrors(owners)).toEqual([]);
  });

  test.each(SEEDS)("seed %i: a slug is refused exactly when it is past its project's budget", (seed) => {
    const { owners, refused } = universe(seed);
    const wrong: string[] = [];
    for (const { identity, budget } of refused) {
      if (identity.slug.length <= budget)
        wrong.push(`${identity.project} #${identity.issue} ${identity.slug} refused at ${budget}`);
    }
    for (const owner of owners) {
      if (owner.kind !== "feature") continue;
      const { project, issue, slug } = owner.identity;
      const budget = budgetOf(project, issue) as number;
      if (slug.length > budget) wrong.push(`${project} #${issue} ${slug} accepted past ${budget}`);
      // Accepted means whole: every name carries the slug itself, never a fitted form of it.
      for (const name of featureNames(owner.identity)) {
        if (!name.includes(`-${slug}--`)) wrong.push(`${name} does not carry ${slug}`);
      }
    }
    expect(wrong).toEqual([]);
    // The generator reaches both sides of the boundary, or it proves nothing about it.
    expect(refused.length + owners.length).toBeGreaterThan(0);
  });

  test("the generator reaches both sides of every budget across the seeds", () => {
    let refused = 0;
    let atBudget = 0;
    for (const seed of SEEDS) {
      const universeOf = universe(seed);
      refused += universeOf.refused.length;
      for (const owner of universeOf.owners) {
        if (
          owner.kind === "feature" &&
          owner.identity.slug.length === budgetOf(owner.identity.project, owner.identity.issue)
        ) {
          atBudget += 1;
        }
      }
    }
    expect(refused).toBeGreaterThan(50);
    expect(atBudget).toBeGreaterThan(10);
  });

  test("a leading zero names the same feature, not a second one", () => {
    const a = featureNames({ project: "acme", issue: "643", slug: "foo" });
    const b = featureNames({ project: "acme", issue: "0643", slug: "foo" });
    expect(b).toEqual(a);
  });
});
