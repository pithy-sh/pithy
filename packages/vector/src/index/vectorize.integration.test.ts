import { CloudflareAIManager } from "@pithy-sh/cloudflare/src/ai/aiManager";
import { CloudflareVectorizeManager } from "@pithy-sh/cloudflare/src/ai/vectorizeManager";
import { CloudflareVectorizeProvisioner } from "@pithy-sh/cloudflare/src/ai/vectorizeProvisioner";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { VectorIndexConfig } from "../config/config";
import { embedForIndex, type VectorAi } from "../embed/embed";
import { assertMetadataIndexes, compareMetadataIndexes, type MetadataIndexSource } from "./drift";
import { compileFilter, filterable, vectorFilter } from "./filter";
import { queryVectors, upsertVectors, type VectorStore } from "./index";
import { MAX_TOPK_WITH_PAYLOAD, MAX_TOPK_WITHOUT_PAYLOAD } from "./limits";
import { metadataIndexes } from "./metadata";

/**
 * LIVE integration test — real Vectorize, real Workers AI.
 *
 * This is the only place the claim this package is built on can be checked. Cloudflare ships no local
 * emulation for either service, so every unit test in `index/` runs against an injected fake: the fakes prove
 * the call shapes and the guards, and they cannot prove Cloudflare behaves the way the docs say. The second
 * test below settles the one sentence the whole design rests on — *"Vectors upserted before a metadata index
 * was created won't have their metadata contained in that index"* — against the real service.
 *
 * **Everything here is asynchronous.** `upsert` returns a mutation id, not a write, and a metadata index takes
 * tens of seconds to become visible. So nothing writes and immediately reads back; every step waits on a
 * bounded poll whose timeout message names the step.
 *
 * The watermark on `describe()` is deliberately **not** that signal, and it is worth saying why. Vectorize
 * advances `processedUpToMutation` through mutation ids the caller never issued — a probe watched it move to
 * an unknown id one second after matching ours — and `vectorCount` still read `0` after a write was
 * demonstrably queryable. Polling for `processedUpToMutation === ours` therefore races: if the watermark steps
 * past our id between two polls, the loop never matches and the suite fails for no reason. It polls the
 * observable outcome instead — the query returning what was written — which is the guarantee a caller depends
 * on anyway.
 *
 * **The metadata-index list is eventually consistent *and not monotonic*.** A 3-minute probe against a live
 * index watched it report `[]` for 26s, then both properties, then — 18s later, with nothing else running —
 * one of the two, then both again for the remaining two minutes. So a single confirming read proves nothing;
 * this suite waits for {@link STABLE_READS} consecutive agreeing reads and then asserts against **that**
 * snapshot rather than issuing a fresh read per assertion, because a fresh read can disagree with the one
 * before it. `compareMetadataIndexes` is pure, which is what makes snapshot-based assertions possible at all.
 *
 * Credentials come from `.dev.vars` through the shared harness (one file at the repo root, symlinked per
 * package — CLAUDE.md §Worktree dev lifecycle), with a `process.env` overlay for CI. No credentials, or no
 * Vectorize on the account, and the suite skips. Run via `bun run test:integration`.
 */

const creds = loadIntegrationCreds();

/**
 * Vectorize and Workers AI need a paid plan. Probing once at collection time — a list call, no writes — means
 * a free-tier CI skips this suite rather than failing every test in it with an authorization error.
 */
const vectorizeReachable = creds.hasCreds
  ? await new CloudflareVectorizeProvisioner({
      accountId: creds.accountId,
      apiToken: creds.apiToken,
    }).validateServiceAccess()
  : false;

/** A small, fast Workers AI embedding model. 384 components, which keeps the payloads and the bill honest. */
const MODEL = "@cf/baai/bge-small-en-v1.5";

/** `bge-small-en-v1.5`'s output width. Asserted against the model's real response rather than trusted. */
const DIMENSIONS = 384;

/** How often a poll re-checks. Vectorize applies changes in tens of seconds, so a tighter loop only burns quota. */
const POLL_INTERVAL_MS = 2_000;

