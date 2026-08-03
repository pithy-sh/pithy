// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
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
    vars: {
      MEDIA_CONFIG: "<filled-at-provision>",
      ENVIRONMENT: "<filled-at-provision>",
      PROJECT: "<filled-at-provision>",
    },
  };
}

const BASE = {
  project: "acme",
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
      resources: { bucketName: "acme-staging-media", kvNamespaceId: "kv-1" },
    });

    expect(resolved.name).toBe("acme-staging-media");
    expect(resolved.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-1" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "sec-1" },
    ]);
    expect(resolved.r2_buckets).toEqual([{ binding: "MEDIA_BUCKET", bucket_name: "acme-staging-media" }]);
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("store-1");
  });

  test("names every Workflow for the project and the environment, matching the deployed names", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "prod",
      resources: { bucketName: "acme-staging-media", kvNamespaceId: null },
    });

    expect(resolved.workflows?.map((workflow) => workflow.name)).toEqual([
      "acme-prod-media-image-to-text",
      "acme-prod-media-audio-transcribe",
      "acme-prod-media-video-transcribe",
      "acme-prod-media-doc-extract",
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
      resources: { bucketName: "acme-staging-media", kvNamespaceId: "kv-1" },
    });
    expect(resolved.kv_namespaces).toEqual([{ binding: "MEDIA", id: "kv-1" }]);
  });

  test("drops the MEDIA binding entirely in D1 mode — never binds a namespace that was not created", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "acme-staging-media", kvNamespaceId: null },
    });
    expect(resolved.kv_namespaces).toBeUndefined();
  });

  test("serializes the media config and stamps the environment", () => {
    const mediaConfig = MediaConfig.parse({ recordStore: "kv", images: { imageToText: true } });
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      mediaConfig,
      env: "prod",
      resources: { bucketName: "acme-staging-media", kvNamespaceId: "kv-1" },
    });

    expect(resolved.vars?.ENVIRONMENT).toBe("prod");
    expect(MediaConfig.parse(JSON.parse(resolved.vars?.MEDIA_CONFIG ?? "{}"))).toEqual(mediaConfig);
  });

  test("stamps PROJECT, so an asset the worker mints carries an owner Images and Stream can be swept by", async () => {
    // Images and Stream are account-flat and keyed by a CF-minted id, so nothing but this var tells the
    // runtime which project owns the asset it is about to create.
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "acme-staging-media", kvNamespaceId: null },
    });
    expect(resolved.vars?.PROJECT).toBe("acme");

    // And the committed template declares the var the resolver fills, so the file reads as a complete config.
    const source = await readFile(new URL("../workflows/wrangler.jsonc", import.meta.url), "utf8");
    expect(source).toContain('"PROJECT"');
  });

  test("names the environment's master key, matching what the secrets manager wrote", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "acme-staging-media", kvNamespaceId: null },
    });
    expect(resolved.secrets_store_secrets?.[0]?.secret_name).toBe(masterKeySecretName("acme", "staging"));
  });

  test("a second project resolves to entirely different worker and Workflow names", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      project: "globex",
      env: "prod",
      resources: { bucketName: "globex-prod-media", kvNamespaceId: null },
    });
    expect(resolved.name).toBe("globex-prod-media");
    expect(resolved.workflows?.[0]?.name).toBe("globex-prod-media-image-to-text");
  });

  test("leaves no placeholder behind in any resolved field", () => {
    const resolved = resolveMediaConfig(template(), {
      ...BASE,
      env: "staging",
      resources: { bucketName: "acme-staging-media", kvNamespaceId: "kv-1" },
    });
    expect(JSON.stringify(resolved)).not.toContain("<filled-at-provision>");
  });
});
