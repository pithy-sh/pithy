// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError } from "../error/pithyError";
import {
  assertFeatureProject,
  canonicalIssue,
  type FeatureIdentity,
  type FeatureResourceKind,
  featureMarkerInProjectName,
  featureResourceName,
  featureSecretEntryName,
  featureWorkerName,
  isFeatureOwnedName,
  parseFeatureName,
} from "./feature";
import { MAX_ISSUE_DIGITS, NAMESPACE_LIMITS } from "./limits";
import { MAX_PROJECT_NAME } from "./resource";

const KINDS: FeatureResourceKind[] = ["d1", "kv", "r2"];

/** R2's charset, the strictest of the three kinds: lowercase, digits, inner hyphens, alphanumeric at both ends. */
const R2_BUCKET = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A Worker script name: alphanumeric and dashes, never leading or trailing.
 *
 * Character-for-character {@link R2_BUCKET} today, and kept as a second const on purpose: these are two
 * namespaces' published charsets that happen to agree, not one rule written twice. If Cloudflare loosens
 * one, only that one moves.
 */
const WORKER_SCRIPT = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const base: FeatureIdentity = { project: "acme", issue: "69", slug: "media-cli" };

describe("featureResourceName", () => {
  it("composes <project>-f<issue>-<slug>-<binding>-<kind>", () => {
    expect(featureResourceName(base, "ASSETS", "r2")).toBe("acme-f69-media-cli--assets-r2");
    expect(featureResourceName(base, "MY_DB", "d1")).toBe("acme-f69-media-cli--my-db-d1");
  });

  it("stays inside R2's bucket rules for every kind, because one shape serves all three", () => {
    const identity = {
      project: "a".repeat(MAX_PROJECT_NAME),
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "s".repeat(80),
    };
    for (const kind of KINDS) {
      const name = featureResourceName(identity, "USER_NOTIFICATION_PREFERENCES_STORE", kind);
      expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.r2.maxLength);
      expect(name.length).toBeGreaterThanOrEqual(NAMESPACE_LIMITS.r2.minLength);
      expect(name).toMatch(R2_BUCKET);
    }
  });

  it("keeps the slug and a working binding verbatim at the worst legal project name", () => {
    // This is the guarantee `FEATURE_DERIVED_PROJECT_NAME` was derived to give: at the cap, with a
    // six-digit issue, an eleven-character slug and a twelve-character binding still read — eleven since the
    // double hyphen after the slug took one of its characters (#643).
    const identity = {
      project: "a".repeat(MAX_PROJECT_NAME),
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "media-queue",
    };
    const name = featureResourceName(identity, "MEDIA_BUCKET", "r2");
    expect(name).toContain("-media-queue--media-bucket-r2");
    expect(name.length).toBe(NAMESPACE_LIMITS.r2.maxLength);
  });

  it("is deterministic, and gives each binding and kind its own name", () => {
    // Provision and teardown compute the name rather than storing it, so the same inputs must give
    // the same string — and a `DB` bucket must never be the `DB` database's name.
    expect(featureResourceName(base, "DB", "d1")).toBe(featureResourceName(base, "DB", "d1"));
    const names = new Set([
      featureResourceName(base, "DB", "d1"),
      featureResourceName(base, "DB", "kv"),
      featureResourceName(base, "CACHE", "kv"),
      featureResourceName(base, "ASSETS", "r2"),
    ]);
    expect(names.size).toBe(4);
  });

  it("keeps the kind suffix whole even when everything else is truncated", () => {
    // The suffix is the only thing telling a `DB` bucket from a `DB` database, so it is never the
    // segment that gives way.
    const identity = { project: "acme", issue: "123", slug: "z".repeat(50) };
    for (const kind of KINDS) {
      expect(featureResourceName(identity, "SOME_VERY_LONG_BINDING_NAME_INDEED", kind).endsWith(`-${kind}`)).toBe(true);
    }
  });

  it("keeps two different long slugs distinct", () => {
    const a = featureResourceName({ project: "acme", issue: "1", slug: `${"x".repeat(60)}-one` }, "DB", "d1");
    const b = featureResourceName({ project: "acme", issue: "1", slug: `${"x".repeat(60)}-two` }, "DB", "d1");
    expect(a).not.toBe(b);
  });

  it("refuses an empty slug or binding rather than composing a doubled hyphen", () => {
    // `acme-f69--db-d1` is not a legal bucket name, and it is what an empty segment silently produced.
    expect(() => featureResourceName({ ...base, slug: "" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName({ ...base, slug: "!!!" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName(base, "", "d1")).toThrow(PithyError);
  });

  it("refuses an issue that is not a number, or is past a million", () => {
    expect(() => featureResourceName({ ...base, issue: "abc" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName({ ...base, issue: "" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName({ ...base, issue: "9".repeat(MAX_ISSUE_DIGITS) }, "DB", "d1")).not.toThrow();
    expect(() => featureResourceName({ ...base, issue: "9".repeat(MAX_ISSUE_DIGITS + 1) }, "DB", "d1")).toThrow(
      PithyError,
    );
  });
});

describe("featureWorkerName", () => {
  it("composes <project>-f<issue>-<slug>-<worker>", () => {
    expect(featureWorkerName(base, "api")).toBe("acme-f69-media-cli--api");
  });

  it("never runs past the Worker cap — the bug this had", () => {
    // Measured before the fix: 69 characters for `collaboration-realtime-gateway`, 109 for a 70-character
    // worker name. `apps/<name>` has a charset rule and no length rule, so nothing upstream stopped it.
    for (const worker of ["collaboration-realtime-gateway", "w".repeat(70)]) {
      const name = featureWorkerName({ project: "acme", issue: "1", slug: "media-cli" }, worker);
      expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
      expect(name).toMatch(WORKER_SCRIPT);
    }
  });

  it("holds the cap at the worst legal input", () => {
    const identity = {
      project: "a".repeat(MAX_PROJECT_NAME),
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "s".repeat(80),
    };
    const name = featureWorkerName(identity, "w".repeat(80));
    expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
    expect(name).toMatch(WORKER_SCRIPT);
  });

  it("lands exactly on the cap without truncating, one character below it", () => {
    // `acme-f1-` is 8 characters; a 55-character tail fills the 63 exactly.
    const identity = { project: "acme", issue: "1", slug: "s".repeat(20) };
    const worker = "w".repeat(NAMESPACE_LIMITS.worker.maxLength - 8 - 20 - 2);
    const name = featureWorkerName(identity, worker);
    expect(name.length).toBe(NAMESPACE_LIMITS.worker.maxLength);
    expect(name).toBe(`acme-f1-${"s".repeat(20)}--${worker}`);
  });

  it("keeps two long worker names distinct rather than colliding on a truncation", () => {
    const identity = { project: "acme", issue: "1", slug: "media-cli" };
    const a = featureWorkerName(identity, `${"w".repeat(60)}-alpha`);
    const b = featureWorkerName(identity, `${"w".repeat(60)}-omega`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
  });

  it("refuses an empty worker rather than composing a trailing hyphen", () => {
    // A Worker script name may not end in a dash, so this was an invalid name, not just an ugly one.
    expect(() => featureWorkerName(base, "")).toThrow(PithyError);
    expect(() => featureWorkerName(base, "!!!")).toThrow(PithyError);
  });

  it("is deterministic, so provision and teardown compute the same name", () => {
    expect(featureWorkerName(base, "api")).toBe(featureWorkerName(base, "api"));
    expect(featureWorkerName(base, "api")).not.toBe(featureWorkerName(base, "web"));
  });
});

/**
 * **A feature name parses back to exactly one owner (#643).** The double hyphen ends the slug, and the first
 * `f<digits>` segment is the issue because a project may carry none. That is what the isolation gates ask, and
 * what makes names injective across projects — `feature/naming.property.test.ts` in the CLI holds the property.
 */
describe("parseFeatureName and isFeatureOwnedName", () => {
  const me: FeatureIdentity = { project: "acme", issue: "643", slug: "feature-address" };

  it("reads a feature name back into its project, issue, slug and thing", () => {
    expect(parseFeatureName(featureResourceName(me, "DB", "d1"))).toEqual({
      project: "acme",
      issue: "643",
      slug: "feature-address",
      thing: "db-d1",
    });
    expect(parseFeatureName(featureWorkerName({ project: "a-b", issue: "1", slug: "f3-y" }, "api"))).toEqual({
      project: "a-b",
      issue: "1",
      slug: "f3-y",
      thing: "api",
    });
  });

  it("reads nothing a declared environment composes as a feature's", () => {
    for (const name of ["acme-prod-db", "acme-f12-x-prod-email", "acme-staging-secrets", "acme--f1"]) {
      expect(parseFeatureName(name), name).toBeNull();
    }
  });

  it("owns its own names, including truncated ones, and no sibling's", () => {
    const long: FeatureIdentity = { ...me, slug: "s".repeat(80) };
    expect(isFeatureOwnedName(me, featureWorkerName(me, "email"))).toBe(true);
    expect(isFeatureOwnedName(long, featureSecretEntryName(long, "SECRETS_ENCRYPTION_KEYS"))).toBe(true);
    expect(isFeatureOwnedName(long, featureResourceName(long, "USER_NOTIFICATION_PREFERENCES_STORE", "r2"))).toBe(true);
    for (const other of [
      { ...me, slug: "feature-address-2" },
      { ...me, slug: "feature" },
      { ...me, issue: "6430" },
      { ...me, project: "acme-x" },
    ]) {
      expect(isFeatureOwnedName(me, featureWorkerName(other, "email")), JSON.stringify(other)).toBe(false);
      expect(isFeatureOwnedName(other, featureWorkerName(me, "email")), JSON.stringify(other)).toBe(false);
    }
  });

  it("reads a leading zero as the same issue", () => {
    expect(canonicalIssue("0643")).toBe("643");
    expect(canonicalIssue("0")).toBe("0");
    expect(featureWorkerName({ ...me, issue: "000643" }, "email")).toBe(featureWorkerName(me, "email"));
    expect(isFeatureOwnedName({ ...me, issue: "0643" }, featureWorkerName(me, "email"))).toBe(true);
  });
});

describe("assertFeatureProject", () => {
  it("refuses a project whose name carries an f<digits> segment, and names the segment", () => {
    expect(featureMarkerInProjectName("acme-f12-x")).toBe("f12");
    expect(featureMarkerInProjectName("Acme F7")).toBe("f7");
    expect(featureMarkerInProjectName("acme-fx12")).toBeNull();
    expect(featureMarkerInProjectName("f")).toBeNull();
    expect(() => assertFeatureProject("acme-f12-x")).toThrow("Its name carries f12");
    expect(() => featureWorkerName({ project: "acme-f12-x", issue: "3", slug: "y" }, "api")).toThrow(PithyError);
    expect(() => assertFeatureProject("acme")).not.toThrow();
  });
});
