// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SCOPE_KINDS } from "../controlPlane/scope/kind";
import { KIND_SENTENCES, kindAnnotations } from "./annotations";

describe("kindAnnotations", () => {
  test("a read is read-only, not destructive, and idempotent", () => {
    expect(kindAnnotations("reads")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("a write is neither read-only nor destructive, and claims no idempotence", () => {
    expect(kindAnnotations("writes")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  test("sending is not destructive and reaches outside the application", () => {
    expect(kindAnnotations("sends")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  test("charging is destructive and reaches outside the application", () => {
    expect(kindAnnotations("charges")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  test("deleting and changing a credential are destructive", () => {
    expect(kindAnnotations("deletes")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(kindAnnotations("credentials")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
});

describe("KIND_SENTENCES", () => {
  test("says every kind in one sentence", () => {
    for (const kind of SCOPE_KINDS) expect(KIND_SENTENCES[kind], kind).toMatch(/^[A-Z][^.]*\.$/);
  });

  test("tells every kind apart", () => {
    expect(new Set(Object.values(KIND_SENTENCES)).size).toBe(SCOPE_KINDS.length);
  });
});
