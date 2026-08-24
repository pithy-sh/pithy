// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **Every throw-sugar argument type carries every field the payload does.**
 *
 * `ErrorArgs` is not exported from `@pithy-sh/core`, so each capability's `src/error/errors.ts`
 * re-declares its own private clone of it — eighteen of them, all structurally identical. That is the
 * exact "fixed one instance and left its siblings" shape `error/payload.ts` says the schema-level
 * design exists to prevent, and it is the shape it took: `params` landed in seventeen of the eighteen
 * on the day it was added (#441), and the one that was missed compiled, linted and tested green.
 * `@pithy-sh/testers` could not hand a translating client interpolation values, and nothing said so.
 *
 * ## Why a census rather than one exported type
 *
 * `docs/CONVENTIONS.md` is right that removing an invariant beats watching it, and exporting `ErrorArgs`
 * is the obvious removal. It is not a complete one. The next capability is free to write its own inline
 * `{ message?: string; action?: string }` and never reach for the shared type at all — which is how
 * eighteen clones came to exist without anybody deciding to make them. The property that has to hold is
 * about the **set** of vehicles a caller can throw, so it is checked over the set. Export the shared
 * type as well if you like; this stays either way.
 *
 * ## What it checks, and what it deliberately does not
 *
 * It reads the declared fields of every `*ErrorArgs` interface in a shipped `src/error/errors.ts` and
 * requires each to be a superset of {@link REQUIRED_FIELDS}. It does **not** check that a constructor
 * forwards what its args type declares — that is what {@link forwards} covers, by requiring the same
 * count of `params:` forwards as `extends PithyError` classes in the file. Neither reaches semantics: a
 * constructor that forwards `params: undefined` would pass. The failure this exists for is the omitted
 * one, not the wrong one.
 */

/** Every field a throw-sugar args type must accept, because the payload carries every one of them. */
const REQUIRED_FIELDS = ["message", "action", "detail", "params"] as const;

/**
 * The tree, read once. A literal `new URL` expression inside this file on purpose: `.github/scripts/`
 * resolves cross-package reads statically and cannot follow a variable, so hoisting the path would
 * unregister the read and CI would plan this suite wrong. Recorded in `crossPackageReads.test.ts`.
 */
const PACKAGES = fileURLToPath(new URL("../../../../packages", import.meta.url));

/**
 * Every shipped source that declares a throw-sugar args type, as `{ path, source }`.
 *
 * **Derived from the property, never from a path list.** `src/error/errors.ts` is the convention and it
 * is not the rule: `@pithy-sh/cloudflare` keeps its vehicles in `src/client/errors.ts` and core's
 * canonical `ErrorArgs` lives in `src/error/pithyError.ts`. A path glob shaped like the convention
 * silently skips both — which is the same defect as the one this file exists to catch, one level up.
 */
function vehicleFiles(): { path: string; source: string }[] {
  // The shared walk, whose default `keep` is already `isShippedSource` — tests and `.d.ts` are out.
  // `packages/cli/src/ci/sourceFiles.test.ts` fails any module that writes its own directory walk.
  return sourceFiles(PACKAGES)
    .map((file) => ({ path: file.path.replaceAll("\\", "/"), source: blankComments(file.text) }))
    .filter((file) => /interface\s+\w*ErrorArgs\b/.test(file.source));
}

/** The fields one `interface …ErrorArgs { … }` block declares. */
function declaredFields(source: string): { name: string; fields: string[] }[] {
  const found: { name: string; fields: string[] }[] = [];
  for (const match of source.matchAll(/interface\s+(\w*ErrorArgs)\s*\{([^}]*)\}/g)) {
    const [, name = "", body = ""] = match;
    found.push({ name, fields: [...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map((field) => field[1] ?? "") });
  }
  return found;
}

/** How many vehicles a file declares, and how many of them forward `params`. */
function forwards(source: string): { classes: number; forwarded: number } {
  return {
    classes: [...source.matchAll(/extends\s+PithyError\b/g)].length,
    forwarded: [...source.matchAll(/^\s*params:\s*args\.params,?\s*$/gm)].length,
  };
}

describe("every throw vehicle accepts every field the payload carries", () => {
  const files = vehicleFiles();

  test("the sweep is looking at the tree, not at nothing", () => {
    // Near-exact: 18 files declaring 18 args types on 2026-08-23. A collapse here reads exactly like a
    // pass, which is the whole reason the number is written down.
    expect(files.length).toBeGreaterThanOrEqual(17);
    expect(files.flatMap((file) => declaredFields(file.source)).length).toBeGreaterThanOrEqual(17);
  });

  test.each(REQUIRED_FIELDS)("every `*ErrorArgs` declares `%s`", (field) => {
    const missing = files.flatMap((file) =>
      declaredFields(file.source)
        .filter((args) => !args.fields.includes(field))
        .map((args) => `${file.path.slice(file.path.indexOf("packages/"))} — ${args.name}`),
    );
    expect(missing, `these cannot accept \`${field}\`:\n${missing.join("\n")}`).toEqual([]);
  });

  test("every vehicle in a file forwards `params` — declaring it is not passing it", () => {
    const short = files
      .map((file) => ({ path: file.path.slice(file.path.indexOf("packages/")), ...forwards(file.source) }))
      .filter((file) => file.forwarded < file.classes)
      .map((file) => `${file.path} — ${file.forwarded} of ${file.classes} vehicles forward params`);
    expect(short, short.join("\n")).toEqual([]);
  });
});
