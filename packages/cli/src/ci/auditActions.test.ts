// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **A declared audit action code that nothing emits fails the build.**
 *
 * The taxonomy is federated on purpose: every capability exports its own `domain/reason` codes and adds
 * them without touching core, the way migrations and table prefixes already federate. What federation
 * costs is a reviewer who can see the whole set — the declaration and the emit sites live in different
 * files, sometimes in different packages, and nothing compared them.
 *
 * So a code could be declared, documented, described in a JSDoc line an adopter would read as a promise,
 * and never written by anything. That is what `controlplane/connection_registered`,
 * `controlplane/connection_updated` and `controlplane/connection_removed` were from the day the seam
 * shipped until #294: the three widest-blast-radius changes on an adopter's side — a management client
 * gaining reach into an environment, that reach moving, every credential for it dying at once — declared
 * as recordable and recorded by nothing. An adopter could read a *key* rotation in their own trail but
 * not the connection being created or destroyed. The larger event was the invisible one.
 *
 * The gap was invisible because it is invisible by construction. A declaration compiles, a JSDoc line
 * reads as intent, and a missing emit is the absence of code — there is nothing to review. The only
 * thing that finds it is comparing the two sets, which is a machine's job.
 *
 * **A source scan, deliberately, rather than a runtime registry.** Making every emit register itself
 * would mean a runtime import from each capability into a common place — the cycle
 * `ControlPlaneAuditActions` already exists to avoid, since audit depends on core and core cannot depend
 * back. And a registry only knows about the modules something imported, so a capability nobody loaded in
 * the test process would pass by not being there. The text is the honest source: a code with no use site
 * in this repository has no emit site in it either.
 *
 * The rule is a **use** site, not an emit site, and that is the loose direction on purpose. Proving a
 * constant reaches an `emit()` call needs a call graph; proving nothing anywhere mentions it needs a
 * grep. The gap this catches is total absence, which is the one that actually happened.
 */

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The audit-action shape core validates every code against — `domain/reason`, lowercase, one slash. */
const ACTION_CODE = /^[a-z][a-z0-9]*\/[a-z][a-z0-9_]*$/;

/** One declared action map: where it lives, what it is called, and the codes it names. */
interface ActionMap {
  /** The file it is declared in, relative to the repo root. */
  readonly file: string;
  /** The exported const's name — how every use site addresses it. */
  readonly name: string;
  /** The members, as `[key, code]` pairs in declaration order. */
  readonly codes: readonly (readonly [string, string])[];
}

/**
 * Every audit-action map in the tree.
 *
 * Matched by **shape, not by name**: an exported `Actions` const, optionally wrapped in
 * `defineAuditActions`, all of whose values are valid action codes. Nine of the eleven use the
 * `defineAuditActions` helper or the `<X>AuditActions` name and two do neither —
 * `ControlPlaneAuditActions` cannot import the helper without a cycle, and the CLI's own maps are plain
 * objects — so a name-based or a helper-based matcher would let the exceptions through, and the
 * exceptions are where the hole was.
 */
function actionMaps(sources: readonly { path: string; text: string }[]): ActionMap[] {
  const found: ActionMap[] = [];
  for (const source of sources) {
    const opener = /export const (\w+Actions) = (?:defineAuditActions\()?\{/g;
    for (let match = opener.exec(source.text); match !== null; match = opener.exec(source.text)) {
      let depth = 1;
      let index = match.index + match[0].length;
      for (; index < source.text.length && depth > 0; index += 1) {
        if (source.text[index] === "{") depth += 1;
        else if (source.text[index] === "}") depth -= 1;
      }
      const body = source.text.slice(match.index + match[0].length, index - 1);
      const codes = [...body.matchAll(/^\s+(\w+):\s*"([^"]+)"/gm)].map(
        (member) => [member[1] as string, member[2] as string] as const,
      );
      // Every value an action code is what makes this an action map rather than any other record of
      // strings. A single prose value — a category description, a message template — disqualifies it.
      if (codes.length === 0 || !codes.every(([, code]) => ACTION_CODE.test(code))) continue;
      found.push({
        file: source.path
          .slice(REPO_ROOT.length + 1)
          .split(sep)
          .join("/"),
        name: match[1] as string,
        codes,
      });
    }
  }
  return found;
}

const SOURCES = sourceFiles(join(REPO_ROOT, "packages"));
const MAPS = actionMaps(SOURCES);

/**
 * The codes that are still declared and emitted by nothing, each with the issue that closes it.
 *
 * **This is a list, and it is meant to shrink.** The rule below is derived — a code added tomorrow is
 * checked tomorrow with nothing to remember — but a gate that cannot be introduced against a tree with
 * a known gap in it is a gate nobody lands. So the gap is written down, by name, with somewhere to read
 * why, and anything that is not on this list fails.
 *
 * **It is empty now, and that is the state to keep it in.** The gate found exactly one orphan on its first
 * run — `PaymentsAuditActions.webhookUnverified` — which was the whole argument for the gate: a declared
 * code with no producer is invisible until something looks. Fixing #296 emitted it and deleted the entry.
 *
 * An addition here is a deliberate act with an issue number attached, not a way past a red build.
 */
const KNOWN_ORPHANS: Record<string, string> = {
  // Empty, and this is the state to keep it in. `PaymentsAuditActions.webhookUnverified` was the one entry
  // — the gate found it on its first run — and #296 emitted it from `webhookGuard`, so the exception came
  // out with the fix, exactly as this comment said it would.
};

describe("every declared audit action code is emitted by something", () => {
  test("the scan finds the maps and their codes", () => {
    // Non-vacuity. A walk that matched no file, or a matcher that found no map, would make the rule
    // below pass forever — which is exactly the failure mode the rule exists to catch, one level up.
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(MAPS.length).toBeGreaterThanOrEqual(11);
    expect(MAPS.reduce((total, map) => total + map.codes.length, 0)).toBeGreaterThan(60);
  });

  test("every map is reachable by the name its use sites address it by", () => {
    // The rule below counts `Name.member`, so a map re-exported and used under an alias would read as
    // unemitted. None is, and this says so rather than leaving the rule's precision unstated.
    const unreferenced = MAPS.filter((map) => !SOURCES.some((source) => source.text.includes(`${map.name}.`))).map(
      (map) => `${map.name} (${map.file})`,
    );
    expect(unreferenced).toEqual([]);
  });

  test("no code is declared and then written by nothing", () => {
    const orphaned: string[] = [];
    for (const map of MAPS) {
      for (const [member, code] of map.codes) {
        const reference = `${map.name}.${member}`;
        // The declaration itself reads `member: "code"`, never `Map.member`, so the declaring file
        // counts like any other — a capability that declares and emits in one file (`TokenAuditActions`,
        // `ProvisionAuditActions`) is not an exception to be listed.
        if (SOURCES.some((source) => source.text.includes(reference))) continue;
        if (reference in KNOWN_ORPHANS) continue;
        orphaned.push(`${map.file}: ${reference} (${code}) is declared and emitted by nothing`);
      }
    }
    expect(orphaned).toEqual([]);
  });

  test("every written-down exception is still one", () => {
    // The other direction, so the list cannot outlive the gaps it excuses. A code that has since grown an
    // emit site has to come off, or the next one added under the same name is silently forgiven.
    const stale = Object.keys(KNOWN_ORPHANS).filter((reference) =>
      SOURCES.some((source) => source.text.includes(reference)),
    );
    expect(stale).toEqual([]);
  });
});
