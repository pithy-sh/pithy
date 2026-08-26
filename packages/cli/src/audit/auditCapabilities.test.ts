// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isShippedSource, sourceFiles } from "../ci/sourceFiles";

/**
 * An audit emitter is never built from a capability set that swallowed its own failure — #455.
 *
 * `resolveWorkers(…).then(projectCapabilities).catch(() => [])` was copy-pasted into nine commands, and
 * every copy folded *cannot tell* into *nothing*: `createCliAudit` finds no `audit` capability in an empty
 * list and returns its no-op, which is exactly what a project that never composed audit gets. So one
 * Worker config that would not import — a fresh CI checkout where a capability package did not install —
 * let `pithy deploy --env prod` ship every Worker, print `Done.`, exit 0, and write no row for a project
 * that audits. `cliAudit.ts` states the standard: an audit trail you cannot tell is broken is worse than
 * none.
 *
 * The fix is one shared builder (`createProjectCliAudit`) threading `Capability[] | null`. That is a
 * property of the *set* of call sites — the same shape as the migration-order and table-prefix rules, and
 * true only if no copy is left behind — so this is the gate that keeps the tenth from landing.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/** Every shipped `.ts` source under `packages/cli/src`, keyed by its path relative to that root. */
function cliSources(): Map<string, string> {
  return new Map(
    sourceFiles(CLI_SRC, { keep: isShippedSource }).map((file) => [relative(CLI_SRC, file.path), file.text]),
  );
}

/** How far back a `.catch(() => [])` is read for the expression it is swallowing. */
const LOOKBEHIND = 240;

/**
 * Every place a capability list is flattened by a swallowed failure, named.
 *
 * Matched by looking *behind* each `.catch(() => [])` rather than for one exact formatting, because the
 * nine copies were not byte-identical — some named a `worker`, one carried an extra comment — and a rule
 * pinned to one layout is a rule the next copy walks past.
 */
function swallowedCapabilities(sources: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, source] of sources) {
    const swallow = /\.catch\(\(\)\s*=>\s*\[\]\)/g;
    for (let match = swallow.exec(source); match !== null; match = swallow.exec(source)) {
      const before = source.slice(Math.max(0, match.index - LOOKBEHIND), match.index);
      if (/\bprojectCapabilities\b/.test(before)) offenders.push(`${name}: capabilities emptied by a catch`);
    }
  }
  return offenders;
}

describe("swallowedCapabilities", () => {
  const offenders = (source: string) => swallowedCapabilities(new Map([["probe.ts", source]]));

  it("names the copy-pasted shape, however it is wrapped", () => {
    expect(
      offenders("const c = await resolveWorkers({ projectDir }).then(projectCapabilities).catch(() => []);"),
    ).toEqual(["probe.ts: capabilities emptied by a catch"]);
    expect(
      offenders(
        "const c = await resolveWorkers({ projectDir })\n  .then(projectCapabilities)\n  // a note\n  .catch(() => []);",
      ),
    ).toEqual(["probe.ts: capabilities emptied by a catch"]);
  });

  it("leaves an unrelated empty-list fallback alone", () => {
    // `discoverWorkers` needs no config load and has nothing to conflate — the ordinary "not a project
    // here" answer, which several commands legitimately take.
    expect(offenders("const targets = await discoverWorkers(projectDir).catch(() => []);")).toEqual([]);
    expect(offenders("const capabilities = await projectCapabilitiesOrNull(projectDir);")).toEqual([]);
  });
});

describe("no CLI source builds a capability set from a swallowed failure", () => {
  const sources = cliSources();

  it("walks the sources it is meant to guard", () => {
    // Non-vacuity: a walk that matched no files would make the rule below pass forever.
    expect(sources.size).toBeGreaterThan(200);
    expect([...sources.keys()]).toContain("commands/deploy.ts");
    expect([...sources.values()].filter((source) => /\bprojectCapabilities\b/.test(source)).length).toBeGreaterThan(4);
  });

  it("finds no offender", () => {
    expect(swallowedCapabilities(sources)).toEqual([]);
  });
});
