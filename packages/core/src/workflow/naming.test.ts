// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError, ValidationError } from "../error/pithyError";
import { MAX_ENVIRONMENT_NAME } from "../naming/environment";
import { MAX_CAPABILITY_JOB } from "../naming/limits";
import { MAX_PROJECT_NAME, resourceName } from "../naming/resource";
import {
  MAX_WORKER_NAME_BYTES,
  MAX_WORKFLOW_NAME_BYTES,
  workflowHostName,
  workflowKey,
  workflowScriptName,
} from "./naming";

describe("workflowScriptName", () => {
  it("composes <project>-<env>-<capability>-<job>", () => {
    expect(workflowScriptName({ project: "acme", capability: "email", job: "send", env: "staging" })).toBe(
      "acme-staging-email-send",
    );
    expect(workflowScriptName({ project: "acme", capability: "email", job: "schedule", env: "prod" })).toBe(
      "acme-prod-email-schedule",
    );
  });

  it("gives two projects different Workflow names for the same capability, job, and environment", () => {
    // A Workflow name is account-scoped. Without the project segment the second project's deploy
    // does not collide — it overwrites the first project's running Worker.
    const a = workflowScriptName({ project: "acme", capability: "email", job: "send", env: "prod" });
    const b = workflowScriptName({ project: "beta", capability: "email", job: "send", env: "prod" });
    expect(a).not.toBe(b);
  });

  it("accepts digits and inner hyphens in every segment", () => {
    expect(workflowScriptName({ project: "acme", capability: "vector", job: "reprocess", env: "dev" })).toBe(
      "acme-dev-vector-reprocess",
    );
    expect(workflowScriptName({ project: "acme", capability: "storage", job: "orphan-sweep", env: "dev" })).toBe(
      "acme-dev-storage-orphan-sweep",
    );
    expect(workflowScriptName({ project: "a1", capability: "b2", job: "c3-d4", env: "dev" })).toBe("a1-dev-b2-c3-d4");
  });

  it("kebabs the project, because it is the one segment a human typed", () => {
    expect(workflowScriptName({ project: "Acme Corp", capability: "email", job: "send", env: "dev" })).toBe(
      "acme-corp-dev-email-send",
    );
  });

  it.each([
    ["an uppercase capability", { capability: "Media", job: "job" }],
    ["an underscore in the job", { capability: "media", job: "image_to_text" }],
    ["a leading digit", { capability: "1media", job: "job" }],
    ["a leading hyphen", { capability: "-media", job: "job" }],
    ["a trailing hyphen", { capability: "media-", job: "job" }],
    ["a double hyphen", { capability: "media", job: "a--b" }],
    ["an empty segment", { capability: "media", job: "" }],
    ["a dot", { capability: "media", job: "a.b" }],
  ])("rejects %s", (_label, parts) => {
    expect(() => workflowScriptName({ project: "acme", env: "dev", ...parts })).toThrow(PithyError);
  });

  it("rejects a project that cannot be kebabbed into a legal segment", () => {
    expect(() => workflowScriptName({ project: "", capability: "media", job: "job", env: "dev" })).toThrow(PithyError);
    expect(() => workflowScriptName({ project: "!!!", capability: "media", job: "job", env: "dev" })).toThrow(
      PithyError,
    );
    expect(() => workflowScriptName({ project: "1acme", capability: "media", job: "job", env: "dev" })).toThrow(
      PithyError,
    );
  });

  it("names the offending role so the author knows which segment is wrong", () => {
    expect(() => workflowScriptName({ project: "1acme", capability: "media", job: "job", env: "dev" })).toThrow(
      /project/,
    );
    expect(() => workflowScriptName({ project: "acme", capability: "Media", job: "job", env: "dev" })).toThrow(
      /capability/,
    );
    expect(() => workflowScriptName({ project: "acme", capability: "media", job: "Job", env: "dev" })).toThrow(/job/);
    expect(() => workflowScriptName({ project: "acme", capability: "media", job: "job", env: "Dev" })).toThrow(
      /environment/,
    );
  });

  it("rejects a name past Cloudflare's byte limit rather than letting the deploy fail", () => {
    // The environment is the one segment with no cap of its own — the project has MAX_PROJECT_NAME and
    // the tail has MAX_CAPABILITY_JOB, so an adopter's own long environment name is what still reaches
    // this backstop.
    const env = "e".repeat(MAX_WORKFLOW_NAME_BYTES);
    expect(() => workflowScriptName({ project: "acme", capability: "media", job: "send", env })).toThrow(
      /64-byte limit/,
    );
  });

  it("accepts a name at exactly the limit", () => {
    // "acme-" + env + "-media-send" = 5 + n + 11 bytes.
    const env = "e".repeat(MAX_WORKFLOW_NAME_BYTES - 16);
    const name = workflowScriptName({ project: "acme", capability: "media", job: "send", env });
    expect(new TextEncoder().encode(name).length).toBe(MAX_WORKFLOW_NAME_BYTES);
  });

  it("refuses rather than truncates, because a renamed Workflow orphans its running instances", () => {
    // resourceName truncates to fit; a Workflow name must not, so these two deliberately differ.
    const capability = "a".repeat(60);
    expect(() => workflowScriptName({ project: "acme", capability, job: "job", env: "dev" })).toThrow(PithyError);
    expect(resourceName({ project: "acme", env: "dev", thing: capability })).toHaveLength(63);
  });
});

