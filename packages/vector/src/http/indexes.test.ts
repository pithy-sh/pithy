// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { IndexReadDeps } from "../admin/indexes";
import { VectorConfig } from "../config/config";
import type { CorpusState } from "../data/corpusState";
import type { VectorStore } from "../index/index";
import { VECTOR_PROVISIONED_VAR } from "../index/provisioned";
import { VectorIndexesResponse } from "./responses";
import { registerVectorRoutes } from "./routes";
import { VECTOR_INDEXES_READ_SCOPE } from "./scopes";

/**
 * `GET {basePath}/indexes` over a real Hono app: the control-plane gate, the mount point, and the env-backed
 * resolver reading the provision var and the binding the index names. The corpus is the one thing faked, and
 * `corpusState.workers.test.ts` proves it against real D1.
 */

const config = VectorConfig.parse({ indexes: { docs: { model: "current", dimensions: 3 } } });

function context(granted: string[]): ControlPlaneContext {
  return {
    connectionId: "conn-1",
    environment: "prod",
    issuer: "https://dashboard.example",
    subject: "operator-1",
    scope: VECTOR_INDEXES_READ_SCOPE,
    grantedScopes: granted,
    keyId: "key-1",
    tokenId: "jti-1",
    actorKind: "dashboard",
  };
}

const store: VectorStore = {
  upsert: async () => ({ mutationId: "m" }),
  query: async () => ({ count: 0, matches: [] }),
  describe: async () => ({ vectorCount: 4, dimensions: 3, processedUpToDatetime: null, processedUpToMutation: null }),
};

function harness(
  options: { granted?: string[]; basePath?: string; env?: Record<string, unknown>; resolve?: boolean } = {},
) {
  const granted = options.granted ?? [VECTOR_INDEXES_READ_SCOPE];
  const corpus: CorpusState = {
    embedding: vi.fn(async () => ({ declaredModel: 3, otherModel: 1, unembedded: 0 })),
    namespaces: vi.fn(async () => 2),
    hasStale: vi.fn(async () => true),
  };
  const verify: ControlPlaneVerifier = async (_request, requirement) => {
    if (typeof requirement === "string" && !granted.includes(requirement)) throw new Error(`ungranted ${requirement}`);
    return context(granted);
  };
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verify);
    c.set("log", noopLogger);
    await next();
  });
  const resolveIndexes = vi.fn(
    (): IndexReadDeps => ({ config, record: undefined, environment: "prod", store: () => store, corpus }),
  );
  registerVectorRoutes({
    config,
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    // Left unset, the route resolves from the env; the corpus still comes from the fake.
    ...(options.resolve === false ? { resolveCorpus: () => corpus } : { resolveIndexes }),
  })(app);
  const request = (path: string) => app.request(path, {}, options.env ?? {});
  return { app, request, corpus, resolveIndexes };
}

describe("GET /vector/indexes (#730)", () => {
  test("answers every declared index in the declared shape", async () => {
    const h = harness();
    const response = await h.request("/vector/indexes");
    expect(response.status).toBe(200);
    const body = VectorIndexesResponse.parse(await response.json());
    expect(body.indexes).toHaveLength(1);
    expect(body.indexes[0]).toMatchObject({
      name: "docs",
      vectorize: { state: "read", vectorCount: 4, dimensionMismatch: null },
      documents: { declaredModel: 3, otherModel: 1, unembedded: 0 },
      namespaces: 2,
      provision: { state: "unprovisioned" },
    });
  });

  test("mounts under the configured base path, not the default", async () => {
    const h = harness({ basePath: "/search" });
    expect((await h.request("/search/indexes")).status).toBe(200);
    expect((await h.request("/vector/indexes")).status).toBe(404);
  });

  test("a caller without the scope is refused before anything is read", async () => {
    const h = harness({ granted: [] });
    const response = await h.request("/vector/indexes");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(h.resolveIndexes).not.toHaveBeenCalled();
    expect(h.corpus.embedding).not.toHaveBeenCalled();
  });

  test("the env resolver reads the provision var, the index's own binding, and the Worker's environment", async () => {
    const record = { indexes: { docs: { indexName: "app-staging-docs", metadataIndexes: [] } } };
    const h = harness({
      resolve: false,
      env: { VECTORIZE: store, ENVIRONMENT: "staging", [VECTOR_PROVISIONED_VAR]: JSON.stringify(record) },
    });
    const body = VectorIndexesResponse.parse(await (await h.request("/vector/indexes")).json());
    expect(body.environment).toBe("staging");
    expect(body.indexes[0]?.provision).toEqual({ state: "provisioned" });
    expect(body.indexes[0]?.vectorize).toMatchObject({ state: "read", vectorCount: 4 });
  });

  test("the env resolver reports a missing binding as unreadable rather than failing the read", async () => {
    const h = harness({ resolve: false, env: { ENVIRONMENT: "prod" } });
    const response = await h.request("/vector/indexes");
    expect(response.status).toBe(200);
    const body = VectorIndexesResponse.parse(await response.json());
    expect(body.indexes[0]?.vectorize).toEqual({ state: "unreadable", reason: "unbound" });
  });
});
