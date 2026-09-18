// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { compareVersions } from "../notifier/version";
import { packageDirFrom } from "../project/kitResolve";
import { readOptionalFile } from "../project/readOptionalFile";
import { reactStub } from "../ui/react";
import type { UiStubContext } from "../ui/stubs";
import { substitute } from "../ui/templates";
import { readWorkerUi } from "../ui/workerUi";
import type { PackagePlan } from "./plan";
import { candidateVersions, newestAdmitted, parseRange } from "./ranges";
import { fetchPackument, fetchTarball, type Packument, type RegistryFetch } from "./registry";
import { readTemplateTarball } from "./tarball";

/**
 * **Which of the files a Worker copied from a template changed upstream in the move this run makes.**
 *
 * `pithy ui add` copies `@pithy-sh/ui-react`'s templates into `apps/<worker>/` and records nothing about
 * it. So this does not ask what was copied; it diffs. Every path whose content differs between a version
 * the project has installed now (F) and the version it is moving to (T) is a candidate, and the Worker's
 * own file at that path is compared against both sides: equal to T is already current, equal to an F
 * version is an untouched copy, anything else is edited and has to be merged by hand.
 *
 * **The report runs on every move of the template-bearing package, not only a breaking one.** The refusal
 * code #634 was filed about moved in the 0.3.0 → 0.3.1 *patch*, so a report limited to breaking moves
 * would have missed the one failure it exists to name.
 *
 * **The templates come from the CLI's ui-react, not the adopter's**, because `ui/react.ts` imports its
 * template directory from its own dependency. So F reads both: any ui-react installed under the project,
 * and the one each installed `@pithy-sh/cli` copy resolves. The running CLI's own copy is not in F — a
 * global CLI says nothing about what this project scaffolded.
 *
 * Nothing here rewrites a file. The copies are the project's.
 */

/** The package whose templates are reported. */
export const TEMPLATE_PACKAGE = "@pithy-sh/ui-react";
const CLI = "@pithy-sh/cli";

/** A template tree: source path below `templates/` → raw text. */
export type TemplateTree = ReadonlyMap<string, string>;

/** One file one Worker should look at. */
export interface TemplateFinding {
  /** The Worker, by directory name. */
  worker: string;
  /** The file, relative to the Worker. */
  path: string;
  /** What happened upstream: changed, new in the target, or gone from it. */
  change: "changed" | "added" | "removed";
  /** What the Worker holds: an untouched copy, an edited one, nothing, or a file the target dropped. */
  copy: "untouched" | "edited" | "absent" | "present";
  /** For an untouched copy: which version it is a copy of. */
  from?: string;
}

/** One target version's report. */
export interface TemplateSection {
  /** `checked`, `unchecked` when nothing is installed to compare from, `unavailable` when T would not read. */
  state: "checked" | "unchecked" | "unavailable";
  package: typeof TEMPLATE_PACKAGE;
  /** The installed versions compared from, ascending. */
  from: string[];
  /** The version compared to, or `null` when it could not be resolved. */
  to: string | null;
  /** Whether this run installs `to`, as opposed to reporting what `--latest` would. */
  applied: boolean;
  files: TemplateFinding[];
}

/** A scaffold context with every screen set on, for asking the stub what it would write and how. */
function everything(worker: string, auth: boolean): UiStubContext {
  return { worker, auth, payments: true, organization: true, packageManager: "npm" };
}

/**
 * The sources the React stub writes somewhere other than their own path — the two home screens, today —
 * asked of the stub itself, with and without auth, so this never keeps a second copy of the answer.
 */
const MOVED_SOURCES: ReadonlyMap<string, string> = new Map(
  [true, false]
    .flatMap((auth) => reactStub.manifest(everything("_", auth)))
    .filter((file) => file.source !== file.target)
    .map((file) => [file.source, file.target]),
);

/** Where a source file lands in a Worker. */
function targetOf(source: string): string {
  return MOVED_SOURCES.get(source) ?? source;
}

/** Line endings and a trailing newline are not a change anybody made on purpose. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/** A tree keyed by target path, each holding every source that lands there, normalized. */
function byTarget(tree: TemplateTree): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [source, text] of tree) {
    const target = targetOf(source);
    out.set(target, [...(out.get(target) ?? []), normalize(text)].sort());
  }
  return out;
}

/** Whether two targets' content sets differ. Absence is a value. */
function differs(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a !== b;
  return a.length !== b.length || a.some((text, i) => text !== b[i]);
}

const ORDER = { changed: 0, removed: 1, added: 2 } as const;

