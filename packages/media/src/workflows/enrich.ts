// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { extractMarkdown, generateImageText, type MediaAi, transcribeAudioBytes } from "../ai/enrich";
import {
  type AudioSegment,
  deduplicateOverlappingTranscripts,
  groupSegmentsForTranscription,
} from "../ai/videoBatching";
import type { MediaRecord, RecordStore } from "../record/store";

/**
 * The enrichment orchestration — the pure, testable core each Workflow step runs. Every function reads a
 * record, produces derived content with Workers AI, and writes it back through the record store. Byte
 * access is an injected seam (`readBytes` / `readDocument` / `fetchVideoAudio`) so the orchestration is
 * exercised against fakes; the Workflow worker wires the real reads over the R2 binding and the Stream
 * manager. The AI model is always a parameter, defaulted from config.
 */

/** One audio segment's bytes and duration, from a Stream HLS audio rendition. */
export interface AudioSegmentBytes {
  /** The decoded segment bytes (a fragmented-MP4 media segment). */
  bytes: Uint8Array;
  /** The segment's duration in seconds, from the HLS `#EXTINF` tag. */
  durationSec: number;
}

/** The audio a video's transcription reads: the shared fMP4 init segment plus the ordered media segments. */
export interface VideoAudioSource {
  /** The fragmented-MP4 initialization segment — codec config, prepended to every group. */
  init: Uint8Array;
  /** The ordered audio segments. */
  segments: AudioSegmentBytes[];
}

/** The dependencies the enrichment functions need, all injectable. */
export interface EnrichDeps {
  /** The record store, bound to the effective schema. */
  store: RecordStore;
  /** The Workers AI binding. */
  ai: MediaAi;
  /** The configured models, per feature. */
  models: { imageToText: string; transcribe: string };
  /** Read a stored object's raw bytes (images from R2 or delivery URL; audio from R2). */
  readBytes: (record: MediaRecord) => Promise<Uint8Array>;
  /** Read a document as a Blob for `toMarkdown`. */
  readDocument: (record: MediaRecord) => Promise<{ name: string; blob: Blob }>;
  /** Fetch a video's HLS audio rendition as an init segment plus ordered media segments. */
  fetchVideoAudio: (record: MediaRecord) => Promise<VideoAudioSource>;
}

/** Concatenate byte chunks into one buffer. */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Generate alt text and a caption for an image and write them to the record. */
export async function runImageToText(deps: EnrichDeps, id: string): Promise<void> {
  const record = await deps.store.get(id);
  if (record?.type !== "image") return;
  const bytes = await deps.readBytes(record);
  const { altText, caption } = await generateImageText(deps.ai, bytes, deps.models.imageToText);
  await deps.store.patch(id, { altText, caption, updatedAt: new Date() });
}

/** Transcribe an audio file in one call and write the transcription to the record. */
export async function runAudioTranscription(deps: EnrichDeps, id: string): Promise<void> {
  const record = await deps.store.get(id);
  if (record?.type !== "audio") return;
  const bytes = await deps.readBytes(record);
  const transcription = await transcribeAudioBytes(deps.ai, bytes, deps.models.transcribe);
  await deps.store.patch(id, { transcription, hasTranscription: true, updatedAt: new Date() });
}

/** Extract markdown text from a document and write it to the record. */
export async function runDocumentExtraction(deps: EnrichDeps, id: string): Promise<void> {
  const record = await deps.store.get(id);
  if (record?.type !== "document") return;
  const file = await deps.readDocument(record);
  const extractedText = await extractMarkdown(deps.ai, [file]);
  await deps.store.patch(id, { extractedText, hasExtractedText: true, updatedAt: new Date() });
}

/**
 * Transcribe a video's audio: fetch its HLS audio rendition, group the segments into ~30s overlapping
 * batches (whisper has a per-call input limit), transcribe each batch with the shared fMP4 init segment
 * prepended, then stitch the batches back with overlap-dedup. Writes the transcription to the record.
 */
export async function runVideoTranscription(deps: EnrichDeps, id: string): Promise<void> {
  const record = await deps.store.get(id);
  if (record?.type !== "video") return;
  const source = await deps.fetchVideoAudio(record);
  const asSegments: AudioSegment[] = source.segments.map((segment, index) => ({
    uri: String(index),
    durationSec: segment.durationSec,
  }));
  const groups = groupSegmentsForTranscription(asSegments);
  const transcripts: string[] = [];
  for (const group of groups) {
    const parts: Uint8Array[] = [source.init];
    for (const segment of group.segments) {
      const bytes = source.segments[Number(segment.uri)]?.bytes;
      if (bytes) parts.push(bytes);
    }
    transcripts.push(await transcribeAudioBytes(deps.ai, concatBytes(parts), deps.models.transcribe));
  }
  const transcription = deduplicateOverlappingTranscripts(transcripts);
  await deps.store.patch(id, { transcription, hasTranscription: true, updatedAt: new Date() });
}
