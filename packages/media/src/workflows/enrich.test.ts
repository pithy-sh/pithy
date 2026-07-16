import { describe, expect, test } from "vitest";
import type { MediaAi } from "../ai/enrich";
import type { MediaRecord, RecordStore } from "../record/store";
import {
  type EnrichDeps,
  runAudioTranscription,
  runDocumentExtraction,
  runImageToText,
  runVideoTranscription,
} from "./enrich";

/** A minimal in-memory record store for the orchestration tests. */
function fakeStore(seed: MediaRecord): RecordStore & { record: MediaRecord } {
  let record = seed;
  return {
    get record() {
      return record;
    },
    get: async (id) => (id === record.id ? record : null),
    patch: async (_id, changes) => {
      record = { ...record, ...changes };
      return record;
    },
    create: async (r) => r,
    delete: async () => {},
    list: async () => ({ items: [] }),
    findBySha256: async () => [],
    listImagePhashes: async () => [],
  };
}

function baseRecord(overrides: Partial<MediaRecord>): MediaRecord {
  return {
    id: "m1",
    type: "image",
    status: "stored",
    name: "n",
    filename: "a.png",
    contentType: "image/png",
    size: 1,
    storageBackend: "r2",
    storageKey: "media/image/m1",
    sha256: null,
    phash: null,
    width: null,
    height: null,
    altText: null,
    caption: null,
    transcription: null,
    hasTranscription: false,
    extractedText: null,
    hasExtractedText: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as MediaRecord;
}

const ai: MediaAi = {
  run: async (_model, input) => ("audio" in input ? { text: "transcript" } : { description: "alt" }),
  toMarkdown: async () => [{ name: "a.pdf", format: "markdown", data: "extracted" }],
};

function deps(store: RecordStore, over: Partial<EnrichDeps> = {}): EnrichDeps {
  return {
    store,
    ai,
    models: { imageToText: "@cf/vision", transcribe: "@cf/whisper" },
    readBytes: async () => new Uint8Array([1, 2, 3]),
    readDocument: async (record) => ({ name: record.filename, blob: new Blob(["x"]) }),
    fetchVideoAudio: async () => ({
      init: new Uint8Array([0]),
      segments: [
        { bytes: new Uint8Array([1]), durationSec: 20 },
        { bytes: new Uint8Array([2]), durationSec: 20 },
      ],
    }),
    ...over,
  };
}

describe("runImageToText", () => {
  test("writes alt text and caption", async () => {
    const store = fakeStore(baseRecord({ type: "image" }));
    await runImageToText(deps(store), "m1");
    expect(store.record.altText).toBe("alt");
    expect(store.record.caption).toBe("alt");
  });

  test("skips a non-image record", async () => {
    const store = fakeStore(baseRecord({ type: "audio" }));
    await runImageToText(deps(store), "m1");
    expect(store.record.altText).toBeNull();
  });
});

describe("runAudioTranscription", () => {
  test("writes the transcription and sets the flag", async () => {
    const store = fakeStore(baseRecord({ type: "audio" }));
    await runAudioTranscription(deps(store), "m1");
    expect(store.record.transcription).toBe("transcript");
    expect(store.record.hasTranscription).toBe(true);
  });
});

describe("runDocumentExtraction", () => {
  test("writes the extracted text and sets the flag", async () => {
    const store = fakeStore(baseRecord({ type: "document", storageKey: "media/document/m1" }));
    await runDocumentExtraction(deps(store), "m1");
    expect(store.record.extractedText).toBe("extracted");
    expect(store.record.hasExtractedText).toBe(true);
  });
});

describe("runVideoTranscription", () => {
  test("batches, transcribes, and writes the stitched transcription", async () => {
    const store = fakeStore(baseRecord({ type: "video", storageBackend: "cf-stream", storageKey: "uid-1" }));
    await runVideoTranscription(deps(store), "m1");
    expect(store.record.transcription).toContain("transcript");
    expect(store.record.hasTranscription).toBe(true);
  });
});
