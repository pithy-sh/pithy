// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Put the SPDX notice on every emitted `.d.ts`.
 *
 *   bun ../../tooling/build/src/stampDeclarations.ts
 *
 * A distributed file carries its notice. tsdown puts one on every `.js` it emits through `banner`, and
 * `tsc --emitDeclarationOnly` has no equivalent: it drops a file's leading `//` comment, because a
 * comment not attached to a declaration is not part of the type. So the other half of the published
 * pair had none, and a `.d.ts` is the half an adopter's editor opens most.
 *
 * Run after `tsc` in each package's `build`, never before — it stamps what is on disk, and `tsdown`
 * cleans `dist` on the way in.
 *
 * Idempotent, and that is not incidental: `build` re-runs constantly and turbo replays a cached `dist`,
 * so a stamper that appended each time would grow a header per build and change the bytes of a
 * published file for no reason.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHeader } from "@pithy-sh/license-headers/src/header";

/** Every `.d.ts` under `dir`, recursively. `.d.ts.map` is JSON and carries no comments. */
function declarations(dir: string): string[] {
  const found: string[] = [];
  let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...declarations(path));
    else if (entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

/** Stamp every declaration under `dist`, and answer how many needed it. */
export function stampDeclarations(dist: string, license: string): number {
  const header = buildHeader(license);
  let stamped = 0;
  for (const path of declarations(dist)) {
    const source = readFileSync(path, "utf8");
    if (source.startsWith(header)) continue;
    writeFileSync(path, `${header}\n${source}`);
    stamped += 1;
  }
  return stamped;
}

if (import.meta.main) {
  // The package's own license, for the reason `spdxHeader` in `tsdown.ts` gives: the terms are per
  // package, and the compiled half must not claim different ones from the source it came from.
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { license?: string };
  if (manifest.license === undefined) {
    throw new Error(`${process.cwd()}/package.json declares no license, so its declarations cannot be stamped.`);
  }
  const count = stampDeclarations(join(process.cwd(), "dist"), manifest.license);
  if (count > 0) process.stdout.write(`stamped ${count} declarations\n`);
}