/** Ceiling for a control-plane wait — index and metadata-index visibility. Measured at 25–50s live. */
const CONTROL_PLANE_TIMEOUT_MS = 120_000;

/** Ceiling for a data-plane wait — an upsert becoming queryable. Measured at ~30s live. */
const DATA_PLANE_TIMEOUT_MS = 120_000;

/**
 * Consecutive agreeing reads that count as settled. Three, because the metadata-index list is not monotonic:
 * one confirming read can be a stale replica, and two in a row six seconds apart is a far weaker coincidence.
 */
const STABLE_READS = 3;

/**
 * The metadata an index's vectors carry, with the filterable fields marked — the declaration that drives
 * provisioning, the filter's type, and the drift check. `stage` is deliberately left unmarked: the footgun
 * test indexes it *after* vectors carrying it are already written, which is the mistake this package exists
 * to make impossible.
 */
const DocMeta = z.object({
  tenantId: filterable(z.string().describe("The tenant a document belongs to. Filterable, indexed as a string.")),
  rank: filterable(z.number().describe("The document's ordering rank. Filterable, indexed as a number.")),
  stage: z.string().describe("The pipeline stage. Unmarked on purpose — the footgun test indexes it late."),
});

/** The index config under test: the pinned model, the width it produces, and the metric to compare by. */
const indexConfig = VectorIndexConfig.parse({ model: MODEL, dimensions: DIMENSIONS, metric: "cosine" });

/** Read an element, failing loudly rather than letting `undefined` drift into the assertions below. */
function at<T>(values: readonly T[], position: number): T {
  const value = values[position];
  if (value === undefined) throw new Error(`expected an element at position ${position}, found none`);
  return value;
}

/**
 * Poll until `ready`, or fail with a message naming what was being waited for. A bare timeout tells the next
 * reader nothing; naming the step tells them whether Cloudflare was slow or something is actually broken.
 */
async function waitFor(what: string, ready: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}. Vectorize applies changes asynchronously — this is either a slower-than-usual apply or a real failure.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Poll until `settled` holds on {@link STABLE_READS} consecutive reads, and return the last value read. The
 * caller asserts against the returned snapshot, never against a fresh read — see the note on non-monotonic
 * metadata-index lists at the top of this file.
 */
async function waitForStable<T>(
  what: string,
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let agreed = 0;
  let last = await read();
  for (;;) {
    agreed = settled(last) ? agreed + 1 : 0;
    if (agreed >= STABLE_READS) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} to settle across ${STABLE_READS} reads. Last read: ${JSON.stringify(last)}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await read();
  }
}

/**
 * The Workers AI binding, over REST. The package's seam takes `run(model, input)`, which is exactly what the
 * REST manager offers — so the production embedding code runs unchanged against the real model.
 */
function restVectorAi(manager: CloudflareAIManager): VectorAi {
  return { run: (model, input) => manager.runModel(model, input) };
}

/**
 * The Vectorize binding, over REST. One translation, and only one: the binding takes `returnMetadata` as a
 * boolean, the REST API as `none | indexed | all`. Everything else — the request body, the response, the
 * mutation acknowledgement — reaches the package's own Zod decoders exactly as Cloudflare sent it, because
 * proving those decoders match the real wire is half the reason to run this live.
 */
function restVectorStore(manager: CloudflareVectorizeManager): VectorStore {
  return {
    upsert: (vectors) => manager.upsert(vectors),
    query: (vector, options = {}) =>
      manager.query(vector, {
        topK: typeof options.topK === "number" ? options.topK : undefined,
        returnValues: options.returnValues === true,
        returnMetadata: options.returnMetadata === true ? "all" : "none",
        ...(options.filter ? { filter: options.filter } : {}),
      }),
    deleteByIds: (ids) => manager.deleteByIds(ids),
  };
}

