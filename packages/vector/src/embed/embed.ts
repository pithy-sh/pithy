// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { VectorIndexConfig } from "../config/config";
import { VectorDimensionMismatchError } from "../error/errors";

/**
 * The Workers AI embedding call, over the `env.AI` binding (bindings-first — CLAUDE.md §Cloudflare access).
 *
 * The binding is typed structurally as {@link VectorAi} rather than depending on the exact `Ai` shape, so a
 * test injects a fake and the code never reaches for a global. As with the index seam, this is the only way
 * to test any of it: Cloudflare ships no local emulation for Workers AI. The seam is the first parameter and
 * the model id trails, matching `@pithy-sh/media`'s enrichment calls.
 *
 * `@pithy-sh/cloudflare`'s `aiManager` is deliberately not used. It is the REST client — it needs an API
 * token and an account id, which a Worker has neither of, and should not.
 *
 * {@link embedForIndex} is the call production code makes. It pins the model to the index's declared one for
 * writes *and* queries, which removes the failure people actually hit: an index built with one model, queried
 * with another. Nothing errors. The neighbours just come back from a space the query vector does not live in.
 */

/** The subset of the Workers AI binding this module uses. */
export interface VectorAi {
  /** Run a model by id with an input body; the response shape varies per model, so it is `unknown`. */
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const EmbeddingResponse = z
  .object({
    shape: z
      .array(z.number())
      .optional()
      .describe("The response's dimensions as [count, size], when the model reports them."),
    data: z.array(z.array(z.number())).describe("One embedding per input text, in the order the texts were given."),
  })
  .describe("The shape of a Workers AI text-embedding response.");

/**
 * Embed texts with a named model. Returns one vector per text, in order. The model is a parameter with no
 * default: an embedding whose model is implicit is an embedding nobody can reproduce.
 */
export async function embedTexts(ai: VectorAi, texts: string[], model: string): Promise<number[][]> {
  if (texts.length === 0) {
    throw new ValidationError({
      message: "Nothing to embed.",
      action: "Pass at least one piece of text.",
      detail: "embedTexts received an empty batch",
    });
  }

  const raw = await ai.run(model, { text: texts });
  const parsed = EmbeddingResponse.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError({
      message: "The embedding model returned something unexpected.",
      detail: `embedding model '${model}' returned an unexpected shape`,
    });
  }
  if (parsed.data.data.length !== texts.length) {
    throw new InternalError({
      message: "The embedding model returned the wrong number of vectors.",
      detail: `embedding model '${model}' returned ${parsed.data.data.length} vectors for ${texts.length} texts`,
    });
  }
  return parsed.data.data;
}

/**
 * Embed texts for one index, with that index's pinned model, and prove the result fits the index. A model
 * swapped in config without re-creating the index fails here, on the first write or query, naming both — far
 * cheaper than a corpus embedded half in one space and half in another.
 */
export async function embedForIndex(ai: VectorAi, index: VectorIndexConfig, texts: string[]): Promise<number[][]> {
  const vectors = await embedTexts(ai, texts, index.model);
  for (const [position, vector] of vectors.entries()) {
    if (vector.length !== index.dimensions) {
      throw new VectorDimensionMismatchError({
        detail: `model '${index.model}' produced ${vector.length} components at position ${position}; the index expects ${index.dimensions}`,
      });
    }
  }
  return vectors;
}

/**
 * Texts sent to Workers AI in one call.
 *
 * Not a published Vectorize limit — a deliberate chunk size. A model's per-request text cap varies by model,
 * and one call carrying a thousand documents is a large, slow, all-or-nothing request: a single timeout
 * discards every embedding in it. Chunking costs a few more round trips and makes a failure lose a hundred
 * documents instead of a thousand.
 */
export const EMBED_CHUNK = 100;

/**
 * Embed a batch of any size for one index, in {@link EMBED_CHUNK}-sized calls, preserving order. The form
 * every caller writing more than a handful of documents should use — a route handling a full batch, and every
 * page of a reprocess run.
 */
export async function embedBatched(ai: VectorAi, index: VectorIndexConfig, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_CHUNK) {
    const chunk = texts.slice(start, start + EMBED_CHUNK);
    for (const vector of await embedForIndex(ai, index, chunk)) vectors.push(vector);
  }
  return vectors;
}