/** Classify every Worker's copy of every path that differs between F and T. Pure. */
export function classifyTemplates(input: {
  from: ReadonlyMap<string, TemplateTree>;
  to: { version: string; tree: TemplateTree };
  workers: readonly { name: string; files: ReadonlyMap<string, string> }[];
}): TemplateFinding[] {
  const target = byTarget(input.to.tree);
  // Newest first, so an untouched copy is attributed to the latest version it matches.
  const from = [...input.from]
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([v, tree]) => [v, byTarget(tree)] as const);
  const paths = [...new Set([...target.keys(), ...from.flatMap(([, tree]) => [...tree.keys()])])].sort();
  const findings: TemplateFinding[] = [];
  for (const worker of input.workers) {
    const tokens = reactStub.substitutions(everything(worker.name, true));
    const render = (text: string) => normalize(substitute(text, tokens));
    for (const path of paths) {
      const t = target.get(path);
      if (!from.some(([, tree]) => differs(tree.get(path), t))) continue;
      const held = worker.files.get(path);
      const copy = held === undefined ? undefined : normalize(held);
      const inFrom = from.some(([, tree]) => tree.has(path));
      if (t === undefined) {
        if (copy !== undefined) findings.push({ worker: worker.name, path, change: "removed", copy: "present" });
        continue;
      }
      if (copy === undefined) {
        if (!inFrom) findings.push({ worker: worker.name, path, change: "added", copy: "absent" });
        continue;
      }
      if (t.some((text) => render(text) === copy)) continue; // already current
      const match = from.find(([, tree]) => (tree.get(path) ?? []).some((text) => render(text) === copy));
      findings.push(
        match
          ? { worker: worker.name, path, change: "changed", copy: "untouched", from: match[0] }
          : { worker: worker.name, path, change: "changed", copy: "edited" },
      );
    }
  }
  return findings.sort(
    (a, b) => a.worker.localeCompare(b.worker) || ORDER[a.change] - ORDER[b.change] || a.path.localeCompare(b.path),
  );
}

/** A section's target version, and whether this run installs it. `null` when it could not be resolved. */
export interface TemplateTarget {
  version: string | null;
  applied: boolean;
}

/** The newest version of `name` in `plan`'s moves, or `null`. */
function movedTo(plan: PackagePlan, name: string): string | null {
  const targets = plan.moves.filter((move) => move.name === name).map((move) => move.target);
  return targets.sort(compareVersions).at(-1) ?? null;
}

/** The `latest` a held entry for `name` names, or `null`. */
function heldAt(plan: PackagePlan, name: string): string | null {
  return plan.held.find((entry) => entry.name === name)?.latest ?? null;
}

/**
 * The versions to report against: at most two, the one this run installs (`applied`) and the one only
 * `--latest` would (`!applied`).
 *
 * A declared ui-react that moves or is held decides it directly. Otherwise a moving or held CLI does,
 * through the ui-react range *that* CLI version declares — the templates `pithy ui add` would copy after
 * the move come from exactly there. Neither moving is no section at all.
 */
export function templateTargets(input: {
  plan: PackagePlan;
  ui: Packument | null | undefined;
  cli: Packument | null | undefined;
}): TemplateTarget[] {
  const pairs = (moved: string | null, held: string | null, resolve: (v: string) => string | null) => {
    const out: TemplateTarget[] = [];
    if (moved) out.push({ version: resolve(moved), applied: true });
    if (held) out.push({ version: resolve(held), applied: false });
    return out;
  };
  const ui = pairs(movedTo(input.plan, TEMPLATE_PACKAGE), heldAt(input.plan, TEMPLATE_PACKAGE), (v) => v);
  if (ui.length > 0) return ui;
  return pairs(movedTo(input.plan, CLI), heldAt(input.plan, CLI), (cliVersion) => {
    const declared = input.cli?.versions[cliVersion]?.dependencies?.[TEMPLATE_PACKAGE];
    const range = declared === undefined ? null : parseRange(declared);
    if (!range || !input.ui) return null;
    return newestAdmitted(
      range,
      candidateVersions({ latest: input.ui["dist-tags"].latest, versions: input.ui.versions }),
    );
  });
}

/**
 * Every regular file under an installed copy's `templates/`, keyed by path relative to it. Node walks the
 * tree; a copy with no `templates/` is an empty tree, and a file that will not read fails the run by name.
 */
async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readOptionalFile(path);
    if (text !== null) out.set(relative(dir, path).split(sep).join("/"), text);
  }
  return out;
}

/** The version a package directory declares, or `null` when there is no package there. */
async function versionAt(dir: string): Promise<string | null> {
  const raw = await readOptionalFile(join(dir, "package.json"));
  if (raw === null) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null; // not a package this can name a version for
  }
  const version = typeof doc === "object" && doc !== null ? (doc as { version?: unknown }).version : undefined;
  return typeof version === "string" ? version : null;
}

