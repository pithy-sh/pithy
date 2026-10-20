// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PrivacyField } from "./classify";

/**
 * **The inventory's shape, apart from the walk that fills it** (#132).
 *
 * Its own module so a browser may import it. The manifest's response schema names {@link PRIVACY_SOURCES}, and
 * every capability's scope declarations reach that schema; the walk in `./inventory` takes a `Capability`, which
 * reaches Hono, Kysely and the Workers types. A type-only edge is still an edge to the compiler a browser build
 * uses, so the shape lives here and the walk imports it, never the other way.
 */

/** The storage the inventory walks, in the order it reports them. */
export const PRIVACY_SOURCES = ["d1", "kv"] as const;

/** One storage kind the inventory walks. */
export type PrivacySource = (typeof PRIVACY_SOURCES)[number];

/** One schema holding at least one marked field. */
export interface PrivacyInventorySchema {
  /** The capability that declared it. */
  capability: string;
  /** Where it is stored. */
  storage: PrivacySource;
  /** The D1 database name or the KV namespace name it lives in. */
  container: string;
  /** The table name or the KV store name. */
  name: string;
  /** Every marked field in it, with its class. */
  fields: PrivacyField[];
}

/** Everything one Worker's storage schemas say about privacy. */
export interface PrivacyInventory {
  /** The storage kinds walked. Anything not listed was not. */
  sources: PrivacySource[];
  /** How many schemas were walked, marked or not. */
  schemasWalked: number;
  /** Every schema that holds a marked field, in composition order. */
  schemas: PrivacyInventorySchema[];
  /** Marked fields per class. A class with none is absent rather than zero. */
  counts: Record<string, number>;
  /** Every class with at least one marked field: the built-ins in their fixed order, then the rest by name. */
  observed: string[];
}
