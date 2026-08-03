// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Cloudflare } from "cloudflare";
import type { DirectUploadCreateParams, DirectUploadCreateResponse } from "cloudflare/resources/stream/direct-upload";
import type { StreamEditParams, Video } from "cloudflare/resources/stream/stream";
import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Per-request CF SDK options for every Stream call: a 10s timeout and up to 3 retries — the same
 * generous envelope the Images manager uses, since video operations can be slow.
 */
const requestOptions: Cloudflare.RequestOptions = {
  timeout: 10000,
  maxRetries: 3,
};

/**
 * One download artifact's state, as returned by the Stream downloads API. The SDK types these
 * responses as `unknown`, so this Zod object is the validated shape — it is the JS↔wire boundary
 * for the raw downloads payloads.
 */
export const DownloadEntry = z
  .object({
    status: z.enum(["error", "inprogress", "ready"]).optional().describe("Where this download is in its lifecycle."),
    url: z.string().optional().describe("The download URL, present once the artifact is ready."),
    percentComplete: z.number().optional().describe("Generation progress, 0–100, while in progress."),
  })
  .describe("The state of one Stream download artifact (MP4 or audio).");
export type DownloadEntry = z.infer<typeof DownloadEntry>;

/**
 * The Stream downloads payload: the default (MP4) artifact, plus an optional audio-only (M4A) one.
 * `GET /downloads` returns every type; `POST /downloads/{type}` returns just that type.
 */
export const StreamDownloadStatus = z
  .object({
    default: DownloadEntry.describe("The default MP4 download artifact."),
    audio: DownloadEntry.optional().describe("The audio-only (M4A) download artifact, when requested."),
  })
  .describe("The set of download artifacts Cloudflare Stream has generated for a video.");
export type StreamDownloadStatus = z.infer<typeof StreamDownloadStatus>;

/** The envelope the raw audio-download endpoint returns: `{ result: { audio } }`. */
const AudioDownloadEnvelope = z
  .object({
    result: z
      .object({ audio: DownloadEntry.describe("The audio-only download artifact.") })
      .describe("The CF API result wrapper for the audio download."),
  })
  .describe("The raw `POST /downloads/audio` response envelope.");

/**
 * Validate a raw downloads payload against `StreamDownloadStatus`, mapping a Zod failure to a
 * `CloudflareInvalidResponseError` (the response did not match its expected shape) rather than
 * letting it surface as a generic request failure.
 */
function parseDownloadStatus(response: unknown): StreamDownloadStatus {
  const result = StreamDownloadStatus.safeParse(response);
  if (!result.success) {
    throw new CloudflareInvalidResponseError({
      message: "A Stream downloads response had an unexpected shape.",
      detail: result.error.message,
    });
  }
  return result.data;
}

/**
 * Out-of-Worker Cloudflare Stream access over the REST API: delete, fetch, edit, direct uploads,
 * and download (MP4 + audio-only) management from a CLI/CI/provisioning context. Video metadata is
 * the SDK's own `Video` shape — this class imposes none of its own.
 *
 * The ownership stamp is imposed one layer up, by `withAssetOwnership` in `ownership.ts`, which every
 * Pithy path that *creates* a video goes through (the seeder here, and media's `videoMinter`). Stream
 * is account-flat and keys a video by a Cloudflare-minted uid, so `meta.pithyProject` is the only
 * thing that says which project owns it.
 */
export class CloudflareStreamManager extends CloudflareManager {
  /** Delete a video by its Stream UID. */
  async deleteVideo(videoId: string): Promise<void> {
    await cloudflareRequest(`Stream delete '${videoId}'`, () =>
      this.getClient().stream.delete(videoId, { account_id: this.accountId }, requestOptions),
    );
  }

  /** Fetch a video's details by UID. */
  async getVideoDetails(videoId: string): Promise<Video> {
    return cloudflareRequest(`Stream get details for '${videoId}'`, () =>
      this.getClient().stream.get(videoId, { account_id: this.accountId }, requestOptions),
    );
  }

  /** Update a video's metadata and settings. */
  async updateVideo(videoId: string, params: Omit<StreamEditParams, "account_id">): Promise<Video> {
    return cloudflareRequest(`Stream update '${videoId}'`, () =>
      this.getClient().stream.edit(videoId, { account_id: this.accountId, ...params }, requestOptions),
    );
  }

  /** Read the download status for a video (all artifact types). */
  async videoDownloadStatus(videoId: string): Promise<StreamDownloadStatus> {
    return cloudflareRequest(`Stream download status for '${videoId}'`, async () => {
      const response = await this.getClient().stream.downloads.get(
        videoId,
        { account_id: this.accountId },
        requestOptions,
      );
      return parseDownloadStatus(response);
    });
  }

  /** Trigger Cloudflare to generate a downloadable MP4 for a video. */
  async createVideoDownload(videoId: string): Promise<StreamDownloadStatus> {
    return cloudflareRequest(`Stream create download for '${videoId}'`, async () => {
      const response = await this.getClient().stream.downloads.create(
        videoId,
        { account_id: this.accountId },
        requestOptions,
      );
      return parseDownloadStatus(response);
    });
  }

  /**
   * Request an audio-only (M4A) download for a video. The CF Node SDK does not expose the
   * type-specific `POST /downloads/audio` endpoint, so this falls back to a direct `fetch` — the
   * documented escape hatch — authenticated with the manager's API token.
   */
  async createAudioDownload(videoId: string): Promise<DownloadEntry> {
    return cloudflareRequest(`Stream create audio download for '${videoId}'`, async () => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/${videoId}/downloads/audio`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.getApiToken()}`,
            "Content-Type": "application/json",
          },
        },
      );
      if (!response.ok) {
        throw new CloudflareInvalidResponseError({
          message: "The Stream audio-download request failed.",
          detail: `Stream audio download returned ${response.status}: ${await response.text()}`,
        });
      }
      const json: unknown = await response.json();
      const envelope = AudioDownloadEnvelope.safeParse(json);
      if (!envelope.success) {
        throw new CloudflareInvalidResponseError({
          message: "The Stream audio-download response had an unexpected shape.",
          detail: envelope.error.message,
        });
      }
      return envelope.data.result.audio;
    });
  }

  /**
   * Read the audio-download status for a video. The SDK has no standalone `GET /downloads/audio`,
   * so this reads the generic downloads endpoint and extracts the `audio` entry.
   */
  async audioDownloadStatus(videoId: string): Promise<DownloadEntry> {
    return cloudflareRequest(`Stream audio download status for '${videoId}'`, async () => {
      const response = await this.getClient().stream.downloads.get(
        videoId,
        { account_id: this.accountId },
        requestOptions,
      );
      const status = parseDownloadStatus(response);
      return status.audio ?? {};
    });
  }

  /** Create a direct-upload URL for a client-side video upload. */
  async createDirectUpload(params: Omit<DirectUploadCreateParams, "account_id">): Promise<DirectUploadCreateResponse> {
    return cloudflareRequest("Stream create direct upload", () =>
      this.getClient().stream.directUpload.create({ account_id: this.accountId, ...params }, requestOptions),
    );
  }

  getServiceType(): string {
    return "Cloudflare Stream";
  }

  /** Prove access by listing videos. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().stream.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
