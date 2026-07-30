// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError } from "../error/pithyError";
import { MAX_WORKFLOW_NAME_BYTES, workflowHostName, workflowKey, workflowScriptName } from "./naming";

describe("workflowScriptName", () => {
  it("composes pithy-<capability>-<job>-<env>", () => {
    expect(workflowScriptName("email", "send", "staging")).toBe("pithy-email-send-staging");
    expect(workflowScriptName("email", "schedule", "production")).toBe("pithy-email-schedule-production");
  });

  it("matches the names media and email already deploy under", () => {
    // These are the committed template names suffixed with an environment. Renaming a Workflow
    // orphans every instance running under the old name, so this test is the contract.
    expect(workflowScriptName("media", "image-to-text", "staging")).toBe("pithy-media-image-to-text-staging");
    expect(workflowScriptName("media", "audio-transcribe", "staging")).toBe("pithy-media-audio-transcribe-staging");
    expect(workflowScriptName("media", "video-transcribe", "production")).toBe(
      "pithy-media-video-transcribe-production",
    );
    expect(workflowScriptName("media", "doc-extract", "production")).toBe("pithy-media-doc-extract-production");
    expect(workflowScriptName("leaderboard", "rank", "staging")).toBe("pithy-leaderboard-rank-staging");
  });

  it("accepts digits and inner hyphens in every segment", () => {
    expect(workflowScriptName("vector", "reprocess", "dev")).toBe("pithy-vector-reprocess-dev");
    expect(workflowScriptName("storage", "orphan-sweep", "dev")).toBe("pithy-storage-orphan-sweep-dev");
    expect(workflowScriptName("a1", "b2-c3", "dev")).toBe("pithy-a1-b2-c3-dev");
  });

  it.each([
    ["an uppercase letter", "Media", "job", "dev"],
    ["an underscore", "media", "image_to_text", "dev"],
    ["a leading digit", "1media", "job", "dev"],
    ["a leading hyphen", "-media", "job", "dev"],
    ["a trailing hyphen", "media-", "job", "dev"],
    ["a double hyphen", "media", "a--b", "dev"],
    ["an empty segment", "media", "", "dev"],
    ["a dot", "media", "a.b", "dev"],
  ])("rejects %s", (_label, capability, job, env) => {
    expect(() => workflowScriptName(capability, job, env)).toThrow(PithyError);
  });

  it("names the offending role so the author knows which segment is wrong", () => {
    expect(() => workflowScriptName("Media", "job", "dev")).toThrow(/capability/);
    expect(() => workflowScriptName("media", "Job", "dev")).toThrow(/job/);
    expect(() => workflowScriptName("media", "job", "Dev")).toThrow(/environment/);
  });

  it("rejects a name past Cloudflare's byte limit rather than letting the deploy fail", () => {
    const long = "a".repeat(MAX_WORKFLOW_NAME_BYTES);
    expect(() => workflowScriptName(long, "job", "production")).toThrow(/64-byte limit/);
  });

  it("accepts a name at exactly the limit", () => {
    // "pithy-" + capability + "-job-dev" = 6 + n + 8 bytes.
    const capability = "a".repeat(MAX_WORKFLOW_NAME_BYTES - 14);
    const name = workflowScriptName(capability, "job", "dev");
    expect(new TextEncoder().encode(name).length).toBe(MAX_WORKFLOW_NAME_BYTES);
  });
});

describe("workflowHostName", () => {
  it("composes pithy-<capability>-<env>, matching emailWorkerName and managerWorkerName", () => {
    expect(workflowHostName("email", "staging")).toBe("pithy-email-staging");
    expect(workflowHostName("email", "production")).toBe("pithy-email-production");
    expect(workflowHostName("media", "staging")).toBe("pithy-media-staging");
    expect(workflowHostName("secrets", "production")).toBe("pithy-secrets-production");
  });

  it("rejects an invalid segment", () => {
    expect(() => workflowHostName("Media", "staging")).toThrow(PithyError);
    expect(() => workflowHostName("media", "Staging")).toThrow(PithyError);
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

  it("rejects an invalid segment", () => {
    expect(() => workflowKey("media", "image_to_text")).toThrow(PithyError);
  });
});
