// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareKVManager } from "@pithy-sh/cloudflare/src/kv/kvManager";
import type { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { d1SeedGroup, defineSeed } from "@pithy-sh/core/src/seed/seed";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { migrateProject, type WorkerScope } from "../migrations/run";
import { withErrorReporting } from "../terminal/output";
import { dataCapability, seedHarness } from "../test-utils/seedHarness";
import { type StoreProbe, storeProbe } from "../test-utils/storeProbe";
import type { MediaFs, MediaUploader } from "./media";
import { seedProject } from "./run";
import { resetConfirmPhrase } from "./safety";

/**
 * **A seed run names the store it is writing to before it writes (#583).**
 *
 * `pithy seed --env staging` walks every Worker, every set, and every store a set touches, and each write
 * is a REST round trip — a D1 statement, a KV put, a presigned R2 request, a media upload. It spawns
 * nothing, so `ci/narration.test.ts` could not see it, and it wrote its first character when it had
 * finished.
 *
 * The invariant is the one `migrations/narration.test.ts` states, over this run's stores: **every round
 * trip a seed makes to a store is made after a step, and the most recent step names that store** — its
 * binding, or `images`/`stream` for the account-wide media stores.
 *
 * **Reach.** Every round trip through the seams a seed run is handed: `remoteD1`, `remoteKv`, `remoteR2`
 * (its presigned `fetch`, which is where the bytes go) and `mediaUploader`, and through `--redo` the reset
 * `migrations/run.ts` narrates. It does not see a round trip a prepared set makes on its own, or one that
 * reaches Cloudflare without passing through a seam — a new store reached with `cloudflareClients` directly
 * would not be here until its handle is. And a store stays named until a step names another, so a new round
 * trip against the store the last step already named passes: planted as a trailing `PRAGMA optimize` on
 * `DB` after `Seeding things on DB`, it got through. A new round trip against any *other* store, or before
 * the first step, does not — planted as a pre-write read through `driver.d1`, it went red.
 */

const h = seedHarness();

/** The remote ids the staging stanzas name. */
const IDS = { DB: "staging-db", BOARD_DB: "staging-board" } as const;

/** The bucket the R2 fixture lands in, and the host its presigned URLs carry. */
const PRESIGNED = "https://r2.probe.test";

let miniflare: Miniflare;
let remotes: Map<string, D1Database>;

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: IDS.DB, BOARD_DB: IDS.BOARD_DB },
  });
  remotes = new Map([
    [IDS.DB, (await miniflare.getD1Database("DB")) as unknown as D1Database],
    [IDS.BOARD_DB, (await miniflare.getD1Database("BOARD_DB")) as unknown as D1Database],
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await miniflare.dispose();
});

/** The `boards` table on the second Worker's own database. */
const Boards = z
  .object({
    id: z.number().int().describe("Auto-increment primary key."),
    title: z.string().describe("The board's title."),
  })
  .describe("A board, seeded into the second Worker's database.");

/** The second Worker's capability: its own database, its own table, its own fixture. */
function boardCapability(): Capability {
  return defineCapability({
    name: "board",
    requiredBindings: [],
    databases: {
      board: {
        binding: "BOARD_DB",
        tables: { boards: Boards },
        migrations: {
          "0001_boards": {
            up: async (db) => {
              await db.schema
                .createTable("boards")
                .addColumn("id", "integer", (c) => c.primaryKey())
                .addColumn("title", "text", (c) => c.notNull())
                .execute();
            },
            down: async (db) => {
              await db.schema.dropTable("boards").execute();
            },
          },
        },
        migrationOrder: 2000,
      },
    },
    seeds: [
      defineSeed({
        name: "boards",
        order: 2000,
        environments: ["staging"],
        d1: [d1SeedGroup("board", "boards", Boards, [{ id: 1, title: "Roadmap" }])],
      }),
    ],
  });
}

/** Fixtures on the first Worker beyond D1 and KV: an R2 object, and an image whose row lands in `things`. */
function assetsCapability(): Capability {
  return defineCapability({
    name: "assets",
    requiredBindings: [],
    seeds: [
      defineSeed({
        name: "assets",
        order: 3000,
        environments: ["staging"],
        r2: [{ binding: "ASSETS", key: "logo.png", body: "BYTES", contentType: "image/png" }],
        media: [
          {
            store: "images",
            mode: "once",
            file: "/fixtures/logo.png",
            ref: "/fixtures/logo.ref.json",
            record: { database: "app", table: "things", row: { id: 9, name: "logo" } },
          },
        ],
      }),
    ],
  });
}

