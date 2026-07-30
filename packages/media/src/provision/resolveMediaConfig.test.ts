// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import { resolveMediaConfig } from "./resolveMediaConfig";

/** Mirrors `src/workflows/wrangler.jsonc` — the shape provisioning resolves. */
function template(): WorkflowHostTemplate {
  return {
    name: "pithy-media",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    d1_databases: [
      { binding: "DB", database_name: "pithy-app", database_id: "<filled-at-provision>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled-at-provision>" },
    ],
    kv_namespaces: [{ binding: "MEDIA", id: "<filled-at-provision>" }],
    r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "<filled-at-provision>" }],
    ai: { binding: "AI" },
    secrets_store_secrets: [
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "<filled-at-provision>",
        secret_name: "SECRETS_ENCRYPTION_KEYS",
      },
    ],
    workflows: [
      { binding: "MEDIA_IMAGE_TO_TEXT", name: "pithy-media-image-to-text", class_name: "MediaImageToTextWorkflow" },
      {
        binding: "MEDIA_AUDIO_TRANSCRIBE",
        name: "pithy-media-audio-transcribe",
        class_name: "MediaAudioTranscribeWorkflow",
      },
      {
        binding: "MEDIA_VIDEO_TRANSCRIBE",
        name: "pithy-media-video-transcribe",
        class_name: "MediaVideoTranscribeWorkflow",
      },
      { binding: "MEDIA_DOC_EXTRACT", name: "pithy-media-doc-extract", class_name: "MediaDocExtractWorkflow" },
    ],
    vars: { MEDIA_CONFIG: "<filled-at-provision>", ENVIRONMENT: "<filled-at-provision>" },
  };
}

const BASE = {
  appDatabaseId: "app-1",
  secretsDatabaseId: "sec-1",
  storeId: "store-1",
  mediaConfig: MediaConfig.parse({}),
};

describe("resolveMediaConfig", () => {
  test("fills the worker name, both database ids, the bucket, and the store id", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "pithy-media", kvNamespaceId: "kv-1" },
    });

    expect(resolved.name).toBe("pithy-media-staging");
    expect(resolved.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-1" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "sec-1" },
    ]);
    expect(resolved.r2_buckets).toEqual([{ binding: "MEDIA_BUCKET", bucket_name: "pithy-media" }]);
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("store-1");
  });

  test("suffixes every Workflow name with the environment, matching the deployed names", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "production",
      resources: { bucketName: "pithy-media", kvNamespaceId: null },
    });

    expect(resolved.workflows?.map((workflow) => workflow.name)).toEqual([
      "pithy-media-image-to-text-production",
      "pithy-media-audio-transcribe-production",
      "pithy-media-video-transcribe-production",
      "pithy-media-doc-extract-production",
    ]);
    // Code references, never deployment identities — neither is rewritten.
    expect(resolved.workflows?.map((workflow) => workflow.class_name)).toEqual([
      "MediaImageToTextWorkflow",
      "MediaAudioTranscribeWorkflow",
      "MediaVideoTranscribeWorkflow",
      "MediaDocExtractWorkflow",
    ]);
  });

  test("keeps the MEDIA binding, filled, when records live in KV", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "pithy-media", kvNamespaceId: "kv-1" },
    });
    expect(resolved.kv_namespaces).toEqual([{ binding: "MEDIA", id: "kv-1" }]);
  });

  test("drops the MEDIA binding entirely in D1 mode — never binds a namespace that was not created", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "pithy-media", kvNamespaceId: null },
    });
    expect(resolved.kv_namespaces).toBeUndefined();
  });

  test("serializes the media config and stamps the environment", () => {
    const mediaConfig = MediaConfig.parse({ recordStore: "kv", images: { imageToText: true } });
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      mediaConfig,
      env: "production",
      resources: { bucketName: "pithy-media", kvNamespaceId: "kv-1" },
    });

    expect(resolved.vars?.ENVIRONMENT).toBe("production");
    expect(MediaConfig.parse(JSON.parse(resolved.vars?.MEDIA_CONFIG ?? "{}"))).toEqual(mediaConfig);
  });

  test("names the environment's master key, matching what the secrets manager wrote", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "pithy-media", kvNamespaceId: null },
    });
    expect(resolved.secrets_store_secrets?.[0]?.secret_name).toBe(masterKeySecretName("staging"));
  });

  test("leaves no placeholder behind in any resolved field", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "pithy-media", kvNamespaceId: "kv-1" },
    });
    expect(JSON.stringify(resolved)).not.toContain("<filled-at-provision>");
  });
});
