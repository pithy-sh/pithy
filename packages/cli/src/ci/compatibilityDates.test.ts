// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "comment-json";
import { beforeAll, describe, expect, test } from "vitest";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * The gate. **Nothing in this repository runs on a compatibility date older than the one it chose.**
 *
 * #388: nine deployed kit Workers and seventeen workers test configs were pinned at `2025-01-01`,
 * fifteen months behind the runtime. None of them was a decision. A new capability's `wrangler.jsonc`
 * is written by copying a sibling's, so the first Worker's unconsidered default reached the ninth, and
 * every workers harness copied it in turn. That is a defect a review cannot catch, because each copy
 * looks exactly like the file beside it — which is the whole case for gating it.
 *
 * The floor is {@link https://github.com/pithy-sh/pithy/blob/main/compatibility.ts | `compatibility.ts`}
 * at the repository root, which carries the argument for the date as well as the date.
 *
 * **Loaded rather than read, wherever loading answers the question.** The floor itself is imported at
 * runtime — a static import cannot reach it, since `packages/cli/tsconfig.json` sets `rootDir` to this
 * package's `src` and a repository-root file is outside it (TS6059, the same wall `testIsolation.test.ts`
 * records). A `wrangler.jsonc` is parsed rather than pattern-matched, so a duplicate key resolves the way
 * wrangler will resolve it rather than the way a regex guesses.
 *
 * **The one place this reads text instead is the workers configs, and the reason is a probe rather than
 * a preference.** `cloudflareTest(options)` keeps its `miniflare` block in a closure: the plugin object
 * a loaded config hands back exposes `name`, `api`, `configureVitest`, `config`, `resolveId` and `load`,
 * and driving `configureVitest` yields a pool runner of `{ name, createPoolWorker }`. The date is not
 * reachable without starting workerd. So the assertion made about those files is a **stronger** one
 * instead: they must not state a date at all, they must import the floor — which leaves one value in the
 * tree for seventeen files, and nothing for a text scan to be wrong about.
 *
 * ## The one date this gate could not hold, and why it no longer exists
 *
 * `@pithy-sh/cloudflare`'s `workersManager` used to default an API-created Worker to `2026-04-07` when
 * the caller named none. It was past #385's fix, it was product behaviour with its own test, and it was
 * unreachable from here — this gate reads `wrangler.jsonc` manifests, and that was a TypeScript
 * constant. #388 named it rather than moving it in passing.
 *
 * #396 settled it by **removing the default rather than re-picking the number**. `createWorker` now
 * requires a compatibility date, so the caller states the behaviour contract for the Worker landing in
 * their account and there is no unchosen date left to drift below a floor. There is no exception to
 * this gate any more.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`; the anchor test below proves it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Where the floor is stated, and where a reader is sent to find out why it is that date. */
const FLOOR_MODULE = resolve(REPO_ROOT, "compatibility.ts");

/**
 * An ISO date sorts as a string, which is the only reason a floor can be a comparison rather than a
 * parse. `2025-01-01` < `2026-06-01` as text and as a date, and no compatibility date is written any
 * other way — {@link isIsoDate} refuses one that is, rather than comparing something that is not a date.
 */
function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** `path` under the repository root, in posix separators — how a failure names a file to edit. */
function named(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** Whether `path` is inside `templates/`, the tree `pithy init` copies into somebody else's repository. */
function isTemplate(path: string): boolean {
  return relative(REPO_ROOT, path).split(sep)[0] === "templates";
}

/** One Worker manifest, parsed as wrangler will parse it. */
interface Manifest {
  /** `packages/vector/src/workflows/wrangler.jsonc`. */
  readonly label: string;
  /** Its directory, for pairing a manifest with the harness that exercises it. */
  readonly dir: string;
  /** What it states, or `undefined` where it states nothing a date could be read from. */
  readonly date: string | undefined;
}

/** One workers test config, and how it comes by its date. */
interface Harness {
  /** `packages/vector/vitest.workers.config.ts`. */
  readonly label: string;
  /** Its directory — a package root, so every manifest below it is a Worker it is evidence about. */
  readonly dir: string;
  /** Whether it imports the floor rather than writing a date. Required of everything outside templates. */
  readonly derived: boolean;
  /** A date it wrote out, where it wrote one. A template must, having no `compatibility.ts` to import. */
  readonly date: string | undefined;
}

let floor = "";
let manifests: Manifest[] = [];
let harnesses: Harness[] = [];
let scaffolders: Array<{ label: string; date: string }> = [];

beforeAll(async () => {
  const module: unknown = await import(pathToFileURL(FLOOR_MODULE).href);
  const stated = (module as { COMPATIBILITY_DATE?: unknown }).COMPATIBILITY_DATE;
  if (!isIsoDate(stated)) throw new Error("compatibility.ts does not export an ISO COMPATIBILITY_DATE.");
  floor = stated;

  manifests = sourcePaths(REPO_ROOT, { keep: (name) => name === "wrangler.jsonc" }).map((path) => {
    const text = readSource(path) ?? "";
    const parsed: unknown = parse(text);
    const date = (parsed as { compatibility_date?: unknown } | null)?.compatibility_date;
    return { label: named(path), dir: dirname(path), date: isIsoDate(date) ? date : undefined };
  });

  harnesses = sourcePaths(REPO_ROOT, { keep: (name) => name === "vitest.workers.config.ts" }).map((path) => {
    const text = readSource(path) ?? "";
    const written = /compatibilityDate:\s*"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
    return {
      label: named(path),
      dir: dirname(path),
      derived: /from "\.\.\/\.\.\/compatibility"/.test(text) && /compatibilityDate:\s*COMPATIBILITY_DATE\b/.test(text),
      date: written,
    };
  });

  // A shipped module that writes a Worker manifest writes the date into it as text. `workerScaffold.ts`
  // is the one that matters — it stamps an adopter's first `wrangler.jsonc`, so a floor that moved
  // without it would leave every new adopter behind the kit. Test fixtures are excluded by
  // `isShippedSource`: a fixture asserting a date passes through unchanged is right to name any date.
  scaffolders = [];
  for (const path of sourcePaths(REPO_ROOT, { keep: isShippedSource })) {
    for (const match of (readSource(path) ?? "").matchAll(/"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/g)) {
      scaffolders.push({ label: named(path), date: match[1] as string });
    }
  }
}, 60_000);

describe("the walk itself", () => {
  test("this file is where it thinks it is, and the floor is where it says", () => {
    // Every path below is relative to this. A move that broke it would silently gate nothing.
    expect(readSource(resolve(REPO_ROOT, "package.json"))).toContain('"@pithy-sh/monorepo"');
    expect(floor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("it finds both populations — a tripwire that matches nothing is not a tripwire", () => {
    // Nine kit Workers and the starter's, and seventeen workers harnesses plus the starter's. Written as
    // floors rather than counts: a tenth Worker should be gated, not reported as a broken walk.
    expect(manifests.length).toBeGreaterThanOrEqual(10);
    expect(harnesses.length).toBeGreaterThanOrEqual(18);
    expect(scaffolders.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * **Every Worker manifest in this tree states a date, and none of them is behind the floor.**
 *
 * Stated about the manifest rather than about the deploy, because the manifest is what a new capability
 * copies. `templates/starter`'s is held to the same floor deliberately: it is an adopter's Worker, and
 * the argument for `2026-06-01` is precisely that the kit's own Workers run what its adopters run.
 */
describe("no Worker manifest is behind the floor", () => {
  test("every wrangler.jsonc states a compatibility date", () => {
    const silent = manifests.filter((manifest) => manifest.date === undefined).map((manifest) => manifest.label);
    // A manifest with no date is not a manifest on an old date — it is one wrangler dates for itself,
    // at whatever the CLI's own default happens to be on the day of the deploy. Worse than stale.
    expect(silent).toEqual([]);
  });

  test("and none of them is older than compatibility.ts", () => {
    const behind = manifests
      .filter((manifest) => manifest.date !== undefined && manifest.date < floor)
      .map((manifest) => `${manifest.label}: ${manifest.date} is behind ${floor}`);
    expect(behind).toEqual([]);
  });
});

/**
 * **Every workers harness takes the floor from `compatibility.ts` rather than writing one down.**
 *
 * This is what stops #388 recurring in the population that caused #385 to cost a day. Seventeen configs
 * held seventeen copies of one number, and the copy nobody moved was the one holding the evidence.
 *
 * `templates/starter` is the exception, and it is structural: the file is copied into an adopter's
 * repository, where `compatibility.ts` does not exist. So it writes the date, and is held to the floor
 * by text instead — the only file in the tree where a copy is the correct answer.
 */
describe("no workers harness writes its own date", () => {
  test("every harness in this repository imports the floor", () => {
    const underived = harnesses
      .filter((harness) => !isTemplate(harness.dir))
      .filter((harness) => !harness.derived)
      .map((harness) => harness.label);
    expect(underived).toEqual([]);
  });

  test("and none of them states a date beside it", () => {
    const stated = harnesses
      .filter((harness) => !isTemplate(harness.dir))
      .filter((harness) => harness.date !== undefined)
      .map((harness) => `${harness.label}: ${harness.date}`);
    expect(stated).toEqual([]);
  });

  test("a template harness writes one, because it has nothing to import, and it is not behind", () => {
    const templates = harnesses.filter((harness) => isTemplate(harness.dir));
    // The inverse, asserted: a rule applied everywhere would demand an import an adopter cannot resolve,
    // and a template that quietly stopped stating a date would fall to vitest's own default unnoticed.
    expect(templates.length).toBeGreaterThanOrEqual(1);
    const wrong = templates
      .filter((harness) => harness.date === undefined || harness.date < floor)
      .map((harness) => `${harness.label}: ${String(harness.date)}`);
    expect(wrong).toEqual([]);
  });
});

/**
 * **A harness is never older than the Worker it is evidence about (#385).**
 *
 * The day #385 cost was spent on a phantom `unhandledrejection` that no deployed Worker could produce,
 * because the only thing still running the pre-fix runtime was the harness. A suite pinned behind its
 * subject does not test the subject; it tests a runtime nothing runs on, and reports the difference as
 * a defect in the code.
 *
 * With every harness on the floor and every manifest at or above it, this pins the manifests in packages
 * that have a harness to the floor exactly — and that is the intended consequence rather than a
 * side effect. **The only way to give one Worker a newer date is to move the floor**, which moves its
 * harness with it and every other suite in the tree at the same time. A Worker allowed to run ahead
 * alone is the shape this whole file exists to refuse.
 */
describe("no harness is behind a Worker it exercises", () => {
  test("every manifest under a harness is at that harness's date, not past it", () => {
    const ahead: string[] = [];
    for (const harness of harnesses) {
      const harnessDate = isTemplate(harness.dir) ? harness.date : floor;
      if (harnessDate === undefined) continue;
      for (const manifest of manifests) {
        if (!manifest.dir.startsWith(`${harness.dir}${sep}`)) continue;
        if (manifest.date !== undefined && manifest.date > harnessDate) {
          ahead.push(`${manifest.label}: ${manifest.date} is past ${harness.label} at ${harnessDate}`);
        }
      }
    }
    expect(ahead).toEqual([]);
  });

  test("and the pairing found the Workers it was meant to, rather than pairing nothing", () => {
    // Vacuity again. Every assertion above is over a nested filter, and a `dir` that stopped matching
    // would satisfy all of them in silence while gating no Worker at all.
    const paired = manifests.filter((manifest) =>
      harnesses.some((harness) => manifest.dir.startsWith(`${harness.dir}${sep}`)),
    );
    expect(paired.length).toBeGreaterThanOrEqual(10);
  });
});

/**
 * **A module that scaffolds a Worker manifest scaffolds it onto the floor.**
 *
 * `cli/src/project/workerScaffold.ts` stamps the `wrangler.jsonc` an adopter gets from `pithy worker add`,
 * and `templates/starter` is what `pithy init` copies. If the floor moved and those did not, every Worker
 * created after the move would start behind the kit — which is #388's own mechanism, aimed outward.
 */
describe("what the CLI scaffolds is not behind the floor", () => {
  test("every date a shipped module writes into a manifest is at or past it", () => {
    const behind = scaffolders
      .filter((scaffolder) => scaffolder.date < floor)
      .map((scaffolder) => `${scaffolder.label}: ${scaffolder.date} is behind ${floor}`);
    expect(behind).toEqual([]);
  });
});
