// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type Fetcher, fetchVideoAudio, parseAudioRenditionUri, parseMediaPlaylist } from "./hls";

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,URI="audio/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="audio"
video/playlist.m3u8`;

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg_0.mp4
#EXTINF:6.0,
seg_1.mp4`;

describe("parseAudioRenditionUri", () => {
  test("extracts the audio rendition URI", () => {
    expect(parseAudioRenditionUri(MASTER)).toBe("audio/playlist.m3u8");
  });

  test("returns null when no audio rendition is present", () => {
    expect(parseAudioRenditionUri("#EXTM3U\nvideo/playlist.m3u8")).toBeNull();
  });
});

describe("parseMediaPlaylist", () => {
  test("extracts the init segment and timed media segments", () => {
    const parsed = parseMediaPlaylist(MEDIA_PLAYLIST);
    expect(parsed.initUri).toBe("init.mp4");
    expect(parsed.segments).toEqual([
      { uri: "seg_0.mp4", durationSec: 6 },
      { uri: "seg_1.mp4", durationSec: 6 },
    ]);
  });
});

describe("fetchVideoAudio", () => {
  test("assembles the init segment and media segments from the HLS manifests", async () => {
    const bodies: Record<string, string> = {
      "https://stream/master.m3u8": MASTER,
      "https://stream/audio/playlist.m3u8": MEDIA_PLAYLIST,
    };
    const fetcher: Fetcher = async (url) => ({
      ok: true,
      status: 200,
      text: async () => bodies[url] ?? "",
      arrayBuffer: async () => new Uint8Array([url.length]).buffer,
    });
    const source = await fetchVideoAudio("https://stream/master.m3u8", fetcher);
    expect(source.segments).toHaveLength(2);
    expect(source.segments[0]?.durationSec).toBe(6);
    expect(source.init.length).toBeGreaterThan(0);
  });

  test("throws when a fetch fails", async () => {
    const fetcher: Fetcher = async () => ({
      ok: false,
      status: 404,
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(fetchVideoAudio("https://stream/master.m3u8", fetcher)).rejects.toMatchObject({
      payload: { code: "media/enrichment_failed" },
    });
  });
});
