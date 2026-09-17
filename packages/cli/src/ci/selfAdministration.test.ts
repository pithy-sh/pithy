// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  environmentScope,
  featureScope,
  type ProvisionScope,
  type ProvisionWorkerNames,
} from "@pithy-sh/core/src/naming/provisionScope";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { SELF_BINDING } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { provisionConfigPath } from "../provision/featureConfig";
import { applyProvisionedEnv } from "../provision/wranglerEnv";
import { sourceFiles } from "./sourceFiles";

/**
 * **Every stanza provisioning generates for a self-administering project binds `SELF` to that stanza's own
 * script** (#616).
 *
 * A Worker cannot fetch its own hostname — the subrequest loops back through the edge into the Worker it
 * came from and hangs until Cloudflare answers 522 — so the binding is what makes a self-administering
 * deployment work at all. The failure mode if it is written wrong is the one worth building a gate over:
 * a `services` entry naming a script nobody deploys provisions clean, reports success, and refuses at
 * runtime, in whichever environment nobody tried.
 *
 * **A rule about one environment would be the wrong rule.** The name a Worker deploys under is composed
 * differently per scope — a declared environment reads the name its stanza already carries and falls back
 * to wrangler's `<script>-<env>`, a feature composes `<project>-f<issue>-<slug>-<app>` from the directory
 * (#580, #587) — and it is the *feature* whose stanza is regenerated on every run and so can only ever
 * carry what this writer puts there. So the gate has the reach the rule has, in three halves:
 *
 * 1. **The scopes are every scope the kit has.** {@link SCOPES} is compared against the `ProvisionScope`
 *    factories `provisionScope.ts` exports, so a third scope joins this gate the day it is written rather
 *    than whenever somebody remembers.
 * 2. **Each of them, through the real writer, binds `SELF` to the name the scope itself composes.** The
 *    expected value comes from `scope.worker(...)` — core's own answer, independent of the writer — never
 *    from the file the writer just wrote, which would make the assertion agree with any defect.
 * 3. **One module writes it.** A second composer of that name anywhere in the CLI is the shape #580 and
 *    #587 both closed: two producers of one address, agreeing until the day they do not.
 *
 * Half 2 alone would pass a writer that also wrote the binding into some *other* stanza from some other
 * name; half 3 alone would pass a single writer composing it wrongly. Half 1 is what keeps either from
 * being true of only the environments somebody thought of.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/**
 * Core's scope module, climbed to from **this file's own directory**.
 *
 * Spelled as one run of literals from `import.meta.dirname` rather than through `CLI_SRC`, because
 * `.github/scripts/crossPackageReads.ts` resolves exactly this run against the file that holds it — a
 * path assembled from a variable resolves to nothing there, and a gate that reads another package while
 * CI plans it as reading only its own is the defect that register exists to find.
 */
const PROVISION_SCOPE = join(import.meta.dirname, "..", "..", "..", "core", "src", "naming", "provisionScope.ts");

/** `pithy init replay --worker board`: the directory says `board`, the deploy name `replay-board`. */
const BOARD: ProvisionWorkerNames = { app: "board", script: "replay-board" };

/** Every scope a provisioning run can happen in, by the name of the factory that builds it. */
const SCOPES: Record<string, ProvisionScope> = {
  environmentScope: environmentScope("replay", "staging"),
  featureScope: featureScope({ project: "replay", issue: "616", slug: "self" }),
};

/**
 * The `ProvisionScope` factories core exports, read from the module rather than from a list kept here.
 *
 * **What it sees, said plainly, because a gate claiming more reach than it has is worse than a narrow
 * one.** It reads one module — `provisionScope.ts`, where both scopes live and where the type is declared
 * — and one spelling in it: an exported function whose return type is written `ProvisionScope`. A factory
 * declared somewhere else, or returning a `Promise<ProvisionScope>`, is a hole. Closing those wants a type
 * checker rather than a wider regex, and the two assertions below hold whatever this list contains: a
 * scope absent from here is a scope nothing exercises, which is the state this half exists to make loud.
 */