/** `projectDir` and each `apps/*` directory. */
async function bases(projectDir: string): Promise<string[]> {
  try {
    const apps = (await readdir(join(projectDir, "apps"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectDir, "apps", entry.name))
      .sort();
    return [projectDir, ...apps];
  } catch {
    return [projectDir];
  }
}

/**
 * The ui-react copies installed now, by version: each base's own `node_modules/@pithy-sh/ui-react`, and the
 * one each installed CLI resolves from where it really lives. The first copy of a version wins.
 */
export async function installedTemplateCopies(projectDir: string): Promise<Map<string, string>> {
  const dirs: string[] = [];
  for (const base of await bases(projectDir)) {
    dirs.push(join(base, "node_modules", ...TEMPLATE_PACKAGE.split("/")));
    try {
      const cli = await realpath(join(base, "node_modules", ...CLI.split("/")));
      const resolved = packageDirFrom(cli, TEMPLATE_PACKAGE);
      if (resolved) dirs.push(resolved);
    } catch {
      // No CLI installed here.
    }
  }
  const copies = new Map<string, string>();
  for (const dir of dirs) {
    const version = await versionAt(dir);
    if (version !== null && !copies.has(version)) copies.set(version, dir);
  }
  return copies;
}

/** Each Worker with a React front end, by name and directory. */
async function uiWorkers(projectDir: string): Promise<{ name: string; dir: string }[]> {
  const out: { name: string; dir: string }[] = [];
  for (const dir of (await bases(projectDir)).slice(1)) {
    try {
      if ((await readWorkerUi(dir))?.stub === "react") out.push({ name: basename(dir), dir });
    } catch {
      // A manifest that will not read is not a front end this can compare.
    }
  }
  return out;
}

/** What a Worker holds at each path, absent paths omitted. */
async function workerFiles(dir: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of paths) {
    if (path.split("/").includes("..")) continue;
    // Absent is a value here. Anything else — a directory where a file was, a file that will not open —
    // is a fault the adopter has to see, not a copy to call missing.
    const text = await readOptionalFile(join(dir, path));
    if (text !== null) out.set(path, text);
  }
  return out;
}

/**
 * The template report for this plan: one section per {@link templateTargets} entry, read before anything is
 * installed. T is read from a local copy at exactly that version when there is one, and from the verified
 * tarball otherwise.
 */
export async function templateSections(options: {
  projectDir: string;
  plan: PackagePlan;
  packuments: ReadonlyMap<string, Packument>;
  fetch?: RegistryFetch;
}): Promise<TemplateSection[]> {
  const fetchOptions = options.fetch ? { fetch: options.fetch } : {};
  let ui = options.packuments.get(TEMPLATE_PACKAGE) ?? null;
  const cli = options.packuments.get(CLI) ?? null;
  const cliMoves = movedTo(options.plan, CLI) !== null || heldAt(options.plan, CLI) !== null;
  if (!ui && cliMoves) ui = await fetchPackument(TEMPLATE_PACKAGE, fetchOptions);
  const targets = templateTargets({ plan: options.plan, ui, cli });
  if (targets.length === 0) return [];

  const copies = await installedTemplateCopies(options.projectDir);
  const from = [...copies.keys()].sort(compareVersions);
  const trees = new Map<string, TemplateTree>();
  for (const [version, dir] of copies) trees.set(version, await readTree(join(dir, "templates")));
  const workers = await uiWorkers(options.projectDir);

  const sections: TemplateSection[] = [];
  for (const target of targets) {
    const base = {
      package: TEMPLATE_PACKAGE,
      from,
      to: target.version,
      applied: target.applied,
      files: [] as TemplateFinding[],
    } as const;
    if (target.version === null) {
      sections.push({ ...base, state: "unavailable" });
      continue;
    }
    if (from.length === 0) {
      sections.push({ ...base, state: "unchecked" });
      continue;
    }
    let tree = trees.get(target.version);
    if (!tree) {
      const published = ui?.versions[target.version];
      const bytes =
        published?.dist.integrity === undefined ? null : await fetchTarball(published.dist.tarball, fetchOptions);
      const read = bytes && published?.dist.integrity ? readTemplateTarball(bytes, published.dist.integrity) : null;
      if (read?.state !== "read") {
        sections.push({ ...base, state: "unavailable" });
        continue;
      }
      tree = read.files;
    }
    const known = [
      ...new Set([...byTarget(tree).keys(), ...[...trees.values()].flatMap((t) => [...byTarget(t).keys()])]),
    ];
    const held = await Promise.all(
      workers.map(async (worker) => ({ name: worker.name, files: await workerFiles(worker.dir, known) })),
    );
    sections.push({
      ...base,
      state: "checked",
      files: classifyTemplates({ from: trees, to: { version: target.version, tree }, workers: held }),
    });
  }
  return sections;
}
