// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_VERSION_CREATED_HEADER,
  CONTROL_PLANE_VERSION_HEADER,
  type WorkerBuild,
  workerBuildChanged,
} from "./wire";

// `import.meta.glob` is a vite/vitest feature; declared so plain `tsc` typecheck accepts it, exactly as
// `worker-safety.test.ts` does. Reading the sources this way rather than through `node:fs` is what keeps
// `@cloudflare/workers-types` core's only ambient type dependency — the property that test relies on.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
  }
}

/** Every module in the package, raw, keyed relative to this file. */
const sources = import.meta.glob(["../**/*.ts", "!../**/*.test.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
});

/** This file's directory, in the same package-relative terms the canonical keys below use. */
const HERE = "src/controlPlane";

/** Resolve a relative specifier against a directory, without `node:path`. */
function canonical(fromDir: string, specifier: string): string {
  const parts = fromDir.split("/").filter(Boolean);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** The glob's keys, re-homed to package-relative paths so a walk can name what it wants. */
const byPath = new Map(Object.entries(sources).map(([key, source]) => [canonical(HERE, key), source]));

/** The directory part of a path. */
function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** Every module specifier a source imports or re-exports from, including bare side-effect imports. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']/g)) {
    if (match[1]) found.push(match[1]);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

/**
 * Everything reachable from `entry` by following relative imports: the files, the bare specifiers hit
 * along the way, and their sources concatenated. A module's cost to a consumer is its whole closure,
 * not its first line, so the closure is what the assertions below are written against.
 */
function moduleGraph(entry: string): { files: string[]; bare: string[]; source: string } {
  const files: string[] = [];
  const bare = new Set<string>();
  const queue = [entry];
  let source = "";
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || files.includes(file)) continue;
    const text = byPath.get(file);
    if (text === undefined) throw new Error(`the glob did not read ${file}`);
    files.push(file);
    source += text;
    for (const specifier of specifiersOf(text)) {
      if (specifier.startsWith(".")) queue.push(`${canonical(dirOf(file), specifier)}.ts`);
      else bare.add(specifier);
    }
  }
  return { files, bare: [...bare], source };
}

describe("control-plane wire constants", () => {
  test("name the headers both sides of the seam agree on", () => {
    expect(CONTROL_PLANE_HEADER).toBe("pithy-control-plane");
    expect(CONTROL_PLANE_VERSION_HEADER).toBe("pithy-worker-version");
    expect(CONTROL_PLANE_VERSION_CREATED_HEADER).toBe("pithy-worker-version-created");
  });

  test("keep the build id a header of its own, so an old client cannot misread a new one", () => {
    // The reason the version's creation time is a second header rather than a richer value in the
    // first. A client already deployed compares the whole `pithy-worker-version` string; fold a second
    // field into it and the day the adopter upgrades the kit reads as a version change that never
    // happened — a false invalidation, which is the "absence is not change" failure wearing a hat. Two
    // headers keep each value one comparable datum, and a client that never reads the second cannot
    // misread it.
    expect(CONTROL_PLANE_VERSION_CREATED_HEADER).not.toBe(CONTROL_PLANE_VERSION_HEADER);
    expect(CONTROL_PLANE_VERSION_CREATED_HEADER.startsWith(`${CONTROL_PLANE_VERSION_HEADER}-`)).toBe(true);
  });

  // The point of the module. A browser calls the customer's Worker directly (docs/CONTROL-PLANE.md §4),
  // so a DOM-typed program has to name these headers — and one import of the verifier drags WebCrypto in
  // with them, at which point `Uint8Array` against `BufferSource` stops that program compiling.
  test("reach nothing — no import at all, so a browser module can hold them", () => {
    const graph = moduleGraph("src/controlPlane/wire.ts");
    expect(graph.files).toEqual(["src/controlPlane/wire.ts"]);
    expect(graph.bare).toEqual([]);
    expect(graph.source).not.toContain("crypto.subtle");
  });

  // The contrast that keeps the assertion above from being vacuous: the walk does find WebCrypto where
  // it is, which is everywhere these constants used to live.
  test("the verifier they used to live beside does reach WebCrypto", () => {
    const graph = moduleGraph("src/controlPlane/http/verify.ts");
    expect(graph.source).toContain("crypto.subtle");
  });
});

