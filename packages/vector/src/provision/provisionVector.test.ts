// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VectorConfig } from "../config/config";
import type { MetadataIndexReport } from "../index/drift";
import { filterable } from "../index/filter";
import type { MetadataIndexDescriptor } from "../index/metadata";
import { VECTOR_CAPABILITY } from "../workflows/specs";
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

/** The project every name in this suite leads with — the root `pithy.config.ts` `name`. */
const project = "acme";

/** Run something expected to throw a `PithyError` and hand back its payload for inspection. */
function catchError(run: () => unknown): PithyError {
  try {
    run();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a PithyError, and nothing was thrown");
}

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
  /** `acme-prod-vector-` — everything a `prod` index name spends before the configured key. */
  const head = `${project}-prod-${VECTOR_CAPABILITY}-`.length;
  /** The longest configured key that still fits inside Vectorize's own budget, not a generic one. */
  const room = NAMESPACE_LIMITS.vectorizeIndex.maxLength - head;

  it("names an index per environment, so staging and prod never share vectors", () => {
    expect(vectorIndexName(project, "docs", "staging")).toBe("acme-staging-vector-docs");
    expect(vectorIndexName(project, "docs", "prod")).toBe("acme-prod-vector-docs");
  });

  it("names an index per project, so a second project's provision cannot adopt this corpus", () => {
    expect(vectorIndexName("globex", "docs", "staging")).toBe("globex-staging-vector-docs");
    expect(vectorIndexName("acme", "docs", "staging")).not.toBe(vectorIndexName("globex", "docs", "staging"));
  });

  it("spends Vectorize's own 64, not the 63 every namespace used to be held to", () => {
    const key = "d".repeat(room);
    expect(vectorIndexName(project, key, "prod")).toBe(`acme-prod-vector-${key}`);
    expect(vectorIndexName(project, key, "prod")).toHaveLength(NAMESPACE_LIMITS.vectorizeIndex.maxLength);
  });

  it("refuses one character past it, and says which configured index has to shorten", () => {
    const key = "d".repeat(room + 1);
    const error = catchError(() => vectorIndexName(project, key, "prod"));
    // A ValidationError, not the facade's InternalError: the segment that overflowed came out of the
    // adopter's pithy.config.ts, so this is a 400 they can act on rather than a fault in the toolkit.
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.payload.message).toContain(key);
    expect(error.payload.action).toContain("pithy.config.ts");
  });

  it("never truncates instead — a shortened index is an empty index teardown cannot find", () => {
    expect(() => vectorIndexName(project, "d".repeat(room + 1), "prod")).toThrow(PithyError);
  });

  it("refuses a project name no Cloudflare namespace could carry, before any index is named", () => {
    expect(() => vectorIndexName("p".repeat(60), "docs", "prod")).toThrow(/project name stops at/);
  });

  it("refuses `production` — the environment is `prod`, and one environment may not have two spellings", () => {
    const error = catchError(() => vectorIndexName(project, "docs", "production"));
    expect(error.payload.action).toContain("prod");
  });
});

describe("provisionVector", () => {
  it("creates each index, then its metadata indexes, and only then deploys the worker", async () => {
    const provisioner = fakeProvisioner();
    await provisionVector(provisioner, { project, config, env: "staging" });

    expect(provisioner.calls).toEqual([
      "preflight",
      "index:acme-staging-vector-docs",
      "metadata:acme-staging-vector-docs:ownerId",
      "index:acme-staging-vector-notes",
      "metadata:acme-staging-vector-notes:none",
      "worker:staging:acme-staging-vector-docs,acme-staging-vector-notes",
    ]);
  });

  it("reports what each index was provisioned as and what it created", async () => {
    const result = await provisionVector(fakeProvisioner(), { project, config, env: "dev" });
    expect(result.env).toBe("dev");
    expect(result.indexes.map((entry) => entry.indexName)).toEqual(["acme-dev-vector-docs", "acme-dev-vector-notes"]);
    expect(result.indexes[0]?.created).toEqual([{ propertyName: "ownerId", indexType: "string" }]);
  });

  it("is idempotent — a re-run that finds everything present creates nothing", async () => {
    const provisioner = fakeProvisioner({ ensureMetadataIndexes: async () => empty });
    const result = await provisionVector(provisioner, { project, config, env: "staging" });
    expect(result.indexes.every((entry) => entry.created.length === 0)).toBe(true);
  });

  it("surfaces a live metadata index the config does not declare — it still spends one of the ten slots", async () => {
    const provisioner = fakeProvisioner({
      ensureMetadataIndexes: async () => ({ ...empty, extra: [{ propertyName: "legacy", indexType: "string" }] }),
    });
    const result = await provisionVector(provisioner, { project, config, env: "staging" });
    expect(result.indexes[0]?.extra).toEqual([{ propertyName: "legacy", indexType: "string" }]);
  });
});

describe("toProvisionRecord", () => {
  it("records every declared index as observed — ensureMetadataIndexes returned, so each one is live", async () => {
    const result = await provisionVector(fakeProvisioner(), { project, config, env: "staging" });
    expect(toProvisionRecord(result)).toEqual({
      indexes: {
        docs: {
          indexName: "acme-staging-vector-docs",
          metadataIndexes: [{ propertyName: "ownerId", indexType: "string" }],
        },
        notes: { indexName: "acme-staging-vector-notes", metadataIndexes: [] },
      },
    });
  });

  it("carries an undeclared live index into the record, so boot can see it without calling Cloudflare", async () => {
    const provisioner = fakeProvisioner({
      ensureMetadataIndexes: async () => ({ ...empty, extra: [{ propertyName: "legacy", indexType: "string" }] }),
    });
    const record = toProvisionRecord(await provisionVector(provisioner, { project, config, env: "staging" }));
    expect(record.indexes.docs?.metadataIndexes).toEqual([
      { propertyName: "ownerId", indexType: "string" },
      { propertyName: "legacy", indexType: "string" },
    ]);
  });
});

describe("resetVector", () => {
  it("deletes, rebuilds in the provisioning order, and re-embeds the whole corpus", async () => {
    const provisioner = fakeProvisioner();
    const result = await resetVector(provisioner, { project, config, env: "staging" });

    expect(provisioner.calls).toEqual([
      "preflight",
      "delete:acme-staging-vector-docs",
      "delete:acme-staging-vector-notes",
      "preflight",
      "index:acme-staging-vector-docs",
      "metadata:acme-staging-vector-docs:ownerId",
      "index:acme-staging-vector-notes",
      "metadata:acme-staging-vector-notes:none",
      "worker:staging:acme-staging-vector-docs,acme-staging-vector-notes",
      // `all`, not the stale-model pass: the rebuilt index holds nothing at all.
      "reprocess:staging:docs:all",
      "reprocess:staging:notes:all",
    ]);
    expect(result.deleted).toEqual(["acme-staging-vector-docs", "acme-staging-vector-notes"]);
    expect(result.reprocessed).toEqual(["docs", "notes"]);
  });

  it("fails before deleting anything when the account is not ready", async () => {
    const provisioner = fakeProvisioner({
      preflight: async () => {
        throw new Error("no workers.dev subdomain");
      },
    });
    await expect(resetVector(provisioner, { project, config, env: "staging" })).rejects.toThrow(
      "no workers.dev subdomain",
    );
    expect(provisioner.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  });
});
