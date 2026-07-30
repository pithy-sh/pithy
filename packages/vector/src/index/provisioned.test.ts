// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VectorConfig } from "../config/config";
import { filterable } from "./filter";
import {
  assertProvisionedMetadataIndexes,
  readProvisionRecord,
  VECTOR_PROVISIONED_VAR,
  type VectorProvisionRecord,
} from "./provisioned";

/**
 * The boot check, tested as the four cases it has to tell apart: drift, no drift, a mis-typed index, and a
 * leftover index the config does not declare — which must not stop a boot, because refusing to serve over
 * someone else's metadata index would be hostile.
 */

const DocMeta = z.object({
  tenantId: filterable(z.string().describe("The tenant this document belongs to.")),
  published: filterable(z.boolean().describe("Whether the document is visible.")),
  title: z.string().describe("The title, carried for hydration — not filterable."),
});

const config = VectorConfig.parse({
  indexes: { docs: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, metadata: DocMeta } },
});

/** A config that marks nothing filterable — nothing to drift, so nothing to check. */
const unfiltered = VectorConfig.parse({
  indexes: { docs: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768 } },
});

const record = (metadataIndexes: { propertyName: string; indexType: string }[]): VectorProvisionRecord => ({
  indexes: { docs: { indexName: "pithy-vector-docs-staging", metadataIndexes } },
});

const provisioned = [
  { propertyName: "tenantId", indexType: "string" },
  { propertyName: "published", indexType: "boolean" },
];

function payloadOf(run: () => void): { code: string; message: string; action?: string; detail?: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return (error as PithyError).payload;
  }
  throw new Error("expected a throw");
}

describe("assertProvisionedMetadataIndexes", () => {
  it("passes when every declared field was provisioned", () => {
    expect(() => assertProvisionedMetadataIndexes(config, record(provisioned))).not.toThrow();
  });

  it("refuses to boot when a declared field has no provisioned metadata index", () => {
    const payload = payloadOf(() =>
      assertProvisionedMetadataIndexes(config, record([{ propertyName: "tenantId", indexType: "string" }])),
    );
    expect(payload.code).toBe("vector/metadata_index_drift");
    // The acceptance criterion verbatim: the field and the command, both in what the operator sees.
    expect(payload.message).toContain("docs.published");
    expect(payload.action).toContain("pithy vector provision");
  });

  it("refuses to boot on a type mismatch — a comparison against the wrong type never matches", () => {
    const payload = payloadOf(() =>
      assertProvisionedMetadataIndexes(
        config,
        record([
          { propertyName: "tenantId", indexType: "string" },
          { propertyName: "published", indexType: "string" },
        ]),
      ),
    );
    expect(payload.code).toBe("vector/metadata_index_drift");
    expect(payload.message).toContain("declared boolean, indexed as string");
  });

  it("boots with a provisioned index the config does not declare — a leftover is not a reason to refuse", () => {
    const live = [...provisioned, { propertyName: "legacy", indexType: "string" }];
    expect(() => assertProvisionedMetadataIndexes(config, record(live))).not.toThrow();
  });

  it("boots when an index is absent from the record but declares nothing filterable", () => {
    expect(() => assertProvisionedMetadataIndexes(unfiltered, undefined)).not.toThrow();
  });

  it("refuses to boot with no record at all when fields are declared filterable — nothing was ever created", () => {
    const payload = payloadOf(() => assertProvisionedMetadataIndexes(config, undefined));
    expect(payload.code).toBe("vector/metadata_index_drift");
    expect(payload.message).toContain("docs.tenantId");
    expect(payload.action).toContain("pithy vector provision");
  });

  it("treats an index missing from the record as every one of its declared fields missing", () => {
    const payload = payloadOf(() => assertProvisionedMetadataIndexes(config, { indexes: {} }));
    expect(payload.message).toContain("docs.tenantId");
    expect(payload.message).toContain("docs.published");
  });
});

describe("readProvisionRecord", () => {
  it("returns undefined when the var is absent or blank — the caller decides what absence means", () => {
    expect(readProvisionRecord({})).toBeUndefined();
    expect(readProvisionRecord({ [VECTOR_PROVISIONED_VAR]: "  " })).toBeUndefined();
  });

  it("parses the var written by `pithy vector provision`", () => {
    const env = { [VECTOR_PROVISIONED_VAR]: JSON.stringify(record(provisioned)) };
    expect(readProvisionRecord(env)?.indexes.docs?.metadataIndexes).toEqual(provisioned);
  });

  it("refuses a var that is not JSON rather than reading it as absence", () => {
    const payload = payloadOf(() => readProvisionRecord({ [VECTOR_PROVISIONED_VAR]: "{not json" }));
    expect(payload.code).toBe("vector/metadata_index_drift");
  });

  it("refuses a var that parses but is not a record", () => {
    const env = { [VECTOR_PROVISIONED_VAR]: JSON.stringify({ indexes: { docs: { indexName: 7 } } }) };
    expect(() => readProvisionRecord(env)).toThrow(PithyError);
  });
});
