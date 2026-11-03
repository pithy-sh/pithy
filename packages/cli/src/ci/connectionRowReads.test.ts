// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **A stored control-plane connection is decoded in one place: `parseConnectionRow`.**
 *
 * A row that does not parse is refused there with the columns that failed and how they read, the same
 * way for the Worker's verifier and the CLI's registry. A reader that calls the schema directly turns
 * the same row into a bare `ZodError`, so every shipped module but the schema's own is held to the seam.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The schema's own module, where `parseConnectionRow` is defined over it. */
const SEAM = resolve(REPO_ROOT, "packages", "core", "src", "controlPlane", "data", "connection.ts");

/**
 * A direct decode of a stored connection: any of the schema's decoding methods, reached by a dot, a bracket or a
 * destructure, or the schema imported under another name, whose calls no pattern could follow.
 */
const DECODERS = "parse|safeParse|parseAsync|safeParseAsync|decode|safeDecode|decodeAsync|safeDecodeAsync";
const DIRECT_DECODE = new RegExp(
  [
    `\\bControlPlaneConnection\\s*(?:\\.\\s*(?:${DECODERS})\\b|\\[\\s*["'\`](?:${DECODERS})["'\`]\\s*\\])`,
    `\\{[^}]*\\b(?:${DECODERS})\\b[^}]*\\}\\s*=\\s*ControlPlaneConnection\\b`,
    "\\bControlPlaneConnection\\s+as\\s+\\w+",
  ].join("|"),
);

describe("connection rows are decoded through parseConnectionRow", () => {
  test("the seam exists and decodes through the schema", () => {
    const seam = sourceFiles(resolve(REPO_ROOT, "packages", "core", "src")).find((file) => file.path === SEAM);
    expect(seam?.text).toMatch(/export function parseConnectionRow/);
    expect(seam && DIRECT_DECODE.test(blankComments(seam.text))).toBe(true);
  });

  test("the pattern catches every spelling it claims to", () => {
    for (const spelling of [
      "ControlPlaneConnection.parse(row)",
      "ControlPlaneConnection.safeDecode(row)",
      'ControlPlaneConnection["parse"](row)',
      "const { parse } = ControlPlaneConnection;",
      'import { ControlPlaneConnection as Row } from "./connection";',
    ]) {
      expect(DIRECT_DECODE.test(spelling), spelling).toBe(true);
    }
    expect(DIRECT_DECODE.test("ControlPlaneConnection.encode(connection)")).toBe(false);
  });

  test("no other shipped module decodes a connection row directly", () => {
    const offenders = sourceFiles(resolve(REPO_ROOT, "packages"))
      .filter((file) => file.path !== SEAM && DIRECT_DECODE.test(blankComments(file.text)))
      .map((file) => relative(REPO_ROOT, file.path));
    expect(offenders).toEqual([]);
  });
});