function scopeFactories(source: string): string[] {
  const code = blankComments(source);
  return [...code.matchAll(/export function (\w+)\([^)]*\)\s*:\s*ProvisionScope/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

/** Every module that mentions the self binding's name at all, so the writer cannot quietly become two. */
function mentionsSelfBinding(source: string): boolean {
  return /\bSELF_BINDING\b/.test(blankComments(source));
}

/**
 * The modules allowed to name the self binding, each with the reason it is the one doing it.
 *
 * The doctor check is a reader — it asks whether a stanza already carries the binding and writes nothing —
 * and it is on the list because "mentions the name" is the decidable question. A module that composes a
 * second self entry has to name the constant to do it, and one that composes it without the constant fails
 * the behavioral half the moment the spelling differs.
 */
const SELF_BINDING_MODULES = new Map<string, string>([
  ["provision/wranglerEnv.ts", "the writer — it composes the entry from the `name` it writes in the same edit"],
  ["doctor/selfBinding.ts", "the reader — it reports a declared project whose stanza does not carry it"],
]);

describe("a self-administering project's stanza binds SELF to its own script", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-self-gate-"));
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "replay-board"\n}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the scopes here are every scope the kit provisions in", async () => {
    const source = await readFile(PROVISION_SCOPE, "utf8");
    const factories = scopeFactories(source);
    // Non-vacuity first: an extractor that found nothing would make the comparison below green and empty.
    expect(factories).toContain("featureScope");
    expect(
      factories,
      "A new ProvisionScope is a new set of generated stanzas. Exercise it here, or a self-administering project deploys into it with no way to reach itself.",
    ).toEqual(Object.keys(SCOPES).sort());
  });

  test.each(Object.entries(SCOPES))("%s writes the binding, named for what that scope deploys as", async (_, scope) => {
    await applyProvisionedEnv({
      workerDir: dir,
      worker: BOARD,
      scope,
      resources: [],
      services: [],
      secrets: [],
      administersItself: true,
    });

    const written = parse(await readFile(provisionConfigPath(dir, scope.source), "utf8")) as unknown as {
      env: Record<string, { name?: string; services?: { binding: string; service: string }[] } | undefined>;
    };
    const stanza = written.env[scope.stanza];
    // Core's own answer for this scope, computed here rather than read back out of the file the writer
    // wrote — a gate taking both sides from its own subject agrees with every defect it exists to catch.
    const expected = scope.worker(BOARD, stanza?.name);
    expect(stanza?.services).toEqual([{ binding: SELF_BINDING, service: expected }]);
    expect(stanza?.name).toBe(expected);
  });

  test("and nothing at all when the project does not declare it", async () => {
    for (const scope of Object.values(SCOPES)) {
      await applyProvisionedEnv({
        workerDir: dir,
        worker: BOARD,
        scope,
        resources: [],
        services: [],
        secrets: [],
        administersItself: false,
      });
      const written = parse(await readFile(provisionConfigPath(dir, scope.source), "utf8")) as unknown as {
        env: Record<string, { services?: unknown } | undefined>;
      };
      expect(written.env[scope.stanza]?.services).toBeUndefined();
    }
  });

  test("only these modules name the self binding", () => {
    // The shared walk (#185), never a hand-rolled one. It is the CLI's own source and not its tests,
    // which is the set the rule is about: a suite naming the constant is asserting about it.
    const files = sourceFiles(CLI_SRC);
    const named = (path: string): string => relative(CLI_SRC, path).split("\\").join("/");
    expect(files.length).toBeGreaterThanOrEqual(185);
    const modules = files
      .filter((file) => mentionsSelfBinding(file.text))
      .map((file) => named(file.path))
      .sort();
    expect(
      modules,
      "The self binding names the script its own stanza deploys as, and that string is decided in provision/wranglerEnv.ts. A second composer of it is two producers of one address — see #580 and #587.",
    ).toEqual([...SELF_BINDING_MODULES.keys()].sort());
  });
});
