import { describe, expect, test } from "vitest";
import {
  CompleteUploadInput,
  CopyObjectInput,
  CreateShareInput,
  CreateUploadInput,
  ListObjectsQuery,
  UpdateObjectInput,
} from "./schemas";

/** The HTTP input boundary. Everything a client can send arrives through one of these. */

describe("CreateUploadInput", () => {
  test("accepts a path, a type, and a size", () => {
    expect(CreateUploadInput.parse({ path: "a/b.txt", contentType: "text/plain", size: 12 })).toEqual({
      path: "a/b.txt",
      contentType: "text/plain",
      size: 12,
    });
  });

  test("a size is required — a presigned PUT signs Content-Length, and the row reserves quota", () => {
    expect(CreateUploadInput.safeParse({ path: "a.txt", contentType: "text/plain" }).success).toBe(false);
  });

  test("a path with a slash or a dot-dot is just an odd name, not a traversal — keys are never derived from it", () => {
    expect(CreateUploadInput.safeParse({ path: "../../etc/passwd", contentType: "text/plain", size: 1 }).success).toBe(
      true,
    );
  });

  test("a control character is refused — it breaks headers and log lines, which a path does reach", () => {
    for (const path of ["a\nb.txt", "a\u0000b.txt", "a\u007Fb.txt", "a\rb.txt"]) {
      expect(CreateUploadInput.safeParse({ path, contentType: "text/plain", size: 1 }).success).toBe(false);
    }
  });

  test("an unbounded path is refused — a text column nobody caps is a way to fill a database", () => {
    const long = "a".repeat(1025);
    expect(CreateUploadInput.safeParse({ path: long, contentType: "text/plain", size: 1 }).success).toBe(false);
  });

  test("a negative size is refused", () => {
    expect(CreateUploadInput.safeParse({ path: "a.txt", contentType: "text/plain", size: -1 }).success).toBe(false);
  });

  test("visibility is optional, and only the two known values are accepted", () => {
    expect(
      CreateUploadInput.parse({ path: "a.txt", contentType: "text/plain", size: 1, visibility: "public" }).visibility,
    ).toBe("public");
    expect(
      CreateUploadInput.safeParse({ path: "a.txt", contentType: "text/plain", size: 1, visibility: "secret" }).success,
    ).toBe(false);
  });
});

describe("CompleteUploadInput", () => {
  test("an empty body is valid — a single-PUT upload has no parts to assemble", () => {
    expect(CompleteUploadInput.parse({})).toEqual({ parts: [] });
  });

  test("a checksum must be lowercase hex SHA-256", () => {
    expect(CompleteUploadInput.safeParse({ checksum: "a".repeat(64) }).success).toBe(true);
    expect(CompleteUploadInput.safeParse({ checksum: "A".repeat(64) }).success).toBe(false);
    expect(CompleteUploadInput.safeParse({ checksum: "abc" }).success).toBe(false);
  });

  test("a part number below one is refused", () => {
    expect(CompleteUploadInput.safeParse({ parts: [{ partNumber: 0, etag: "x" }] }).success).toBe(false);
  });
});

describe("UpdateObjectInput", () => {
  test("either field alone is enough", () => {
    expect(UpdateObjectInput.safeParse({ path: "new.txt" }).success).toBe(true);
    expect(UpdateObjectInput.safeParse({ visibility: "public" }).success).toBe(true);
  });

  test("an empty patch is refused — answering 200 to it would hide the client's bug", () => {
    expect(UpdateObjectInput.safeParse({}).success).toBe(false);
  });
});

describe("CopyObjectInput and CreateShareInput", () => {
  test("a copy needs a destination path", () => {
    expect(CopyObjectInput.safeParse({}).success).toBe(false);
    expect(CopyObjectInput.parse({ path: "copy.txt" }).path).toBe("copy.txt");
  });

  test("a share may omit its expiry, which means it only ever ends by revocation", () => {
    expect(CreateShareInput.parse({})).toEqual({});
  });

  test("a share expiry is capped at a year — one that outlives memory of granting it is just a public file", () => {
    expect(CreateShareInput.safeParse({ expiresInSeconds: 365 * 24 * 60 * 60 }).success).toBe(true);
    expect(CreateShareInput.safeParse({ expiresInSeconds: 365 * 24 * 60 * 60 + 1 }).success).toBe(false);
    expect(CreateShareInput.safeParse({ expiresInSeconds: 0 }).success).toBe(false);
  });
});

describe("ListObjectsQuery", () => {
  test("a limit arrives as a query string and is coerced", () => {
    expect(ListObjectsQuery.parse({ limit: "25" }).limit).toBe(25);
  });

  test("the page size is capped, so one request cannot scan an owner's whole file set", () => {
    expect(ListObjectsQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(ListObjectsQuery.safeParse({ limit: "0" }).success).toBe(false);
  });

  test("an empty query lists everything you own", () => {
    expect(ListObjectsQuery.parse({})).toEqual({});
  });
});
