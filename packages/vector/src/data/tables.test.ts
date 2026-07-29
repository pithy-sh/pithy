import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VectorDocument, vectorDocumentFor } from "./document";
import { VECTOR_DOCUMENTS_TABLE, vectorTables } from "./tables";

/** camelCase here; `CamelCasePlugin` snake-cases it in the DDL. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("table prefixing (CLAUDE.md §Data layer)", () => {
  it("prefixes every provided table pithy_vector_, so it can never clash with an adopter's own", () => {
    for (const name of Object.keys(vectorTables())) {
      expect(toSnake(name)).toMatch(/^pithy_vector_/);
    }
  });

  it("names the table the migration creates", () => {
    expect(Object.keys(vectorTables())).toEqual([VECTOR_DOCUMENTS_TABLE]);
  });
});

describe("VectorDocument codec round-trip", () => {
  const document = {
    id: "doc-1",
    indexName: "docs",
    namespace: "acme",
    content: "The quick brown fox.",
    metadata: { tenantId: "acme", words: 4 },
    model: "@cf/baai/bge-base-en-v1.5",
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_001_000),
  };

  it("encodes dates to ms-epoch and metadata to a JSON string, then decodes back", () => {
    const row = VectorDocument.encode(document);
    expect(row.createdAt).toBe(1_700_000_000_000);
    expect(row.metadata).toBe('{"tenantId":"acme","words":4}');
    expect(VectorDocument.parse(row)).toEqual(document);
  });

  it("round-trips the nulls a document written without text or a recorded model carries", () => {
    const sparse = { ...document, namespace: null, content: null, model: null, metadata: {} };
    expect(VectorDocument.parse(VectorDocument.encode(sparse))).toEqual(sparse);
  });

  it("decodes the JSON string a real D1 row actually carries", () => {
    const parsed = VectorDocument.parse({ ...VectorDocument.encode(document), metadata: '{"tenantId":"globex"}' });
    expect(parsed.metadata).toEqual({ tenantId: "globex" });
  });
});

describe("vectorDocumentFor", () => {
  const DocMeta = z.object({
    tenantId: z.string().describe("Tenant."),
    words: z.number().describe("Word count."),
  });

  it("validates metadata against the index's own schema on the way in and out", () => {
    const schema = vectorDocumentFor(DocMeta);
    const document = {
      id: "doc-1",
      indexName: "docs",
      namespace: null,
      content: null,
      metadata: { tenantId: "acme", words: 4 },
      model: null,
      createdAt: new Date(1_700_000_000_000),
      updatedAt: new Date(1_700_000_000_000),
    };
    expect(schema.parse(schema.encode(document))).toEqual(document);
  });

  it("refuses a stored payload that does not match the index's schema", () => {
    const schema = vectorDocumentFor(DocMeta);
    const row = {
      ...VectorDocument.encode({
        id: "doc-1",
        indexName: "docs",
        namespace: null,
        content: null,
        metadata: { tenantId: "acme" },
        model: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    };
    expect(schema.safeParse(row).success).toBe(false);
  });
});
