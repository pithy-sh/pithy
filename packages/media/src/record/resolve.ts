import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { z } from "zod";
import type { MediaConfig } from "../config/config";
import { mediaDatabase } from "../data/tables";
import { d1RecordStore } from "./d1Store";
import { d1HashStore, type HashStore } from "./hashStore";
import { kvRecordStore } from "./kvStore";
import type { RecordStore } from "./store";

/** The bindings the record store reads from the request env: the app `DB` and the `MEDIA` KV namespace. */
export interface RecordStoreEnv {
  /** The app D1 database the `pithy_media_assets` table lives in (used when `recordStore: 'd1'`). */
  DB: D1Database;
  /** The KV namespace media records live in (used when `recordStore: 'kv'`). */
  MEDIA: KVNamespace;
}

/**
 * Resolve the configured record store from the request env. `recordStore: 'd1'` (default) builds the
 * Kysely-backed D1 store; `recordStore: 'kv'` builds the KV-backed store. Both are bound to the effective
 * schema so extension fields validate and round-trip.
 */
export function resolveRecordStore(env: RecordStoreEnv, config: MediaConfig, schema: z.ZodObject): RecordStore {
  if (config.recordStore === "kv") return kvRecordStore(env.MEDIA, schema, config.kvMetadata);
  return d1RecordStore(mediaDatabase(env.DB, schema), schema);
}

/** Resolve the dedup hash store — always the D1 `DB` binding, whatever the record store. */
export function resolveHashStore(env: RecordStoreEnv, now: () => Date = () => new Date()): HashStore {
  return d1HashStore(env.DB, now);
}
