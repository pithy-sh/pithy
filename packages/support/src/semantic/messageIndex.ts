// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type FeatureIdentity, featureVectorizeIndexName } from "@pithy-sh/core/src/naming/feature";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { VectorIndexConfig } from "@pithy-sh/vector/src/config/config";
import type { VectorIndexShape } from "@pithy-sh/vector/src/provision/provisionVector";
import { type SupportSearchConfig, supportSemantic } from "../config/config";

/**
 * The semantic message index — what it is called, what shape it has, and what text goes into it.
 *
 * **Support owns it, through `@pithy-sh/vector`'s public modules, and the adopter composes no `vector()`.** The
 * index is declared here as a {@link VectorIndexConfig}, the same value `vector()` builds from an adopter's
 * `indexes` block, so `embedForIndex`, `queryVectors` and the reprocess orchestration take it unchanged and pin
 * the model on writes and queries alike.
 *
 * **Vectors carry ids and nothing else.** A vector's id is the message's id, and no subject, body or address
 * reaches Vectorize metadata: the text stays in D1 under the privacy markers its schema carries. A match is
 * resolved back to its thread in D1, which is also where every filter applies.
 */

/** The index's name in `pithy vector reprocess --index`, and the `<thing>` its Cloudflare name ends with. */
export const SUPPORT_MESSAGES_INDEX = "support-messages";

/** The Vectorize binding the index arrives on, in the app Worker and the classification worker alike. */
export const SUPPORT_VECTORIZE_BINDING = "SUPPORT_VECTORIZE";

/** The Workers AI binding a query and an inbound message are embedded on. */
export const SUPPORT_AI_BINDING = "AI";

/**
 * How much of a message is embedded. A support message states its point early, and the rest is usually a
 * quoted thread and a signature — text that would pull every vector toward the same neighborhood.
 */
export const MAX_EMBED_CHARS = 4000;

/** The index this search config asks for, or `undefined` when `search.semantic` is off. */
export function supportMessageIndex(search: SupportSearchConfig): VectorIndexConfig | undefined {
  const semantic = supportSemantic(search);
  if (!semantic) return undefined;
  return {
    model: semantic.model,
    dimensions: semantic.dimensions,
    // Text embeddings, compared by angle. Fixed at creation.
    metric: "cosine",
    binding: SUPPORT_VECTORIZE_BINDING,
  };
}

/**
 * The shape `pithy support provision` creates the index with — `vector`'s own provisioning shape, so a support
 * index and a `vector()` index are created, and refused on a mismatch, by the same rule. `undefined` when off.
 */
export function supportMessageIndexShape(search: SupportSearchConfig): VectorIndexShape | undefined {
  const index = supportMessageIndex(search);
  return index ? { dimensions: index.dimensions, metric: index.metric } : undefined;
}

/**
 * The index's Cloudflare name — `<project>-<env>-support-messages`, or a feature's own.
 *
 * Through the naming facade, which refuses a Vectorize name over 64 bytes rather than truncating it: a shortened
 * name is a different, empty index.
 */
export function supportMessageIndexName(project: string, env: string, feature?: FeatureIdentity): string {
  if (feature) return featureVectorizeIndexName(feature, SUPPORT_MESSAGES_INDEX);
  return resourceNames(project).env(env).vectorizeIndex(SUPPORT_MESSAGES_INDEX);
}

/** The text one message is embedded as: its subject, then its body, bounded. */
export function embeddingText(subject: string, body: string): string {
  return `${subject}\n\n${body}`.slice(0, MAX_EMBED_CHARS);
}
