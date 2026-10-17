// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AccessCaller } from "@pithy-sh/core/src/access/access";
import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import type { Kysely } from "kysely";
import { MediaConfig, type MediaConfigInput } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import type { DeliverySigner } from "../deliver/sign";
import type { HandlerDeps } from "../http/handlers";
import { media_0001_init } from "../migrations/0001_init";
import { media_0003_ownership } from "../migrations/0003_ownership";
import { d1RecordStore } from "../record/d1Store";
import { d1HashStore } from "../record/hashStore";
import type { MediaStorage, StorageLocation } from "../storage/storage";

/**
 * The shared fixture for media's Workers-runtime handler suites: the migrated tables on a real D1, a fake
 * storage seam that records what it was asked and can be told to fail, a fake signer, and callers acting
 * for organizations with the powers each test names.
 */

/** An acting organization whose role holds exactly the powers named. */
export function acting(organizationId: string, ...powers: string[]): ActingOrganization {
  return { organizationId, roleAllows: (power) => powers.includes(power) };
}

/** A signed-in caller acting for an organization, or for none. */
export function caller(userId: string | null, organizationId: string | null = null, ...powers: string[]): AccessCaller {
  return { userId, acting: organizationId === null ? null : acting(organizationId, ...powers) };
}

/** Drop and recreate the media tables through the authored chain. */
export async function resetMediaTables(d1: D1Database): Promise<void> {
  await d1.exec("DROP TABLE IF EXISTS pithy_media_assets");
  await d1.exec("DROP TABLE IF EXISTS pithy_media_hashes");
  const db = mediaDatabase(d1) as unknown as Kysely<unknown>;
  await media_0001_init.up(db);
  await media_0003_ownership.up(db);
}

/** What the fake storage seam was asked. */
export interface StorageCalls {
  minted: { id: string; signed: boolean }[];
  signing: { storageKey: string; required: boolean }[];
  deleted: string[];
}

/** A fake storage seam. `failSigning` makes the next signing change fail, as Cloudflare refusing would. */
export function fakeStorage(backend: "cf-images" | "cf-stream" | "r2" = "cf-images"): MediaStorage & {
  calls: StorageCalls;
  failSigning: boolean;
} {
  const calls: StorageCalls = { minted: [], signing: [], deleted: [] };
  const storage = {
    calls,
    failSigning: false,
    mintUpload: async (params: { id: string; signed?: boolean; type: string }) => {
      calls.minted.push({ id: params.id, signed: params.signed === true });
      return {
        uploadUrl: `https://upload.example/${params.id}`,
        storageBackend: backend,
        storageKey: backend === "r2" ? `media/${params.type}/${params.id}` : `key-${params.id}`,
      };
    },
    setSigning: async (location: StorageLocation, required: boolean) => {
      if (storage.failSigning) throw new Error("cloudflare refused");
      calls.signing.push({ storageKey: location.storageKey, required });
    },
    deleteObject: async (location: StorageLocation) => {
      calls.deleted.push(location.storageKey);
    },
    readR2Object: async () => new Uint8Array(),
    presignedDownloadUrl: async (location: StorageLocation, expiresIn?: number) =>
      `https://download.example/${location.storageKey}?ttl=${expiresIn ?? 3600}`,
  };
  return storage as MediaStorage & { calls: StorageCalls; failSigning: boolean };
}

/** A signer that marks what it signed, so a test can tell a signed URL from a plain one. */
export const fakeSigner: DeliverySigner = {
  signImageUrl: async (url, expiresAt) => `${url}?exp=${Math.floor(expiresAt.getTime() / 1000)}&sig=signed`,
  streamToken: async (uid) => `token-${uid}`,
};

/** One sequence across every caller's deps, so two callers never mint the same record id. */
let sequence = 0;

/** Handler deps over the real D1, for one caller. */
export function makeDeps(
  d1: D1Database,
  who: AccessCaller,
  overrides: Omit<Partial<HandlerDeps>, "config"> & { config?: MediaConfigInput } = {},
): HandlerDeps & { dispatched: string[] } {
  const schema = extendMediaAsset();
  const dispatched: string[] = [];
  const { config, ...rest } = overrides;
  const deps: HandlerDeps = {
    store: d1RecordStore(mediaDatabase(d1, schema), schema),
    hashes: d1HashStore(d1, () => new Date(1_700_000_000_000)),
    storage: fakeStorage(),
    schema,
    config: MediaConfig.parse({ images: { imageToText: true }, delivery: { imagesAccountHash: "hash" }, ...config }),
    dispatchEnrichment: async (record) => {
      dispatched.push(String(record.id));
    },
    newId: () => `${who.userId ?? "system"}-${++sequence}`,
    now: () => new Date(1_700_000_000_000),
    caller: who,
    env: {},
    signer: async () => fakeSigner,
    ...rest,
  };
  return Object.assign(deps, { dispatched });
}