describe.skipIf(!creds.hasCreds || !vectorizeReachable)("@pithy-sh/vector against live Vectorize — LIVE", () => {
  const provisioner = new CloudflareVectorizeProvisioner({ accountId: creds.accountId, apiToken: creds.apiToken });
  const aiManager = new CloudflareAIManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  /** The provisioner is the drift check's source as-is — the same object the CLI hands it. */
  const driftSource: MetadataIndexSource = provisioner;

  test("provisions the index, then every declared metadata index, and reports drift against the live list", async () => {
    const declared = metadataIndexes(DocMeta);
    // Declaration order is the provisioning order. Asserted because the schema is the single source for both.
    expect(declared).toEqual([
      { propertyName: "tenantId", indexType: "string" },
      { propertyName: "rank", indexType: "number" },
    ]);

    const name = uniqueName("pithy-int-vecidx");
    await withThrowawayResource(
      () => provisioner.createIndex(name, { dimensions: DIMENSIONS, metric: indexConfig.metric }),
      async (index) => {
        expect(index.config).toEqual({ dimensions: DIMENSIONS, metric: "cosine" });
        await waitFor(
          `index ${name} to be addressable`,
          async () => (await provisioner.findIndexByName(name)) !== null,
          CONTROL_PLANE_TIMEOUT_MS,
        );

        // The order the package exists to enforce: every metadata index created before the first vector.
        for (const descriptor of declared) {
          await provisioner.createMetadataIndex(name, descriptor.propertyName, descriptor.indexType);
        }

        // The decoded shape, from a settled read. Live Cloudflare answers the list endpoint with
        // `String`/`Number` while the create endpoint takes `string`/`number`; the client normalizes, and this
        // is what proves it still does — a `String` here would sail past every drift check as a mismatch.
        const live = await waitForStable(
          `the ${declared.length} metadata indexes on ${name}`,
          () => provisioner.listMetadataIndexes(name),
          (entries) => entries.length === declared.length,
          CONTROL_PLANE_TIMEOUT_MS,
        );
        expect([...live].sort((a, b) => a.propertyName.localeCompare(b.propertyName))).toEqual([
          { propertyName: "rank", indexType: "number" },
          { propertyName: "tenantId", indexType: "string" },
        ]);

        // Every drift verdict below reads that one snapshot. `compareMetadataIndexes` is pure, so this is the
        // same comparison the CLI runs — without a second live read that could disagree with the first.
        //
        // No drift: everything the schema declares is live, and nothing else is.
        expect(compareMetadataIndexes(declared, live)).toEqual({ missing: [], mismatched: [], extra: [] });

        // Drift: a field marked filterable that provisioning never saw. Fatal, because filters on it return
        // partial results with no error at all.
        expect(
          compareMetadataIndexes([...declared, { propertyName: "stage", indexType: "string" }], live).missing,
        ).toEqual([{ propertyName: "stage", indexType: "string" }]);

        // Drift the other way: a live index the config declares as the wrong type. `rank` is indexed as a
        // number, so declaring it a string is a comparison that would never match anything.
        expect(compareMetadataIndexes([{ propertyName: "rank", indexType: "string" }], live).mismatched).toEqual([
          { propertyName: "rank", declared: "string", live: "number" },
        ]);

        // An undeclared live index is reported, not fatal — it may predate the config, and it still spends
        // one of the ten slots.
        expect(compareMetadataIndexes([at(declared, 0)], live).extra).toEqual([
          { propertyName: "rank", indexType: "number" },
        ]);

        // And the live-reading form, which is what `pithy vector provision` actually calls. A declared field
        // with no metadata index must reject — safe against a stale read, since a staler list can only make
        // the missing set larger.
        await expect(
          assertMetadataIndexes(driftSource, name, [...declared, { propertyName: "stage", indexType: "string" }]),
        ).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "vector/metadata_index_drift" }) }),
        );
      },
      (index) => provisioner.deleteIndex(index.name),
    );

    // Teardown landed: the index is gone from the account.
    expect(await provisioner.findIndexByName(name)).toBeNull();
  });

  test("embeds, upserts, filters — and a metadata index created late covers none of the vectors before it", async () => {
    const name = uniqueName("pithy-int-vecdat");
    await withThrowawayResource(
      () => provisioner.createIndex(name, { dimensions: DIMENSIONS, metric: indexConfig.metric }),
      async (index) => {
        const rawStore = new CloudflareVectorizeManager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          indexName: index.name,
        });
        const store = restVectorStore(rawStore);
        const ai = restVectorAi(aiManager);
        await waitFor(
          `index ${name} to be addressable`,
          async () => (await provisioner.findIndexByName(name)) !== null,
          CONTROL_PLANE_TIMEOUT_MS,
        );

        // Provision the declared metadata indexes first, before a single vector exists. `stage` is not among
        // them — that is the footgun, set up further down.
        const declared = metadataIndexes(DocMeta);
        for (const descriptor of declared) {
          await provisioner.createMetadataIndex(name, descriptor.propertyName, descriptor.indexType);
        }
        await waitForStable(
          `the metadata indexes on ${name}`,
          () => provisioner.listMetadataIndexes(name),
          (entries) => entries.length === declared.length,
          CONTROL_PLANE_TIMEOUT_MS,
        );

        // One model serves writes and queries. That is the point of pinning it per index: an index built with
        // one model and queried with another returns plausible neighbours from a space the query vector does
        // not live in, and nothing errors.
        const texts = ["a bright red apple", "a ripe yellow banana", "a diesel locomotive"];
        const embeddings = await embedForIndex(ai, indexConfig, texts);
        expect(embeddings).toHaveLength(texts.length);
        for (const embedding of embeddings) expect(embedding).toHaveLength(indexConfig.dimensions);
        const probe = at(embeddings, 0);

        // Vectors written while `stage` has no metadata index. Every one carries a `stage` value anyway,
        // which is exactly how the mistake happens in a real project.
        const mutationId = await upsertVectors(store, indexConfig, [
          { id: "apple", values: probe, metadata: { tenantId: "acme", rank: 1, stage: "early" } },
          { id: "banana", values: at(embeddings, 1), metadata: { tenantId: "globex", rank: 2, stage: "early" } },
          { id: "train", values: at(embeddings, 2), metadata: { tenantId: "acme", rank: 3, stage: "late" } },
        ]);
        // The decoded acknowledgement: a mutation id, not a completed write.
        expect(mutationId).toMatch(/^[0-9a-f-]{36}$/);

        // Queries flap the same way the metadata-index list does — a run watched a settled 3-match corpus
        // read back as 0 one call later. So every live read below settles first, and the assertions run
        // against the settled snapshot. The predicate is only ever a liveness signal (the writes have
        // landed); *which* vectors came back stays a real assertion underneath it.
        const nearest = await waitForStable(
          "the first upsert to be queryable",
          () => queryVectors(store, indexConfig, probe, { topK: 3, returnMetadata: true }),
          (result) => result.count === 3,
          DATA_PLANE_TIMEOUT_MS,
        );

        // The decoded query response, from the real wire: a count, and matches nearest first.
        expect(at(nearest.matches, 0).id).toBe("apple");
        expect(at(nearest.matches, 0).score).toBeGreaterThan(at(nearest.matches, 2).score);
        expect(at(nearest.matches, 0).metadata).toEqual({ tenantId: "acme", rank: 1, stage: "early" });
        // Metadata was requested, values were not — so Vectorize omits the components entirely.
        expect(at(nearest.matches, 0).values).toBeUndefined();

        // A typed filter over live data: only the matching subset comes back.
        const acme = await waitForStable(
          "the tenantId filter",
          () =>
            queryVectors(store, indexConfig, probe, { topK: 10, filter: vectorFilter(DocMeta, { tenantId: "acme" }) }),
          (result) => result.count === 2,
          DATA_PLANE_TIMEOUT_MS,
        );
        expect(acme.matches.map((match) => match.id).sort()).toEqual(["apple", "train"]);

        // A numeric range over the number-typed index, to prove the type survived the round trip.
        const highRank = await waitForStable(
          "the rank range filter",
          () =>
            queryVectors(store, indexConfig, probe, {
              topK: 10,
              filter: vectorFilter(DocMeta, { rank: { $gte: 2 } }),
            }),
          (result) => result.count === 2,
          DATA_PLANE_TIMEOUT_MS,
        );
        expect(highRank.matches.map((match) => match.id).sort()).toEqual(["banana", "train"]);

        // ── The footgun, demonstrated. ────────────────────────────────────────────────────────────────────
        // Index `stage` now, after `apple` and `banana` were written carrying `stage: "early"`.
        await provisioner.createMetadataIndex(name, "stage", "string");
        await waitForStable(
          `the late \`stage\` metadata index on ${name}`,
          () => provisioner.listMetadataIndexes(name),
          (entries) => entries.some((entry) => entry.propertyName === "stage"),
          CONTROL_PLANE_TIMEOUT_MS,
        );

        // One more vector, written after the index exists, carrying the same `stage: "early"` value.
        const lateEmbedding = at(await embedForIndex(ai, indexConfig, ["a green cooking apple"]), 0);
        await upsertVectors(store, indexConfig, [
          { id: "apple-late", values: lateEmbedding, metadata: { tenantId: "acme", rank: 4, stage: "early" } },
        ]);
        const whole = await waitForStable(
          "the late upsert to be queryable",
          () => queryVectors(store, indexConfig, probe, { topK: 10 }),
          (result) => result.count === 4,
          DATA_PLANE_TIMEOUT_MS,
        );
        expect(whole.matches.map((match) => match.id).sort()).toEqual(["apple", "apple-late", "banana", "train"]);

        // Three of those four carry `stage: "early"`. The settle predicate asks only that *something* comes
        // back, so if Vectorize did index the earlier vectors this assertion fails loudly with all three ids
        // rather than quietly timing out.
        const early = await waitForStable(
          "the late `stage` filter",
          () =>
            queryVectors(store, indexConfig, probe, {
              topK: 10,
              filter: compileFilter([{ propertyName: "stage", indexType: "string" }], { stage: "early" }),
            }),
          (result) => result.count >= 1,
          DATA_PLANE_TIMEOUT_MS,
        );
        // Only the vector written after the metadata index existed matches. No error, no warning — the filter
        // simply returns less than the corpus holds. This is the behaviour the whole package is built around,
        // confirmed against the real service.
        expect(early.matches.map((match) => match.id)).toEqual(["apple-late"]);
        expect(early.count).toBe(1);

        // ── The real topK ceilings. ───────────────────────────────────────────────────────────────────────
        // The package refuses these before the call. The point of asserting it live is that Vectorize refuses
        // them too, at the same numbers — a guard stricter or looser than the service either blocks legal
        // queries or lets the service's opaque rejection through.
        await expect(rawStore.query(probe, { topK: MAX_TOPK_WITHOUT_PAYLOAD + 1 })).rejects.toThrowError(
          expect.objectContaining({
            payload: expect.objectContaining({
              code: "cloudflare/request_failed",
              detail: expect.stringContaining(`max top K is ${MAX_TOPK_WITHOUT_PAYLOAD}`),
            }),
          }),
        );
        await expect(
          rawStore.query(probe, { topK: MAX_TOPK_WITH_PAYLOAD + 1, returnMetadata: "all" }),
        ).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
        );
        // And the guards that keep those from ever reaching the wire.
        await expect(
          queryVectors(store, indexConfig, probe, { topK: MAX_TOPK_WITHOUT_PAYLOAD + 1 }),
        ).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "vector/topk_exceeded" }) }),
        );
        await expect(
          queryVectors(store, indexConfig, probe, { topK: MAX_TOPK_WITH_PAYLOAD + 1, returnMetadata: true }),
        ).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "vector/topk_exceeded" }) }),
        );

        // The absent path: a vector of the wrong width never reaches Cloudflare.
        await expect(queryVectors(store, indexConfig, [0.1, 0.2])).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "vector/dimension_mismatch" }) }),
        );
      },
      (index) => provisioner.deleteIndex(index.name),
    );

    expect(await provisioner.findIndexByName(name)).toBeNull();
  });
});
