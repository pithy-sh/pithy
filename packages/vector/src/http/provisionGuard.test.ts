// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createBackend } from "@pithy-sh/core/src/createBackend";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { vector } from "../capability";
import { filterable } from "../index/filter";
import { VECTOR_PROVISIONED_VAR } from "../index/provisioned";

/**
 * The check has to actually run. It is asserted through `createBackend` rather than against the middleware
 * in isolation, because the defect this closes was a correct, tested comparison that nothing ever called.
 */

const DocMeta = z.object({
  tenantId: filterable(z.string().describe("The tenant this document belongs to.")),
  title: z.string().describe("The title — not filterable."),
});

const options = { indexes: { docs: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, metadata: DocMeta } } };

/** Every binding the capability requires, faked — the guard runs after core's binding validation. */
const bindings = { VECTORIZE: {}, AI: {}, DB: {} };

const recordVar = (metadataIndexes: { propertyName: string; indexType: string }[]): string =>
  JSON.stringify({ indexes: { docs: { indexName: "pithy-vector-docs-dev", metadataIndexes } } });

function backend() {
  return createBackend({ capabilities: [vector(options)] });
}

async function get(path: string, env: Record<string, unknown>): Promise<Response> {
  return backend().fetch(new Request(`https://example.test${path}`), env);
}

describe("the vector drift guard on the boot path", () => {
  it("refuses to serve when a declared filterable field was never provisioned", async () => {
    const response = await get("/anything", { ...bindings, [VECTOR_PROVISIONED_VAR]: recordVar([]) });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string; action?: string } };
    expect(body.error.code).toBe("vector/metadata_index_drift");
    expect(body.error.message).toContain("docs.tenantId");
    expect(body.error.action).toContain("pithy vector provision");
  });

  it("refuses to serve when nothing has been provisioned at all", async () => {
    const response = await get("/anything", bindings);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("vector/metadata_index_drift");
  });

  it("serves normally when every declared field was provisioned", async () => {
    const provisioned = recordVar([{ propertyName: "tenantId", indexType: "string" }]);
    const response = await get("/anything", { ...bindings, [VECTOR_PROVISIONED_VAR]: provisioned });
    // Past the guard: an unrouted path is a 404, not a 500.
    expect(response.status).toBe(404);
  });

  it("serves normally with a provisioned index the config does not declare", async () => {
    const provisioned = recordVar([
      { propertyName: "tenantId", indexType: "string" },
      { propertyName: "legacy", indexType: "string" },
    ]);
    const response = await get("/anything", { ...bindings, [VECTOR_PROVISIONED_VAR]: provisioned });
    expect(response.status).toBe(404);
  });

  it("keeps re-throwing rather than memoizing a failure into a bare 500", async () => {
    const app = backend();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.fetch(new Request("https://example.test/anything"), bindings);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("vector/metadata_index_drift");
    }
  });

  it("leaves `GET /health` answering, so a drifted deploy fails on traffic rather than on the probe", async () => {
    const response = await get("/health", bindings);
    expect(response.status).toBe(200);
  });
});
