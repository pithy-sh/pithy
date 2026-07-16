import { z } from "zod";
import { MediaEnrichmentError } from "../error/errors";

/**
 * The Workers AI enrichment calls, over the `env.AI` binding (bindings-first — CLAUDE.md §Cloudflare
 * access). Each is a thin, validated wrapper the enrichment Workflows call: image-to-text (alt text and
 * captions), speech-to-text (audio and video), and document text extraction. The model id is always a
 * parameter, defaulted from config, so an adopter swaps a model with no code change.
 *
 * The binding is typed structurally as {@link MediaAi} rather than depending on the exact `Ai` shape, so
 * a test injects a fake and the code never reaches for a global.
 */

/** The subset of the Workers AI binding this module uses. */
export interface MediaAi {
  /** Run a model by id with an input body; the response shape varies per model, so it is `unknown`. */
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
  /** Convert documents to markdown. Present on the AI binding; optional here so a fake can omit it. */
  toMarkdown?: (files: MarkdownFile[], options?: Record<string, unknown>) => Promise<unknown>;
}

/** A document handed to `toMarkdown`: a name and its bytes as a Blob. */
export interface MarkdownFile {
  /** The filename, including extension — the converter picks its parser from this. */
  name: string;
  /** The document bytes. */
  blob: Blob;
}

/** The default alt-text prompt (concise, ≤ 80 tokens). Ported from the CMS. */
export const DEFAULT_ALT_TEXT_PROMPT = "Describe this image in a concise sentence suitable for alt text.";
/** The default caption prompt (longer, ≤ 512 tokens). Ported from the CMS. */
export const DEFAULT_CAPTION_PROMPT =
  "Generate a concise caption for this image to be used as a description of the image.";

const ALT_TEXT_MAX_TOKENS = 80;
const CAPTION_MAX_TOKENS = 512;

/** Chunk size for base64-encoding audio without blowing the call stack. */
const BASE64_CHUNK = 0x8000;

const ImageToText = z
  .object({ description: z.string().describe("The model's generated description of the image.") })
  .describe("The shape of a Workers AI image-to-text response.");
const Transcription = z
  .object({ text: z.string().describe("The transcribed speech.") })
  .describe("The shape of a Workers AI speech-to-text response.");
const MarkdownResults = z
  .array(
    z
      .object({
        name: z.string().describe("The source document filename."),
        format: z.string().describe("`markdown` on success, `error` on failure."),
        data: z.string().optional().describe("The extracted markdown, when the conversion succeeded."),
        error: z.string().optional().describe("The failure reason, when the conversion failed."),
      })
      .describe("One document's conversion result."),
  )
  .describe("The shape of a Workers AI toMarkdown response — one result per document.");

/** The alt text and caption generated for one image. */
export interface ImageText {
  /** A concise sentence suitable for an `alt` attribute. */
  altText: string;
  /** A longer descriptive caption. */
  caption: string;
}

/** Base64-encode bytes in chunks — whisper's documented `audio` input is a base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** Collapse whitespace/newlines and strip surrounding quotes from a model's text output. */
function cleanText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

/** Run the vision model once for a given prompt and return its cleaned description. */
async function describeImage(
  ai: MediaAi,
  image: Uint8Array,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const raw = await ai.run(model, { image: [...image], prompt, max_tokens: maxTokens });
  const parsed = ImageToText.safeParse(raw);
  if (!parsed.success) {
    throw new MediaEnrichmentError({ detail: `image-to-text model '${model}' returned an unexpected shape` });
  }
  return cleanText(parsed.data.description);
}

/**
 * Generate alt text and a caption for an image with a vision model. Two calls (alt text is short,
 * caption is longer). Returns both; the caller writes them to the record.
 */
export async function generateImageText(ai: MediaAi, image: Uint8Array, model: string): Promise<ImageText> {
  const altText = await describeImage(ai, image, model, DEFAULT_ALT_TEXT_PROMPT, ALT_TEXT_MAX_TOKENS);
  const caption = await describeImage(ai, image, model, DEFAULT_CAPTION_PROMPT, CAPTION_MAX_TOKENS);
  return { altText, caption };
}

/**
 * Transcribe audio bytes with a speech-to-text model. The bytes are base64-encoded per the model's
 * documented `audio` string input. Returns the trimmed transcription text.
 */
export async function transcribeAudioBytes(ai: MediaAi, bytes: Uint8Array, model: string): Promise<string> {
  const raw = await ai.run(model, { audio: bytesToBase64(bytes) });
  const parsed = Transcription.safeParse(raw);
  if (!parsed.success) {
    throw new MediaEnrichmentError({ detail: `transcription model '${model}' returned an unexpected shape` });
  }
  return parsed.data.text.trim();
}

/**
 * Extract text (markdown) from documents via `env.AI.toMarkdown`. Joins every successful conversion,
 * throws on any conversion error, and sanitizes the result to a safe character set (the CMS rule).
 */
export async function extractMarkdown(ai: MediaAi, files: MarkdownFile[]): Promise<string> {
  if (!ai.toMarkdown) {
    throw new MediaEnrichmentError({ detail: "the AI binding does not support toMarkdown" });
  }
  const raw = await ai.toMarkdown(files, { pdf: { metadata: false } });
  const parsed = MarkdownResults.safeParse(raw);
  if (!parsed.success) {
    throw new MediaEnrichmentError({ detail: "toMarkdown returned an unexpected shape" });
  }
  const errors = parsed.data.filter((result) => result.format === "error");
  if (errors.length > 0) {
    throw new MediaEnrichmentError({ detail: `toMarkdown failed: ${errors.map((e) => e.error ?? e.name).join("; ")}` });
  }
  const markdown = parsed.data
    .filter((result) => result.format === "markdown")
    .map((result) => result.data ?? "")
    .join("\n");
  // The CMS sanitization: keep a conservative printable set, drop control/binary noise.
  return markdown.replace(/[^\-a-zA-Z0-9\s,.!?\n]/g, "").trim();
}
