// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { workflowHostEntry } from "@pithy-sh/core/src/workflow/hostEntry";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { z } from "zod";
import type { MediaAi } from "../ai/enrich";
import { MediaConfig } from "../config/config";
import { MediaAsset } from "../data/mediaAsset";
import { mediaDatabase } from "../data/tables";
import { resolveDeliverySigner } from "../deliver/resolve";
import type { DeliverySigner } from "../deliver/sign";
import { MediaEnrichmentError } from "../error/errors";
import { d1RecordStore } from "../record/d1Store";
import type { MediaRecord } from "../record/store";
import { mediaSecretsRegistry } from "../secret/registry";
import { mediaCloudflareConfig } from "../storage/resolve";
import {
  type EnrichDeps,
  runAudioTranscription,
  runDocumentExtraction,
  runImageToText,
  runVideoTranscription,
} from "./enrich";
import { fetchVideoAudio } from "./hls";
import { mediaWorkflowRetry } from "./retryPolicy";
import { enrichmentImageUrl, enrichmentPlaylistUrl } from "./sources";
import { MEDIA_CAPABILITY } from "./specs";

/**
 * The prebuilt media worker. `pithy media provision` deploys one per environment; the adopter authors no
 * code for it. It hosts the four enrichment Workflows — image-to-text, audio transcription, video
 * transcription, and document extraction — each a thin durable shell around the tested orchestration in
 * `enrich.ts`. The app worker holds their bindings and starts an instance on finalize.
 *
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime (excluded from the node
 * meta-test). The worker reads records with a passthrough schema so an adopter's extension fields survive
 * the derived-field write-back untouched, without the worker needing the adopter's extension code.
 *
 * **The default export is what makes this an ES module** (#426). It exports four Workflow classes and has no
 * cron, so until now it exported no default — and wrangler infers a worker's module format from exactly
 * that, so the build read it as a service worker and refused `cloudflare:workers` outright. The host did not
 * build, `pithy dev` carried on past it, and every finalize that dispatched an enrichment enriched nothing.
 * The refusal it exports is the honest body for a host with no request surface; see
 * `@pithy-sh/core/src/workflow/hostEntry`.
 */

/** The media worker's env: the record database, the R2 bucket, the AI binding, the secrets, and config. */
export interface MediaWorkerEnv extends SecretsStoreEnv {
  /** The app database the media table lives in. */
  DB: D1Database;
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

/**
 * Read a stored object's raw bytes: R2 through the binding, Cloudflare Images through its delivery URL —
 * signed, when the record's bytes are (see `sources.ts`).
 */
async function readObjectBytes(
  env: MediaWorkerEnv,
  imagesAccountHash: string | undefined,
  signer: () => Promise<DeliverySigner>,
  record: MediaRecord,
): Promise<Uint8Array> {
  if (record.storageBackend === "r2") {
    const object = await env.MEDIA_BUCKET.get(record.storageKey);
    if (!object) throw new MediaEnrichmentError({ detail: `R2 object missing: ${record.storageKey}` });
    return new Uint8Array(await object.arrayBuffer());
  }
  if (record.storageBackend === "cf-images") {
    const url = await enrichmentImageUrl(record, imagesAccountHash, signer);
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
  const store = d1RecordStore(mediaDatabase(env.DB, LooseAsset), LooseAsset);
  // The application's runtime token and media's account, read only by the job that asks Stream (#728) —
  // an image, an audio file or a document never reads a Cloudflare token here.
  const cloudflare = mediaCloudflareConfig(env, config);
  const imagesAccountHash = config.delivery.imagesAccountHash;
  // Resolved once, and only if a signed record needs it.
  let signing: Promise<DeliverySigner> | undefined;
  const signer = () => {
    signing ??= resolveDeliverySigner(env);
    return signing;
  };
  return {
    store,
    ai: env.AI,
    models: {
      imageToText: config.images.model,
      transcribe: transcribeKind === "video" ? config.video.model : config.audio.model,
    },
    readBytes: (record) => readObjectBytes(env, imagesAccountHash, signer, record),
    readDocument: async (record) => ({
      name: record.filename,
      blob: new Blob([await readObjectBytes(env, imagesAccountHash, signer, record)]),
    }),
    fetchVideoAudio: async (record) => {
      const streamManager = new CloudflareStreamManager(await cloudflare());
      const details = (await streamManager.getVideoDetails(record.storageKey)) as { playback?: { hls?: string } };
      const hls = details.playback?.hls;
      if (!hls) throw new MediaEnrichmentError({ detail: `video ${record.storageKey} has no HLS playback URL yet` });
      return fetchVideoAudio(await enrichmentPlaylistUrl(record, hls, signer));
    },
  };
}

/**
 * The four enrichment Workflows all run their one step under {@link mediaWorkflowRetry}: an
 * unreachable model, an unreachable Stream API, and a video whose asset is still encoding re-drive;
 * a record that is gone, a type enrichment cannot read, and a model answer the schema refuses fail at
 * once. See `retryPolicy.ts` — the asymmetry matters more here than anywhere else in the kit, because
 * nothing restarts an enrichment and a missing caption looks exactly like a caption nobody wanted.
 */

/** Image → alt text and caption. Does not transcribe. */
export class MediaImageToTextWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env);
    await classifiedSteps(step, mediaWorkflowRetry, NonRetryableError).do(`image-to-text-${event.payload.id}`, () =>
      runImageToText(deps, event.payload.id),
    );
  }
}

/** Audio → transcription. */
export class MediaAudioTranscribeWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env, "audio");
    await classifiedSteps(step, mediaWorkflowRetry, NonRetryableError).do(`transcribe-audio-${event.payload.id}`, () =>
      runAudioTranscription(deps, event.payload.id),
    );
  }
}

/** Video → transcription (Stream readiness + HLS batching). */
export class MediaVideoTranscribeWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env, "video");
    await classifiedSteps(step, mediaWorkflowRetry, NonRetryableError).do(`transcribe-video-${event.payload.id}`, () =>
      runVideoTranscription(deps, event.payload.id),
    );
  }
}

/** Document → extracted text. Does not transcribe. */
export class MediaDocExtractWorkflow extends WorkflowEntrypoint<MediaWorkerEnv, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const deps = await buildDeps(this.env);
    await classifiedSteps(step, mediaWorkflowRetry, NonRetryableError).do(`extract-document-${event.payload.id}`, () =>
      runDocumentExtraction(deps, event.payload.id),
    );
  }
}

/**
 * The module's default export, and therefore its format. See `hostEntry` for why a Workflow host needs one
 * at all, and why this one refuses rather than being empty: nothing reaches this worker over HTTP — the
 * media routes live in the app worker, which starts an instance on the matching binding at finalize.
 */
export default workflowHostEntry(MEDIA_CAPABILITY);
