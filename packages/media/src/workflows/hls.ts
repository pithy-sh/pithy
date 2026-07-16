import { MediaEnrichmentError } from "../error/errors";
import type { VideoAudioSource } from "./enrich";

/**
 * Minimal HLS parsing for Cloudflare Stream's audio rendition. Stream serves a master manifest that
 * points at an audio-only rendition; that rendition is a fragmented-MP4 playlist — a single `#EXT-X-MAP`
 * init segment plus `#EXTINF`-timed media segments, each undecodable without the init. The two parsers
 * are pure and unit-tested; {@link fetchVideoAudio} is the thin fetch orchestrator the Workflow injects.
 */

/** Extract the audio rendition's playlist URI from a master manifest, or null if none is present. */
export function parseAudioRenditionUri(master: string): string | null {
  for (const line of master.split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line)) {
      const match = line.match(/URI="([^"]+)"/);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

/** One media segment reference: its URI and duration in seconds. */
export interface MediaSegmentRef {
  /** The segment URI, relative to the media playlist. */
  uri: string;
  /** The segment duration in seconds, from its `#EXTINF` tag. */
  durationSec: number;
}

/** Parse an fMP4 media playlist into its init-segment URI and ordered, timed media segments. */
export function parseMediaPlaylist(playlist: string): { initUri: string | null; segments: MediaSegmentRef[] } {
  const lines = playlist.split(/\r?\n/);
  let initUri: string | null = null;
  let pendingDuration: number | null = null;
  const segments: MediaSegmentRef[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = line.match(/URI="([^"]+)"/);
      if (match?.[1]) initUri = match[1];
    } else if (line.startsWith("#EXTINF:")) {
      const value = Number.parseFloat(line.slice("#EXTINF:".length));
      pendingDuration = Number.isFinite(value) ? value : 0;
    } else if (line.length > 0 && !line.startsWith("#")) {
      segments.push({ uri: line, durationSec: pendingDuration ?? 0 });
      pendingDuration = null;
    }
  }
  return { initUri, segments };
}

/** A minimal fetcher seam so {@link fetchVideoAudio} is injectable in tests. */
export type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Fetch and validate a URL, throwing a media enrichment error on a non-OK response. */
async function fetchOrThrow(
  fetcher: Fetcher,
  url: string,
): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new MediaEnrichmentError({ detail: `HLS fetch failed (${response.status}): ${url}` });
  }
  return response;
}

/**
 * Fetch a Stream video's HLS audio rendition and assemble it into a {@link VideoAudioSource}: the init
 * segment plus every media segment's bytes and duration, ready for {@link runVideoTranscription} to group.
 */
export async function fetchVideoAudio(masterUrl: string, fetcher: Fetcher = globalFetcher): Promise<VideoAudioSource> {
  const master = await (await fetchOrThrow(fetcher, masterUrl)).text();
  const renditionUri = parseAudioRenditionUri(master);
  if (!renditionUri) throw new MediaEnrichmentError({ detail: "no audio rendition in the HLS master manifest" });
  const renditionUrl = new URL(renditionUri, masterUrl).toString();

  const playlist = await (await fetchOrThrow(fetcher, renditionUrl)).text();
  const { initUri, segments } = parseMediaPlaylist(playlist);
  if (!initUri) throw new MediaEnrichmentError({ detail: "no init segment in the HLS audio playlist" });

  const init = new Uint8Array(
    await (await fetchOrThrow(fetcher, new URL(initUri, renditionUrl).toString())).arrayBuffer(),
  );
  const resolved = [];
  for (const segment of segments) {
    const url = new URL(segment.uri, renditionUrl).toString();
    const bytes = new Uint8Array(await (await fetchOrThrow(fetcher, url)).arrayBuffer());
    resolved.push({ bytes, durationSec: segment.durationSec });
  }
  return { init, segments: resolved };
}

/** The default fetcher — the Workers global `fetch`. */
const globalFetcher: Fetcher = (url) => fetch(url);
