import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VectorConfig } from "../config/config";
import type { MetadataIndexReport } from "../index/drift";
import { filterable } from "../index/filter";
import type { MetadataIndexDescriptor } from "../index/metadata";
import {
  provisionVector,
  resetVector,
  toProvisionRecord,
  type VectorProvisioner,
  vectorIndexName,
} from "./provisionVector";

/**
 * Provisioning is orchestration, so it is tested as orchestration: what was called, in what order, and what
 * a re-run does. The ordering assertion is the point — an index, then its metadata indexes, then the worker
 * that can write to it. A vector written between the first two steps is permanently unfilterable, with no
 * error anywhere.
 */

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({
  indexes: {
    docs: { model: "current-model", dimensions: 768, metadata },
    notes: { model: "other-model", dimensions: 384, binding: "VECTORIZE_NOTES" },
  },
});

const empty: MetadataIndexReport = { missing: [], mismatched: [], extra: [] };

function fakeProvisioner(overrides: Partial<VectorProvisioner> = {}): VectorProvisioner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async preflight() {
      calls.push("preflight");
    },
    async ensureIndex(indexName) {
      calls.push(`index:${indexName}`);
      return { name: indexName };
    },
    async ensureMetadataIndexes(indexName, declared: readonly MetadataIndexDescriptor[]) {
      calls.push(`metadata:${indexName}:${declared.map((d) => d.propertyName).join(",") || "none"}`);
      return { ...empty, missing: [...declared] };
    },
    async deployWorker(env, indexNames) {
      calls.push(`worker:${env}:${Object.values(indexNames).join(",")}`);
    },
    async deleteIndex(indexName) {
      calls.push(`delete:${indexName}`);
    },
    async reprocess(env, index, options) {
      calls.push(`reprocess:${env}:${index}:${options.all ? "all" : "stale"}`);
      return {};
    },
    ...overrides,
  };
}

describe("vectorIndexName", () => {
  it("names an index per environment, so staging and production never share vectors", () => {
    expect(vectorIndexName("docs", "staging")).toBe("pithy-vector-docs-staging");
  });

  it("refuses a derived name Vectorize would reject, even though the config name alone fits", () => {
    expect(() => vectorIndexName("d".repeat(60), "production")).toThrow(/longer than Vectorize allows/);
  });
});

describe("provisionVector", () => {
  it("creates each index, then its metadata indexes, and only then deploys the worker", async () => {
    const provisioner = fakeProvisioner();
    await provisionVector(provisioner, { config, env: "staging" });

    expect(provisioner.calls).toEqual([
      "preflight",
      "index:pithy-vector-docs-staging",
      "metadata:pithy-vector-docs-staging:ownerId",
      "index:pithy-vector-notes-staging",
      "metadata:pithy-vector-notes-staging:none",
      "worker:staging:pithy-vector-docs-staging,pithy-vector-notes-staging",
    ]);
  });

  it("reports what each index was provisioned as and what it created", async () => {
    const result = await provisionVector(fakeProvisioner(), { config, env: "dev" });
    expect(result.env).toBe("dev");
    expect(result.indexes.map((entry) => entry.indexName)).toEqual(["pithy-vector-docs-dev", "pithy-vector-notes-dev"]);
    expect(result.indexes[0]?.created).toEqual([{ propertyName: "ownerId", indexType: "string" }]);
  });

  it("is idempotent — a re-run that finds everything present creates nothing", async () => {
    const provisioner = fakeProvisioner({ ensureMetadataIndexes: async () => empty });
    const result = await provisionVector(provisioner, { config, env: "staging" });
    expect(result.indexes.every((entry) => entry.created.length === 0)).toBe(true);
  });

  it("surfaces a live metadata index the config does not declare — it still spends one of the ten slots", async () => {
    const provisioner = fakeProvisioner({
      ensureMetadataIndexes: async () => ({ ...empty, extra: [{ propertyName: "legacy", indexType: "string" }] }),
    });
    const result = await provisionVector(provisioner, { config, env: "staging" });
    expect(result.indexes[0]?.extra).toEqual([{ propertyName: "legacy", indexType: "string" }]);
  });
});

describe("toProvisionRecord", () => {
  it("records every declared index as observed — ensureMetadataIndexes returned, so each one is live", async () => {
    const result = await provisionVector(fakeProvisioner(), { config, env: "staging" });
    expect(toProvisionRecord(result)).toEqual({
      indexes: {
        docs: {
          indexName: "pithy-vector-docs-staging",
          metadataIndexes: [{ propertyName: "ownerId", indexType: "string" }],
        },
        notes: { indexName: "pithy-vector-notes-staging", metadataIndexes: [] },
      },
    });
  });

  it("carries an undeclared live index into the record, so boot can see it without calling Cloudflare", async () => {
    const provisioner = fakeProvisioner({
      ensureMetadataIndexes: async () => ({ ...empty, extra: [{ propertyName: "legacy", indexType: "string" }] }),
    });
    const record = toProvisionRecord(await provisionVector(provisioner, { config, env: "staging" }));
    expect(record.indexes.docs?.metadataIndexes).toEqual([
      { propertyName: "ownerId", indexType: "string" },
      { propertyName: "legacy", indexType: "string" },
    ]);
  });
});

describe("resetVector", () => {
  it("deletes, rebuilds in the provisioning order, and re-embeds the whole corpus", async () => {
    const provisioner = fakeProvisioner();
    const result = await resetVector(provisioner, { config, env: "staging" });

    expect(provisioner.calls).toEqual([
      "preflight",
      "delete:pithy-vector-docs-staging",
      "delete:pithy-vector-notes-staging",
      "preflight",
      "index:pithy-vector-docs-staging",
      "metadata:pithy-vector-docs-staging:ownerId",
      "index:pithy-vector-notes-staging",
      "metadata:pithy-vector-notes-staging:none",
      "worker:staging:pithy-vector-docs-staging,pithy-vector-notes-staging",
      // `all`, not the stale-model pass: the rebuilt index holds nothing at all.
      "reprocess:staging:docs:all",
      "reprocess:staging:notes:all",
    ]);
    expect(result.deleted).toEqual(["pithy-vector-docs-staging", "pithy-vector-notes-staging"]);
    expect(result.reprocessed).toEqual(["docs", "notes"]);
  });

  it("fails before deleting anything when the account is not ready", async () => {
    const provisioner = fakeProvisioner({
      preflight: async () => {
        throw new Error("no workers.dev subdomain");
      },
    });
    await expect(resetVector(provisioner, { config, env: "staging" })).rejects.toThrow("no workers.dev subdomain");
    expect(provisioner.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  });
});
