// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets, sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { z } from "zod";
import type { MediaAi } from "../ai/enrich";
import { MediaConfig } from "../config/config";
import { MediaAsset } from "../data/mediaAsset";
import { MediaEnrichmentError } from "../error/errors";
import { resolveRecordStore } from "../record/resolve";
import type { MediaRecord } from "../record/store";
import { MEDIA_STORAGE_SECRET, mediaSecretsRegistry } from "../secret/registry";
import {
  type EnrichDeps,
  runAudioTranscription,
  runDocumentExtraction,
  runImageToText,
  runVideoTranscription,
} from "./enrich";
import { fetchVideoAudio } from "./hls";

/**
 * The prebuilt media worker. `pithy media provision` deploys one per environment; the adopter authors no
 * code for it. It hosts the four enrichment Workflows — image-to-text, audio transcription, video
 * transcription, and document extraction — each a thin durable shell around the tested orchestration in
 * `enrich.ts`. The app worker holds their bindings and starts an instance on finalize.
 *
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime (excluded from the node
 * meta-test). The worker reads records with a passthrough schema so an adopter's extension fields survive
 * the derived-field write-back untouched, without the worker needing the adopter's extension code.
 */

/** The media worker's env: the record bindings, the R2 bucket, the AI binding, the secrets, and config. */
export interface MediaWorkerEnv extends SecretsStoreEnv {
  /** The app database the media table lives in (D1 record store). */
  DB: D1Database;
  /** The KV namespace media records live in (KV record store). */
  MEDIA: KVNamespace;
  /** The R2 bucket media objects are read from. */
  MEDIA_BUCKET: R2Bucket;
  /** The Workers AI binding. */
  AI: MediaAi;
  /** The resolved media config as a JSON string, filled at provision. */
  MEDIA_CONFIG?: string;
  /**
   * The project name, stamped alongside `ENVIRONMENT` at provision. Enrichment only reads and updates
   * existing assets, so nothing here mints one — but the var is part of every host's identity, and it
   * is what any future create path in this worker would stamp ownership from.
   */
  PROJECT?: string;
}

// A standalone worker, not assembled by `createBackend`, so wire the shared secrets accessor directly.
configureSharedSecrets({ registry: mediaSecretsRegistry });

/** The passthrough record schema: base fields decode through codecs, extension fields ride along raw. */
const LooseAsset = MediaAsset.catchall(z.unknown());

/** Read a stored object's raw bytes: R2 through the binding, Cloudflare Images through its delivery URL. */
async function readObjectBytes(
  env: MediaWorkerEnv,
  imagesAccountHash: string | undefined,
  record: MediaRecord,
): Promise<Uint8Array> {
  if (record.storageBackend === "r2") {
    const object = await env.MEDIA_BUCKET.get(record.storageKey);
    if (!object) throw new MediaEnrichmentError({ detail: `R2 object missing: ${record.storageKey}` });
    return new Uint8Array(await object.arrayBuffer());
  }
  if (record.storageBackend === "cf-images") {
    if (!imagesAccountHash) {
      throw new MediaEnrichmentError({
        detail: "delivery.imagesAccountHash is required to read image bytes for enrichment",
      });
    }
    const url = `https://imagedelivery.net/${imagesAccountHash}/${record.storageKey}/public`;
    const response = await fetch(url);
    if (!response.ok) throw new MediaEnrichmentError({ detail: `image fetch failed (${response.status})` });
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new MediaEnrichmentError({ detail: `cannot read bytes for backend ${record.storageBackend}` });
}

/**
 * Assemble the enrichment dependencies from the worker env. `transcribeKind` picks which speech-to-text
 * model config supplies — audio and video are configured independently. A job that does not transcribe
 * (image-to-text, document extraction) omits it and never reads the value; the audio model is the inert
 * default rather than a claim about what the job does.
 */
async function buildDeps(env: MediaWorkerEnv, transcribeKind: "audio" | "video" = "audio"): Promise<EnrichDeps> {
  // Parsed once per run and threaded through — the models, the record store, and the delivery hash all
  // come from this one config.
  const config = MediaConfig.parse(env.MEDIA_CONFIG ? JSON.parse(env.MEDIA_CONFIG) : {});
  const store = resolveRecordStore(env, config, LooseAsset);
  const secrets = await sharedSecretsStore(env, mediaSecretsRegistry);
  const credentials = secrets.get(MEDIA_STORAGE_SECRET);
  const imagesAccountHash = config.delivery.imagesAccountHash;
  const streamManager = new CloudflareStreamManager({
    apiToken: credentials.apiToken,
    accountId: credentials.accountId,
  });
  return {
    store,
    ai: env.AI,
    models: {
      imageToText: config.images.model,
      transcribe: transcribeKind === "video" ? config.video.model : config.audio.model,
    },
    readBytes: (record) => readObjectBytes(env, imagesAccountHash, record),
    readDocument: async (record) => ({
      name: record.filename,
      blob: new Blob([await readObjectBytes(env, imagesAccountHash, record)]),
    }),
    fetchVideoAudio: async (record) => {
      const details = (await streamManager.getVideoDetails(record.storageKey)) as { playback?: { hls?: string } };
      const hls = details.playback?.hls;
      if (!hls) throw new MediaEnrichmentError({ detail: `video ${record.storageKey} has no HLS playback URL yet` });
      return fetchVideoAudio(hls);
    },
  };
}

/** Image → alt text and caption. Does not transcribe. */
export class MediaImageToTextWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env);
    await step.do(`image-to-text-${event.payload.id}`, () => runImageToText(deps, event.payload.id));
  }
}

/** Audio → transcription. */
export class MediaAudioTranscribeWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env, "audio");
    await step.do(`transcribe-audio-${event.payload.id}`, () => runAudioTranscription(deps, event.payload.id));
  }
}

/** Video → transcription (Stream readiness + HLS batching). */
export class MediaVideoTranscribeWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env, "video");
    await step.do(`transcribe-video-${event.payload.id}`, () => runVideoTranscription(deps, event.payload.id));
  }
}

/** Document → extracted text. Does not transcribe. */
export class MediaDocExtractWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env);
    await step.do(`extract-document-${event.payload.id}`, () => runDocumentExtraction(deps, event.payload.id));
  }
}
