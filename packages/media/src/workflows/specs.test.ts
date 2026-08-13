// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { describe, expect, test } from "vitest";
import { media } from "../capability";
import { MEDIA_CAPABILITY, MediaEnrichmentParams, mediaWorkflowRegistry, mediaWorkflows } from "./specs";

describe("mediaWorkflows", () => {
  test("declares the four enrichment jobs, each hosted by its exported class", () => {
    expect(Object.entries(mediaWorkflows).map(([job, spec]) => [job, spec.binding, spec.className])).toEqual([
      ["image-to-text", "MEDIA_IMAGE_TO_TEXT", "MediaImageToTextWorkflow"],
      ["audio-transcribe", "MEDIA_AUDIO_TRANSCRIBE", "MediaAudioTranscribeWorkflow"],
      ["video-transcribe", "MEDIA_VIDEO_TRANSCRIBE", "MediaVideoTranscribeWorkflow"],
      ["doc-extract", "MEDIA_DOC_EXTRACT", "MediaDocExtractWorkflow"],
    ]);
  });

  test("every job is optional — an unprovisioned project must still boot", () => {
    expect(Object.values(mediaWorkflows).every((spec) => spec.optional)).toBe(true);
  });

  test("resolves to the names already committed in the worker template", () => {
    // Through the facade, which knows a Workflow name is the 64-character namespace and refuses one
    // past it rather than truncating — a renamed Workflow orphans every running instance.
    const names = resourceNames("acme");
    expect(names.env("staging").workflow(MEDIA_CAPABILITY, "image-to-text")).toBe("acme-staging-media-image-to-text");
    expect(names.env("prod").workflow(MEDIA_CAPABILITY, "doc-extract")).toBe("acme-prod-media-doc-extract");
  });

  test("keys the dispatch registry by `media/<job>`", () => {
    expect(Object.keys(mediaWorkflowRegistry)).toEqual([
      "media/image-to-text",
      "media/audio-transcribe",
      "media/video-transcribe",
      "media/doc-extract",
    ]);
    expect(mediaWorkflowRegistry["media/video-transcribe"]?.spec.binding).toBe("MEDIA_VIDEO_TRANSCRIBE");
  });

  test("rejects a payload without an id, so a bad trigger fails at the call site", () => {
    expect(MediaEnrichmentParams.safeParse({ id: "m1" }).success).toBe(true);
    expect(MediaEnrichmentParams.safeParse({ id: "" }).success).toBe(false);
    expect(MediaEnrichmentParams.safeParse({}).success).toBe(false);
  });
});

describe("media() bindings derived from the specs", () => {
  test("carries one optional workflow binding per job, and no hand-written duplicate", () => {
    const workflows = media().requiredBindings.filter((binding) => binding.type === "workflow");
    // The job — the map key — and the exported class ride through with the binding. They are what the
    // CLI composes the deployed Workflow name and `class_name` from, and a binding stating neither is
    // one `pithy add` and `pithy upgrade` both decline to write, silently (#318).
    expect(workflows).toEqual([
      {
        type: "workflow",
        name: "MEDIA_IMAGE_TO_TEXT",
        job: "image-to-text",
        className: "MediaImageToTextWorkflow",
        optional: true,
      },
      {
        type: "workflow",
        name: "MEDIA_AUDIO_TRANSCRIBE",
        job: "audio-transcribe",
        className: "MediaAudioTranscribeWorkflow",
        optional: true,
      },
      {
        type: "workflow",
        name: "MEDIA_VIDEO_TRANSCRIBE",
        job: "video-transcribe",
        className: "MediaVideoTranscribeWorkflow",
        optional: true,
      },
      {
        type: "workflow",
        name: "MEDIA_DOC_EXTRACT",
        job: "doc-extract",
        className: "MediaDocExtractWorkflow",
        optional: true,
      },
    ]);
  });

  test("registers the specs on the capability, so createBackend and the CLI read one declaration", () => {
    expect(media().workflows).toBe(mediaWorkflows);
  });
});