describe("workflowHostName", () => {
  it("composes <project>-<env>-<capability>", () => {
    expect(workflowHostName({ project: "acme", capability: "email", env: "staging" })).toBe("acme-staging-email");
    expect(workflowHostName({ project: "acme", capability: "email", env: "prod" })).toBe("acme-prod-email");
    expect(workflowHostName({ project: "acme", capability: "media", env: "staging" })).toBe("acme-staging-media");
    expect(workflowHostName({ project: "acme", capability: "secrets", env: "prod" })).toBe("acme-prod-secrets");
  });

  it("gives two projects different Worker script names, so one deploy cannot overwrite the other", () => {
    expect(workflowHostName({ project: "acme", capability: "secrets", env: "prod" })).not.toBe(
      workflowHostName({ project: "beta", capability: "secrets", env: "prod" }),
    );
  });

  it("leads with the same <project>-<env> head as every other provisioned name", () => {
    // The one naming rule: no namespace may order its segments differently.
    const host = workflowHostName({ project: "acme", capability: "storage", env: "prod" });
    const resource = resourceName({ project: "acme", env: "prod", thing: "storage" });
    expect(host).toBe(resource);
  });

  it("sorts a project's environments together — the reason the environment is second", () => {
    const names = [
      workflowHostName({ project: "acme", capability: "storage", env: "staging" }),
      workflowHostName({ project: "acme", capability: "email", env: "prod" }),
      workflowHostName({ project: "acme", capability: "storage", env: "prod" }),
    ].sort();
    expect(names).toEqual(["acme-prod-email", "acme-prod-storage", "acme-staging-storage"]);
  });

  it("rejects an invalid segment", () => {
    expect(() => workflowHostName({ project: "acme", capability: "Media", env: "staging" })).toThrow(PithyError);
    expect(() => workflowHostName({ project: "acme", capability: "media", env: "Staging" })).toThrow(PithyError);
    expect(() => workflowHostName({ project: "", capability: "media", env: "staging" })).toThrow(PithyError);
  });
});

/**
 * Every project name a human plausibly types, legal and not. Nothing here is about workflows in
 * particular — it is about the two namers being one rule.
 *
 * The table varies **charset and length**. It used to vary only charset — every name in it was under
 * sixteen characters — which is exactly how the two namers went on disagreeing about length while this
 * test reported them identical. The long rows below are the dimension it was missing.
 */
const PROJECT_NAMES = [
  "acme",
  "acme-corp",
  "Acme Corp",
  "PITHY",
  "a1",
  "acme2026",
  "pithy-app",
  "1password-clone",
  "2026-launch",
  "9lives",
  "",
  "!!!",
  "---",
  "northwind-traders-mobile-platform", // 33
  "northwind-traders-mobile-platform-services-hub", // 46
  "northwind-traders-mobile-platform-services-and-orders", // 53
  "northwind-traders-mobile-platform-services-and-orders-europe", // 60
];

/** Whether `name()` produced a name at all. The two namers must answer this identically. */
function accepts(name: () => string): boolean {
  try {
    name();
    return true;
  } catch {
    return false;
  }
}