/** Two Workers, each with a staging stanza naming its remote stores. */
async function project(): Promise<WorkerScope[]> {
  await h.writeWrangler({
    env: {
      staging: {
        d1_databases: [{ binding: "DB", database_id: IDS.DB }],
        kv_namespaces: [{ binding: "CACHE", id: "staging-cache" }],
        r2_buckets: [{ binding: "ASSETS", bucket_name: "staging-assets" }],
      },
    },
  });
  const api = h.api([dataCapability(), assetsCapability()]);
  const board = await h.worker("board", [boardCapability()], {
    env: { staging: { d1_databases: [{ binding: "BOARD_DB", database_id: IDS.BOARD_DB }] } },
  });
  return [api, board];
}

/** A media filesystem with one image and no sidecar. */
const mediaFs: MediaFs = {
  readBytes: async () => new TextEncoder().encode("PNG"),
  readText: async () => null,
  writeTextAtomic: async () => {},
};

/** Every seam a staging seed is handed, each reporting its round trips to `probe`. */
function seams(probe: StoreProbe) {
  const kv = (binding: string) =>
    ({
      get: async () => {
        probe.trip(binding, "get");
        return null;
      },
      set: async () => {
        probe.trip(binding, "set");
      },
    }) as unknown as CloudflareKVManager;
  const r2 = (binding: string) =>
    ({
      createDownloadUrl: async (key: string) => `${PRESIGNED}/${binding}/${key}`,
      createUploadUrl: async (key: string) => `${PRESIGNED}/${binding}/${key}`,
    }) as unknown as CloudflareR2Manager;
  const upload = (store: "images" | "stream") => async (): Promise<{ id: string }> => {
    probe.trip(store, "upload");
    return { id: `${store}-1` };
  };
  const mediaUploader: MediaUploader = { images: upload("images"), stream: upload("stream") };

  // The presigned request is the R2 round trip, so that is where it is recorded. Anything else is not
  // this test's to intercept.
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PRESIGNED)) return real(input, init);
    probe.trip(url.slice(PRESIGNED.length + 1).split("/")[0] as string, init?.method ?? "GET");
    return new Response(null, { status: init?.method === "PUT" ? 200 : 404 });
  });

  return {
    remoteD1: ({ binding, databaseId }: { binding: string; databaseId: string }) =>
      probe.d1(binding, remotes.get(databaseId) as D1Database),
    remoteKv: ({ binding }: { binding: string }) => kv(binding),
    remoteR2: ({ binding }: { binding: string }) => r2(binding),
    mediaUploader,
    mediaFs,
  };
}

/** A confirmed staging seed over both Workers, every store reporting to `probe`. */
async function staging(probe: StoreProbe) {
  const workers = await project();
  const { remoteD1, ...rest } = seams(probe);
  // The schema the seed lands in, created unobserved: the migration's own narration is not this test's.
  await migrateProject({ account: null, projectDir: h.projectDir, project: "acme", env: "staging", workers, remoteD1 });
  return {
    account: null,
    project: "acme",
    projectDir: h.projectDir,
    env: "staging",
    yes: true,
    workers,
    remoteD1,
    ...rest,
  };
}

describe("a seed run names the store it is writing to", () => {
  test("every round trip follows a step naming its store", async () => {
    const probe = storeProbe();
    const options = await staging(probe);
    probe.trips.length = 0;

    await probe.run(() => seedProject(options));

    // Anti-vacuity: every kind of store was reached.
    expect(new Set(probe.trips.map((trip) => trip.store))).toEqual(
      new Set(["DB", "CACHE", "ASSETS", "images", "BOARD_DB"]),
    );
    expect(probe.unnarrated()).toEqual([]);
  });

  test("it says which Worker, which store, and what lands there", async () => {
    const probe = storeProbe();
    const options = await staging(probe);

    await probe.run(() => seedProject(options));

    expect(probe.steps).toEqual([
      "Seeding things on DB for api",
      "Seeding notes on CACHE for api",
      "Seeding logo.png on ASSETS for api",
      "Seeding /fixtures/logo.png on images for api",
      "Seeding things on DB for api",
      "Seeding boards on BOARD_DB for board",
    ]);
  });

  test("--redo narrates the reset ahead of the writes", async () => {
    const probe = storeProbe();
    const options = await staging(probe);
    probe.trips.length = 0;

    await probe.run(() => seedProject({ ...options, redo: true, confirmReset: resetConfirmPhrase("staging") }));

    expect(probe.steps).toContain("Rolling back 1000_app_0001_things on DB");
    expect(probe.unnarrated()).toEqual([]);
  });

  /** #531's rule and #578's: a machine reads exactly one line, so `--json` narrates nothing at all. */
  test("under --json a run writes nothing to stdout", async () => {
    const options = await staging(storeProbe());
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await withErrorReporting(true, async () => {
        await seedProject({ ...options, json: true });
      });
    } finally {
      stdout.mockRestore();
    }

    expect(written).toEqual([]);
  });
});
