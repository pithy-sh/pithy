// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { MAX_ENVIRONMENT_NAME } from "./environment";
import {
  FEATURE_DERIVED_PROJECT_NAME,
  MAX_CAPABILITY_JOB,
  MAX_ISSUE_DIGITS,
  MAX_PITHY_NAME,
  MIN_LEGIBLE_SLUG,
  MIN_VERBATIM_BINDING,
  NAMESPACE_LIMITS,
  WORKFLOW_DERIVED_PROJECT_NAME,
} from "./limits";
import { MAX_PROJECT_NAME } from "./resource";

describe("NAMESPACE_LIMITS", () => {
  it("carries each namespace's own verified cap, not one shared number", () => {
    // Every row here is read off Cloudflare's own documentation or OpenAPI schema. They disagree,
    // and that disagreement is the point — one shared 63 over-truncated KV eightfold and truncated
    // D1, Secrets Store, and token names against limits that do not exist.
    expect(NAMESPACE_LIMITS.workflow.maxLength).toBe(64);
    expect(NAMESPACE_LIMITS.worker.maxLength).toBe(63);
    expect(NAMESPACE_LIMITS.r2.maxLength).toBe(63);
    expect(NAMESPACE_LIMITS.r2.minLength).toBe(3);
    expect(NAMESPACE_LIMITS.vectorizeIndex.maxLength).toBe(64);
    expect(NAMESPACE_LIMITS.kv.maxLength).toBe(512);
  });

  it("holds the Workflow and Worker caps apart, because they are genuinely different numbers", () => {
    // 64 for a Workflow name; 63 for a Worker script, which is the workers.dev subdomain's cap and
    // the only one that survives an adopter turning workers.dev on.
    expect(NAMESPACE_LIMITS.workflow.maxLength).not.toBe(NAMESPACE_LIMITS.worker.maxLength);
    expect(NAMESPACE_LIMITS.workflow.maxLength - NAMESPACE_LIMITS.worker.maxLength).toBe(1);
  });

  it("marks a ceiling Pithy chose as Pithy's, so nobody reads it as Cloudflare's", () => {
    // D1 database names, Secrets Store entries, and API token labels have no published cap. We do
    // not invent one and call it Cloudflare's; we pick a legible ceiling and say whose it is.
    for (const namespace of ["d1", "secretEntry", "apiToken"] as const) {
      expect(NAMESPACE_LIMITS[namespace].source).toBe("pithy");
      expect(NAMESPACE_LIMITS[namespace].maxLength).toBe(MAX_PITHY_NAME);
    }
    for (const namespace of ["workflow", "worker", "r2", "vectorizeIndex", "kv"] as const) {
      expect(NAMESPACE_LIMITS[namespace].source).toBe("cloudflare");
    }
  });

  it("refuses where a rename is destructive and truncates where it is not", () => {
    // A renamed Workflow orphans its running instances, a renamed Worker script orphans a
    // deployment, and a renamed Vectorize index orphans its vectors. Those three refuse. The rest
    // are addressed by a name Pithy recomputes, so a deterministic truncation is safe.
    expect(NAMESPACE_LIMITS.workflow.policy).toBe("refuse");
    expect(NAMESPACE_LIMITS.worker.policy).toBe("refuse");
    expect(NAMESPACE_LIMITS.vectorizeIndex.policy).toBe("refuse");
    for (const namespace of ["d1", "kv", "r2", "secretEntry", "apiToken"] as const) {
      expect(NAMESPACE_LIMITS[namespace].policy).toBe("truncate");
    }
  });

  it("gives every namespace a label an error message can name it by", () => {
    for (const limit of Object.values(NAMESPACE_LIMITS)) {
      expect(limit.label.length).toBeGreaterThan(0);
      expect(limit.minLength).toBeGreaterThanOrEqual(1);
      expect(limit.maxLength).toBeGreaterThan(limit.minLength);
    }
  });
});

describe("MAX_PROJECT_NAME", () => {
  it("is the Workflow derivation, executed", () => {
    // 64 = <project> + "-" + <env> + "-" + <capability>-<job>
    expect(WORKFLOW_DERIVED_PROJECT_NAME).toBe(
      NAMESPACE_LIMITS.workflow.maxLength - 1 - MAX_ENVIRONMENT_NAME - 1 - MAX_CAPABILITY_JOB,
    );
    expect(WORKFLOW_DERIVED_PROJECT_NAME).toBe(33);
    expect(MAX_CAPABILITY_JOB).toBe("media-audio-transcribe".length);
  });

  it("is the feature derivation, executed", () => {
    // 63 = <project> + "-f" + <issue> + "-" + <slug> + "-" + <binding> + "-" + <kind>
    expect(FEATURE_DERIVED_PROJECT_NAME).toBe(
      NAMESPACE_LIMITS.r2.maxLength - 2 - MAX_ISSUE_DIGITS - (1 + MIN_LEGIBLE_SLUG) - (1 + MIN_VERBATIM_BINDING) - 3,
    );
    expect(FEATURE_DERIVED_PROJECT_NAME).toBe(26);
    // Six digits, not seven: `f999999` is just under a million issues, and a seventh digit would
    // charge every adopter a character of project name for ten million nobody asked for.
    expect(MAX_ISSUE_DIGITS).toBe(6);
  });

  it("is the smaller of the two, because a project name has to satisfy both shapes", () => {
    expect(MAX_PROJECT_NAME).toBe(Math.min(WORKFLOW_DERIVED_PROJECT_NAME, FEATURE_DERIVED_PROJECT_NAME));
    expect(MAX_PROJECT_NAME).toBe(26);
  });
});