describe("the project rule is one rule", () => {
  it.each(PROJECT_NAMES)("resourceName and workflowHostName agree on %j", (project) => {
    // The gap this pins: `resourceName` names the D1 that `pithy add` provisions, `workflowHostName`
    // names the worker that `pithy secrets provision` deploys. A project only the first accepts gets
    // real Cloudflare resources created and then fails at the first deploy — half-provisioned, with
    // the documented remedy (rename the project) orphaning everything already made.
    const composed = (): string => resourceName({ project, env: "dev", thing: "storage" });
    const host = (): string => workflowHostName({ project, capability: "storage", env: "dev" });
    expect(accepts(host)).toBe(accepts(composed));
    if (accepts(composed)) expect(host()).toBe(composed());
  });

  it("refuses a digit-leading project at both ends", () => {
    expect(() => resourceName({ project: "1password-clone", env: "dev", thing: "db" })).toThrow(PithyError);
    expect(() => workflowHostName({ project: "1password-clone", capability: "secrets", env: "dev" })).toThrow(
      PithyError,
    );
  });

  it("refuses an over-long project at both ends", () => {
    // The length half of the same gap. `northwind-traders-mobile-platform` composed a fine R2 bucket and
    // a fine D1 database, so `pithy add media` provisioned both for real; the first
    // `pithy media provision` then died on `…-production-media-video-transcribe`, 70 bytes. Half
    // provisioned, and the documented remedy — rename the project — orphans what was already made.
    const project = "northwind-traders-mobile-platform";
    expect(() => resourceName({ project, env: "prod", thing: "media" })).toThrow(ValidationError);
    expect(() => workflowHostName({ project, capability: "media", env: "prod" })).toThrow(ValidationError);
    expect(() => workflowScriptName({ project, capability: "media", job: "video-transcribe", env: "prod" })).toThrow(
      ValidationError,
    );
  });

  it("keeps the worst Workflow a project can ask for inside the byte limit", () => {
    // The derivation, executable: a project at the cap, the longest environment, and the longest
    // `<capability>-<job>` any registry declares. It fits, with the slack the feature shape bought —
    // `MAX_PROJECT_NAME` is the minimum of two derivations and the feature one is tighter.
    const project = "a".repeat(MAX_PROJECT_NAME);
    const worst = workflowScriptName({ project, capability: "media", job: "audio-transcribe", env: "staging" });
    expect(new TextEncoder().encode(worst).length).toBeLessThanOrEqual(MAX_WORKFLOW_NAME_BYTES);
    expect(new TextEncoder().encode(worst).length).toBe(
      MAX_PROJECT_NAME + 1 + MAX_ENVIRONMENT_NAME + 1 + MAX_CAPABILITY_JOB,
    );
  });

  it("holds a Worker script one character tighter than the Workflow it hosts", () => {
    // Not a rounding difference: 63 is the workers.dev cap on a script name, 64 is the Workflow cap.
    // A name between the two is legal as a Workflow and illegal as the script hosting it.
    const capability = "c".repeat(MAX_WORKER_NAME_BYTES - "acme-staging-".length);
    expect(workflowHostName({ project: "acme", capability, env: "staging" })).toHaveLength(MAX_WORKER_NAME_BYTES);
    expect(() => workflowHostName({ project: "acme", capability: `${capability}x`, env: "staging" })).toThrow(
      /63-byte limit/,
    );
    // …while a Workflow name gets the other number, and 64 bytes of it is fine.
    const env = "e".repeat(MAX_WORKFLOW_NAME_BYTES - "acme--media-send".length);
    const workflow = workflowScriptName({ project: "acme", capability: "media", job: "send", env });
    expect(new TextEncoder().encode(workflow).length).toBe(MAX_WORKFLOW_NAME_BYTES);
  });

  it("refuses one character past the cap before anything is provisioned", () => {
    const project = "a".repeat(MAX_PROJECT_NAME + 1);
    expect(() => resourceName({ project, env: "dev", thing: "db" })).toThrow(ValidationError);
    expect(() => workflowHostName({ project, capability: "media", env: "dev" })).toThrow(ValidationError);
  });

  it("refuses a `<capability>-<job>` longer than the cap was derived against", () => {
    // The bound is only true while no registry declares a longer tail than the one it was computed
    // from. A capability that would invalidate it fails here, loudly, instead of quietly shortening
    // every adopter's legal project name.
    expect(() =>
      workflowScriptName({ project: "acme", capability: "media", job: "audio-transcribe-and-summarise", env: "dev" }),
    ).toThrow(PithyError);
  });
});

describe("workflowKey", () => {
  it("composes <capability>/<job>", () => {
    expect(workflowKey("media", "image-to-text")).toBe("media/image-to-text");
    expect(workflowKey("email", "send")).toBe("email/send");
  });

  it("namespaces by capability, so two capabilities may each own a job of the same name", () => {
    expect(workflowKey("storage", "sweep")).not.toBe(workflowKey("vector", "sweep"));
  });

  it("stays project-free — it keys the in-Worker registry, not a Cloudflare resource", () => {
    // A Worker only ever hosts one project's capabilities, so the project would be dead weight
    // threaded through every trigger call site.
    expect(workflowKey("email", "send")).not.toMatch(/acme/);
  });

  it("rejects an invalid segment", () => {
    expect(() => workflowKey("media", "image_to_text")).toThrow(PithyError);
  });
});