const BUILD_A = "6bbf9e9b-90c6-46c5-829d-83241554ac2c";
const BUILD_B = "954d8c61-daa2-4ebf-9b3c-459b4abe7fcd";
const EARLIER = "2026-08-07T10:00:00.000Z";
const LATER = "2026-08-10T21:39:55.716Z";

/** The pair as a client reads it: two `headers.get()` calls, each `string | null`. */
function build(version: string | null, createdAt: string | null): WorkerBuild {
  return { version, createdAt };
}

describe("workerBuildChanged", () => {
  test("says nothing changed while the same build keeps answering", () => {
    expect(workerBuildChanged(build(BUILD_A, LATER), build(BUILD_A, LATER))).toBe(false);
  });

  test("sees a different build", () => {
    // Either direction, and which way the time moved is not interpreted. A version older than the last
    // one seen is an ordinary sight while a deploy propagates — twenty seconds after wrangler reported
    // a rollback at 100%, the URL was still answering from the older version. "Changed" is the fact.
    expect(workerBuildChanged(build(BUILD_A, EARLIER), build(BUILD_B, LATER))).toBe(true);
    expect(workerBuildChanged(build(BUILD_B, LATER), build(BUILD_A, EARLIER))).toBe(true);
  });

  test("sees a moved timestamp under an unmoved id", () => {
    // **The branch that keeps the comparison total.** Not reachable on today's platform: a version's
    // timestamp is fixed at upload, and a rollback makes a new *deployment* pointing at an existing
    // version, so neither field moves. It is here because a rule that enumerates which fields are
    // allowed to move is wrong the day the platform moves a different one — and wrong silently, as
    // "nothing changed". One branch is a cheap price for that. It is not rollback detection; nothing
    // inside a Worker can see a deployment.
    expect(workerBuildChanged(build(BUILD_A, EARLIER), build(BUILD_A, LATER))).toBe(true);
    expect(workerBuildChanged(build(BUILD_A, LATER), build(BUILD_A, EARLIER))).toBe(true);
  });

  test("treats absence as silence, never as change", () => {
    // **Rule one.** A Worker that declares no `version_metadata` sends neither header; a call that
    // failed before its headers were read has none. Both mean "cannot say", and a client that reads a
    // missing value as a new one invalidates a rendered pane on a deploy nobody made. Every direction of
    // absence: never seen, stopped being sent, only just started being sent, and one field of a pair.
    expect(workerBuildChanged(build(null, null), build(null, null))).toBe(false);
    expect(workerBuildChanged(build(BUILD_A, LATER), build(null, null))).toBe(false);
    expect(workerBuildChanged(build(null, null), build(BUILD_A, LATER))).toBe(false);
    expect(workerBuildChanged(build(BUILD_A, null), build(BUILD_A, LATER))).toBe(false);
    expect(workerBuildChanged(build(BUILD_A, LATER), build(BUILD_A, null))).toBe(false);
    expect(workerBuildChanged(build(null, LATER), build(BUILD_A, LATER))).toBe(false);
  });

  test("compares each field on its own, so one silent field cannot mute the other", () => {
    // A partial pair still answers what it can. Dropping the whole comparison because one header was
    // missing would turn a platform hiccup into "nothing changed" — the failure direction that matters.
    expect(workerBuildChanged(build(BUILD_A, null), build(BUILD_B, null))).toBe(true);
    expect(workerBuildChanged(build(null, EARLIER), build(null, LATER))).toBe(true);
  });

  test("reads a blank header as absent, not as a value to compare", () => {
    // The seam never sends one — `workerVersionHeaders` gates that — but a proxy between the two ends
    // can blank a header it does not understand, and an empty string differs from every real id.
    expect(workerBuildChanged(build(BUILD_A, LATER), build("", ""))).toBe(false);
    expect(workerBuildChanged(build("", ""), build(BUILD_A, LATER))).toBe(false);
    expect(workerBuildChanged(build(BUILD_A, LATER), build("   ", LATER))).toBe(false);
  });
});
