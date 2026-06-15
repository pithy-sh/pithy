import type { AIRunParams, AIRunResponse } from "cloudflare/resources/ai/ai";
import type { ModelListResponse } from "cloudflare/resources/ai/models/models";
import { fromUint8Array } from "js-base64";
import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * The default text-generation model. A generic, well-supported instruct model — callers can
 * override per call via `runModel`. Not Leed-specific.
 */
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * The default text-embedding model. `bge-m3` returns a `{ shape, data }` payload matching
 * `VectorEmbeddings`. Override per call via `runModel` for a different embedding model.
 */
const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

/** The default image-to-text (vision) model used by `analyzeImage`. */
const DEFAULT_IMAGE_TO_TEXT_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

/**
 * The embeddings payload Cloudflare's text-embedding models return: a `shape` describing the
 * `[count, dimensions]` of the result and a `data` array of one vector per input. Generic — this
 * is the raw CF shape, carrying no application meaning, so callers can store or query it directly.
 */
export const VectorEmbeddings = z
  .object({
    shape: z.array(z.number()).describe("The result shape as [count, dimensions]."),
    data: z.array(z.array(z.number())).describe("One embedding vector per input text."),
  })
  .describe("A Cloudflare text-embedding result: vector shape plus one embedding per input.");
export type VectorEmbeddings = z.infer<typeof VectorEmbeddings>;

/**
 * The text-generation payload Cloudflare's instruct models return over the REST API: the generated
 * text plus optional usage. Generic — no application-specific post-processing.
 */
export const TextGeneration = z
  .object({
    response: z.string().describe("The generated text."),
  })
  .describe("A Cloudflare text-generation result: the model's generated text.");
export type TextGeneration = z.infer<typeof TextGeneration>;

/**
 * The image-to-text payload Cloudflare's vision models return: a textual description of the image.
 */
export const ImageToText = z
  .object({
    description: z.string().describe("The model's textual description of the image."),
  })
  .describe("A Cloudflare image-to-text result: a description of the supplied image.");
export type ImageToText = z.infer<typeof ImageToText>;

/** Options for `generateText`. */
export interface GenerateTextOptions {
  /** The model to run. Defaults to a generic instruct model. */
  model?: string;
  /** Upper bound on generated tokens. Omit for the model default. */
  maxTokens?: number;
}

/** A single chat message passed to a text-generation model. */
export interface ChatMessage {
  /** The role of the speaker. */
  role: "system" | "user" | "assistant";
  /** The message content. */
  content: string;
}

/** Options for `analyzeImage`. */
export interface AnalyzeImageOptions {
  /** The model to run. Defaults to a generic vision model. */
  model?: string;
  /** The instruction guiding the description. Defaults to a generic alt-text prompt. */
  prompt?: string;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
}

const DEFAULT_IMAGE_PROMPT = "Describe this image in a concise sentence suitable for alt text.";

/**
 * Out-of-Worker Workers AI access over the REST API: run any model, generate text, generate
 * embeddings, analyze an image, and list models from a CLI/CI/provisioning context. Inside a
 * Worker you use the `Ai` binding directly — this manager is the REST counterpart, addressed by
 * account id. Every model call carries no application logic; the caller chooses the model and
 * interprets the result.
 */
export class CloudflareAIManager extends CloudflareManager {
  /**
   * Run a Cloudflare AI model by name with an arbitrary JSON input. The single seam every typed
   * helper builds on. The account id is injected for you; the rest of `input` is the model's body.
   */
  async runModel(model: string, input: Record<string, unknown>): Promise<AIRunResponse> {
    return cloudflareRequest(`AI run model '${model}'`, () =>
      this.getClient().ai.run(model, { account_id: this.accountId, ...input } as AIRunParams),
    );
  }

  /**
   * Generate text from a chat prompt. Returns the validated `{ response }` payload. A response that
   * does not carry a string `response` field fails Zod and throws `cloudflare/invalid_response`.
   */
  async generateText(messages: ChatMessage[], options?: GenerateTextOptions): Promise<TextGeneration> {
    const model = options?.model ?? DEFAULT_TEXT_MODEL;
    const raw = await this.runModel(model, {
      messages,
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    });
    const parsed = TextGeneration.safeParse(raw);
    if (!parsed.success) {
      throw new CloudflareInvalidResponseError({
        message: "The AI text-generation response had an unexpected shape.",
        detail: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * Generate embeddings for one or more texts. Returns the validated `{ shape, data }` payload. A
   * response that does not match fails Zod and throws `cloudflare/invalid_response`.
   */
  async generateEmbeddings(texts: string | string[], model?: string): Promise<VectorEmbeddings> {
    const raw = await this.runModel(model ?? DEFAULT_EMBEDDING_MODEL, { text: texts });
    const parsed = VectorEmbeddings.safeParse(raw);
    if (!parsed.success) {
      throw new CloudflareInvalidResponseError({
        message: "The AI embeddings response had an unexpected shape.",
        detail: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * Describe an image with a vision model. The image is raw bytes, base64-encoded for the model
   * input. Returns the validated `{ description }` payload.
   */
  async analyzeImage(image: Uint8Array, options?: AnalyzeImageOptions): Promise<ImageToText> {
    const model = options?.model ?? DEFAULT_IMAGE_TO_TEXT_MODEL;
    const raw = await this.runModel(model, {
      image: fromUint8Array(image),
      prompt: options?.prompt ?? DEFAULT_IMAGE_PROMPT,
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    });
    const parsed = ImageToText.safeParse(raw);
    if (!parsed.success) {
      throw new CloudflareInvalidResponseError({
        message: "The AI image-to-text response had an unexpected shape.",
        detail: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /** List the AI models available to this account. Returns an empty array when none are present. */
  async listModels(): Promise<ModelListResponse[]> {
    return cloudflareRequest("AI list models", async () => {
      const page = await this.getClient().ai.models.list({ account_id: this.accountId });
      return Array.isArray(page.result) ? page.result : [];
    });
  }

  getServiceType(): string {
    return "Workers AI";
  }

  /** Prove access by listing models. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }
}
