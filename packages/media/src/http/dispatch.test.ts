import { describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import type { MediaRecord } from "../record/store";
import { type EnrichmentBindings, type EnrichmentWorkflowBinding, makeEnrichmentDispatcher } from "./dispatch";

/** A fake Workflow binding recording the ids it was started for. */
function recorder(): EnrichmentWorkflowBinding & { ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    create: async ({ params }) => {
      ids.push(params.id);
    },
  };
}

const EXT: Record<MediaRecord["type"], string> = { image: "png", audio: "mp3", video: "mp4", document: "pdf" };

function record(type: MediaRecord["type"], filename = `${type}-1.${EXT[type]}`): MediaRecord {
  return { id: `${type}-1`, type, filename } as MediaRecord;
}

function bindings() {
  return {
    MEDIA_IMAGE_TO_TEXT: recorder(),
    MEDIA_AUDIO_TRANSCRIBE: recorder(),
    MEDIA_VIDEO_TRANSCRIBE: recorder(),
    MEDIA_DOC_EXTRACT: recorder(),
  } satisfies EnrichmentBindings;
}

describe("makeEnrichmentDispatcher", () => {
  test("dispatches only the matching binding when the feature is enabled", async () => {
    const env = bindings();
    const config = MediaConfig.parse({
      images: { imageToText: true },
      audio: { transcribe: true },
      video: { transcribe: true },
      documents: { extractText: true },
    });
    const dispatch = makeEnrichmentDispatcher(env, config);
    await dispatch(record("image"));
    await dispatch(record("audio"));
    await dispatch(record("video"));
    await dispatch(record("document"));
    expect(env.MEDIA_IMAGE_TO_TEXT.ids).toEqual(["image-1"]);
    expect(env.MEDIA_AUDIO_TRANSCRIBE.ids).toEqual(["audio-1"]);
    expect(env.MEDIA_VIDEO_TRANSCRIBE.ids).toEqual(["video-1"]);
    expect(env.MEDIA_DOC_EXTRACT.ids).toEqual(["document-1"]);
  });

  test("is a no-op when the feature is disabled (no dispatch, no cost)", async () => {
    const env = bindings();
    const dispatch = makeEnrichmentDispatcher(env, MediaConfig.parse({}));
    await dispatch(record("image"));
    await dispatch(record("audio"));
    expect(env.MEDIA_IMAGE_TO_TEXT.ids).toEqual([]);
    expect(env.MEDIA_AUDIO_TRANSCRIBE.ids).toEqual([]);
  });

  test("does not dispatch extraction for an unsupported document extension", async () => {
    const env = bindings();
    const dispatch = makeEnrichmentDispatcher(env, MediaConfig.parse({ documents: { extractText: true } }));
    await dispatch(record("document", "notes.txt")); // .txt is not extractable
    expect(env.MEDIA_DOC_EXTRACT.ids).toEqual([]);
    // A pdf/doc/docx is dispatched.
    await dispatch(record("document", "report.docx"));
    expect(env.MEDIA_DOC_EXTRACT.ids).toEqual(["document-1"]);
  });

  test("is a no-op when the feature is enabled but the binding is absent", async () => {
    const config = MediaConfig.parse({ images: { imageToText: true } });
    // No bindings at all — the optional chain makes this a safe no-op.
    const dispatch = makeEnrichmentDispatcher({}, config);
    await expect(dispatch(record("image"))).resolves.toBeUndefined();
  });
});
