// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { CLOUDFLARE_ENV_KEYS, parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { type DevSecretEnvelope, initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { cloudflareConfigPath, parseCloudflareConfig, writeCloudflareConfig } from "../cloudflare/config";
import { readBootstrapVars, writeBootstrapVars } from "../devSecrets/bootstrapVars";
import { readDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { devSecretsFile } from "../devSecrets/location";
import { type DevSecretsTarget, devSecretsTargets } from "../devSecrets/targets";
import { type CheckDevVarsOptions, checkDevVars, type RootDevVar } from "../doctor/devVars";
import type { StatePathOptions } from "../notifier/state";
import { loadProject, requireProjectName } from "../project/config";
import { readOptionalFile } from "../project/readOptionalFile";
import { devPreferencesPath } from "../seed/prepare";
import { mintedTokensPath, readMintedTokens, writeMintedToken } from "../tokens/mintedTokens";

/**
 * `pithy adopt` — the sort `pithy doctor` reports, performed (#187).
 *
 * Every project that predates #175, #179 and #182 holds the same four-way mess: a root `.dev.vars`
 * carrying Cloudflare credentials the CLI stopped reading there, registry secrets nothing resolves from
 * it, a dev binding no Worker reads, and a key nothing composes at all — beside a `.dev.vars.<env>`
 * holding a live minted token inside the checkout, and a `dev.json` still carrying the copy `pithy seed`
 * used to make. `doctor` names every one of them and where it belongs. Until this command, moving them
 * was an adopter's afternoon with four destination formats to get right by hand.
 *
 * **Nothing is ever deleted from a source file, by this command or any other.** It copies, and then
 * reports what is now safe to remove; the adopter deletes. #142 was a run that rewrote an adopter's
 * `.dev.vars` and destroyed gitignored secrets with no copy anywhere, and a move that loses a secret has
 * no undo. That is the constraint every other decision here is downstream of — including the awkward one,
 * which is that a clean second run still lists the same keys, because they are still in the file.
 *
 * **A dry run is the default.** `pithy adopt` prints the plan and touches nothing; `pithy adopt --apply`
 * performs it, printing the same plan first. There is no prompt: a confirmation an agent cannot answer is
 * a command an agent cannot run, and the two-invocation shape is the one that reads the same in a terminal
 * and in CI.
 *
 * **A value that differs from the one already at its destination is refused, never overwritten.** Two
 * different values under one name is exactly the state that produces "which one signed this?", and picking
 * one silently is how a project ends up with a secret nobody can account for. The refusal is per key: the
 * other nine still move, because blocking them would leave the adopter with nothing to do but the thing
 * that is already hard.
 *
 * **The classification is `doctor`'s, not a second one.** {@link checkDevVars} decides what each root key
 * is, over a `switch` with no `default`, and this reads that verdict. A private classifier here would be a
 * second answer to "what is this key", and the two would disagree on the first key class either of them
 * learned about — which is the defect #178 was reported about, one module along.
 *
 * **Nothing this module returns or prints carries a value.** Names, paths, environments and verdicts only,
 * on every path including the refusals. The destinations hold the master key.
 */

/** Why a value is where it is, and therefore where it goes. Doctor's four states, plus the minted one. */
export const ADOPT_KINDS = [
  /** One of `CLOUDFLARE_ENV_KEYS` in the root `.dev.vars`. Account-scoped: `<config>/cloudflare.json`. */
  "credential",
  /** A secret some Worker's registry declares, whatever its backend: `<config>/<project>/secrets.jsonc`. */
  "secret",
  /** A name a Worker needs as a binding but no registry declares — a Turnstile sitekey. `dev.json`, `vars`. */
  "binding",
  /** A credential the old `dev-vars` token sink left in `.dev.vars.<env>`: `<config>/<project>/tokens.json`. */
  "token",
  /** Nothing reads it: not a credential, not declared by anything this project composes. It goes nowhere. */
  "unread",
] as const;

/** What one value is. See {@link ADOPT_KINDS}. */
export type AdoptKind = (typeof ADOPT_KINDS)[number];

/** What this run will do, or did, with one value. */
export const ADOPT_ACTIONS = [
  /** Copy it to its destination — planned on a dry run, done on an applied one. */
  "copy",
  /** The destination already holds this exact value. Nothing is written and nothing is re-copied. */
  "present",
  /** The destination holds a *different* value under this name. Refused: two values, one name. */
  "conflict",
  /** It cannot be placed — no project name to key a path on, or a `json` secret whose text is not JSON. */
  "refused",
  /** Nothing composes it, so there is nowhere for it to go. Named, and left exactly where it is. */
  "leave",
] as const;

/** What this run will do with one value. See {@link ADOPT_ACTIONS}. */
export type AdoptAction = (typeof ADOPT_ACTIONS)[number];

/** One value in the plan: what it is, where it is, where it goes, and what happens to it. Never its value. */
export interface AdoptEntry {
  /** The variable or secret name, as the adopter wrote it. */
  key: string;
  /** The absolute path of the file it is in now. Read, never written. */
  source: string;
  /** The environment a minted token was minted for, or `null` for everything else. */
  env: string | null;
  /** What this value is, and so which destination owns it. */
  kind: AdoptKind;
  /** The absolute path it belongs in, or `null` when nothing composes it. */
  destination: string | null;
  /** What this run did with it, or would do. */
  action: AdoptAction;
  /** Why it was refused, in one sentence. `null` when it was not. Never a value. */
  reason: string | null;
  /**
   * Whether there is now a copy at the destination, so the source line can go.
   *
   * **False for a `leave`**, which is the case worth stating: nothing reads that key, but nothing holds a
   * copy of it either, so this command will not call it safe to remove. Doctor's sentence — nothing reads
   * it, delete it — is the adopter's decision to act on, made with the value in front of them.
   */
  safeToRemove: boolean;
}

/** What one `pithy adopt` run planned, and did. */
export interface AdoptResult {
  /** The project root the plan was built for. */
  projectDir: string;
  /** The project's name, from the root `pithy.config.ts`, or `null` when it has none to key a path on. */
  project: string | null;
  /** Whether this run was allowed to write. `false` is the default, and writes nothing at all. */
  applied: boolean;
  /** Every value found, sorted by source then key. Total: one entry per key in every source file. */
  entries: AdoptEntry[];
}

/** What {@link runAdopt} needs. Every seam defaults to the real project. */
export interface RunAdoptOptions {
  /** The project root — owner of `.dev.vars`, `.dev.vars.<env>`, and of the project's name. */
  projectDir: string;
  /** Write. Defaults to `false`, which is the whole safety of the default invocation. */
  apply?: boolean;
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test writes its own. */
  paths?: StatePathOptions;
  /** The Workers whose registries declare the secrets. Defaults to every one composing `secrets`. */
  targets?: DevSecretsTarget[];
  /**
   * The Workers whose required bindings and `wrangler.jsonc` `vars` decide what a `binding` key is.
   * Defaults to every Worker under `apps/`. Forwarded verbatim to {@link checkDevVars}, which is what
   * keeps the classification here identical to the one `pithy doctor` printed.
   */
  workers?: CheckDevVarsOptions["workers"];
  /**
   * Handed the plan once it is built and **before a single byte is written**. The command prints from it.
   *
   * A callback rather than a returned plan the caller then applies, because the values have to stay inside
   * this module: a plan a caller could apply is a plan carrying the values, and one `JSON.stringify` of it
   * in a log is every secret in the project.
   */
  onPlan?: (entries: AdoptEntry[]) => void;
}

/**
 * Build the plan, hand it over, and — only when asked — perform it.
 *
 * Throws when a *destination* is there and will not open. That is the one failure worth stopping for:
 * every one of these writers does a read-modify-write over a credential file, and "it would not open"
 * answered as "there is nothing in it" is how a `tokens.json` holding four environments is replaced by
 * one holding the token being written. The refusal is {@link readOptionalFile}'s, in each writer's words.
 */
export async function runAdopt(options: RunAdoptOptions): Promise<AdoptResult> {
  const paths = options.paths ?? {};
  const project = await projectName(options.projectDir);
  const targets = options.targets ?? (await devSecretsTargets(options.projectDir).catch(() => []));
  const registry = mergedRegistry(targets);

  const sources = await collect(options.projectDir, paths, targets, options.workers);
  const destinations = await load(options.projectDir, project, paths);
  const { entries, pending } = plan(sources, destinations, registry, project, paths);

  options.onPlan?.(entries);
  if (options.apply === true) await write(options.projectDir, project, entries, pending, paths);

  return { projectDir: options.projectDir, project, applied: options.apply === true, entries };
}

/** One value found in a source file, with its value. **Never leaves this module.** */
interface Source {
  key: string;
  value: string;
  path: string;
  env: string | null;
  kind: AdoptKind;
}

/** What is already at each destination, read once so the plan and the write agree about what was there. */
interface Destinations {
  cloudflare: Record<string, string>;
  secrets: Record<string, DevSecretEnvelope>;
  bootstrap: Record<string, string>;
  tokens: Record<string, Record<string, string>>;
}

/** The project's `name`, or `null` — three of the four destinations are keyed on it and one is not. */
async function projectName(projectDir: string): Promise<string | null> {
  try {
    return requireProjectName(await loadProject(projectDir));
  } catch {
    // A probe, not a read: nothing is written from this, and the plan reports every per-project
    // destination as refused by name rather than guessing a directory to put a credential in.
    return null;
  }
}

/** Every Worker's registry, merged by secret name — the same join `pithy secrets` does. */
function mergedRegistry(targets: DevSecretsTarget[]): Record<string, { valueType: string }> {
  const merged: Record<string, { valueType: string }> = Object.create(null) as Record<string, { valueType: string }>;
  for (const target of targets) for (const [name, entry] of Object.entries(target.registry)) merged[name] = entry;
  return merged;
}

/**
 * Every value in every source, classified.
 *
 * The root file's classification is {@link checkDevVars}'s verdict, read out rather than recomputed. The
 * other two sources need no classification: everything in a `.dev.vars.<env>` is a minted token by
 * construction (the old sink wrote nothing else there), and `checkDevVars` has already filtered
 * `dev.json`'s `vars` down to the names a registry declares — a Turnstile sitekey in that file is a
 * legitimate tenant and is not in the list.
 */
async function collect(
  projectDir: string,
  paths: StatePathOptions,
  targets: DevSecretsTarget[],
  workers: CheckDevVarsOptions["workers"],
): Promise<Source[]> {
  const check = await checkDevVars({ projectDir, targets, paths, ...(workers === undefined ? {} : { workers }) });
  const found: Source[] = [];

  const rootPath = join(projectDir, ".dev.vars");
  const root = parseDevVars((await readOptionalFile(rootPath)) ?? "");
  for (const entry of check.root as RootDevVar[]) {
    const value = Object.hasOwn(root, entry.key) ? root[entry.key] : undefined;
    if (value === undefined || value === "") continue;
    found.push({ key: entry.key, value, path: rootPath, env: null, kind: entry.state });
  }

  for (const minted of check.minted) {
    const path = join(projectDir, minted.file);
    const values = parseDevVars((await readOptionalFile(path)) ?? "");
    for (const key of Object.keys(values).sort()) {
      const value = values[key];
      if (value === undefined || value === "") continue;
      found.push({ key, value, path, env: minted.env, kind: "token" });
    }
  }

  if (check.devJsonSecrets.length > 0 && check.devConfigPath !== null) {
    const recorded = await readBootstrapVars(projectDir, paths);
    for (const key of check.devJsonSecrets) {
      const value = Object.hasOwn(recorded, key) ? recorded[key] : undefined;
      if (value === undefined || value === "") continue;
      found.push({ key, value, path: check.devConfigPath, env: null, kind: "secret" });
    }
  }

  return found;
}

/** What every destination already holds. An absent file is empty; one that will not open throws. */
async function load(projectDir: string, project: string | null, paths: StatePathOptions): Promise<Destinations> {
  const cloudflare = parseCloudflareConfig(
    (await readOptionalFile(cloudflareConfigPath({ ...paths, account: null }))) ?? "",
  );
  if (project === null) return { cloudflare, secrets: {}, bootstrap: {}, tokens: {} };
  return {
    cloudflare,
    secrets: await readDevSecrets(devSecretsFile(project, paths)),
    bootstrap: await readBootstrapVars(projectDir, paths),
    tokens: await readMintedTokens(mintedTokensPath(project, paths)),
  };
}

/**
 * One entry per source value: where it goes, and what happens to it there.
 *
 * A destination key already claimed by an earlier entry of this same run is compared against what that
 * entry will write, not only against what is on disk — two sources stating one name with two values is
 * the same "which one signed this?" as a disagreement with the file, and it must not resolve to whichever
 * source happened to be read second.
 */
function plan(
  sources: Source[],
  destinations: Destinations,
  registry: Record<string, { valueType: string }>,
  project: string | null,
  paths: StatePathOptions,
): { entries: AdoptEntry[]; pending: Map<string, unknown> } {
  /**
   * What this run will have put at each `<destination>\0<key>`, so a second source is judged against it —
   * and, since it is the value the comparison was actually made against, the value the write uses.
   */
  const pending = new Map<string, unknown>();
  const entries: AdoptEntry[] = [];

  for (const source of sources) {
    entries.push(planOne(source, destinations, registry, project, paths, pending));
  }
  entries.sort((a, b) => a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
  return { entries, pending };
}

/** One source value's entry. Split out so every `kind` reads as one branch with its own destination. */
function planOne(
  source: Source,
  destinations: Destinations,
  registry: Record<string, { valueType: string }>,
  project: string | null,
  paths: StatePathOptions,
  pending: Map<string, unknown>,
): AdoptEntry {
  const base = { key: source.key, source: source.path, env: source.env, kind: source.kind };

  if (source.kind === "unread") {
    return { ...base, destination: null, action: "leave", reason: null, safeToRemove: false };
  }
  if (source.kind === "credential") {
    const path = cloudflareConfigPath({ ...paths, account: null });
    return settle(base, path, source.value, destinations.cloudflare[source.key], pending);
  }
  if (project === null) return unplaceable(base);

  if (source.kind === "token") {
    const path = mintedTokensPath(project, paths);
    const env = source.env ?? "";
    const current = destinations.tokens[env]?.[source.key];
    return settle(base, `${path}\0${env}`, source.value, current, pending, path);
  }
  if (source.kind === "binding") {
    return settle(base, devPreferencesPath(project, paths), source.value, destinations.bootstrap[source.key], pending);
  }

  // A registry secret. The file always holds a full envelope, so the comparison is against the envelope's
  // current version — and a `json` secret's version is its own structure, which the `.dev.vars` line
  // carries as serialized text. Parsing it is the registry's declaration applied, not a guess; text that
  // is not JSON is refused by name rather than written as a string a seed would reject.
  const declared = Object.hasOwn(registry, source.key) ? registry[source.key] : undefined;
  let candidate: unknown = source.value;
  if (declared?.valueType === "json") {
    try {
      candidate = JSON.parse(source.value);
    } catch {
      return {
        ...base,
        destination: devSecretsFile(project, paths),
        action: "refused",
        reason: `${source.key} is a json secret and its line is not JSON. Fix it, or move it by hand.`,
        safeToRemove: false,
      };
    }
  }
  const envelope = destinations.secrets[source.key];
  const current = envelope === undefined ? undefined : envelope.versions[envelope.currentVersion];
  return settle(base, devSecretsFile(project, paths), candidate, current, pending);
}

/** The verdict for a value with a real destination: already there, in the way, or ready to copy. */
function settle(
  base: Omit<AdoptEntry, "destination" | "action" | "reason" | "safeToRemove">,
  slot: string | null,
  value: unknown,
  current: unknown,
  pending: Map<string, unknown>,
  display?: string,
): AdoptEntry {
  if (slot === null) return unplaceable(base);
  const destination = display ?? slot;
  const claimed = pending.has(`${slot}\0${base.key}`) ? pending.get(`${slot}\0${base.key}`) : current;
  if (claimed !== undefined) {
    if (same(claimed, value)) return { ...base, destination, action: "present", reason: null, safeToRemove: true };
    return {
      ...base,
      destination,
      action: "conflict",
      reason: `${destination} already holds a different ${base.key}. Reconcile them yourself — pithy will not pick one.`,
      safeToRemove: false,
    };
  }
  pending.set(`${slot}\0${base.key}`, value);
  return { ...base, destination, action: "copy", reason: null, safeToRemove: true };
}

/** The refusal for a value whose destination is keyed on a project name this project does not have. */
function unplaceable(base: Omit<AdoptEntry, "destination" | "action" | "reason" | "safeToRemove">): AdoptEntry {
  return {
    ...base,
    destination: null,
    action: "refused",
    reason: `${base.key} belongs in this project's config directory, and the root pithy.config.ts sets no name to key one on.`,
    safeToRemove: false,
  };
}

/** Whether two values are the same one. Structural, so a `json` secret's key order is not a difference. */
function same(current: unknown, next: unknown): boolean {
  return JSON.stringify(current) === JSON.stringify(next);
}

/**
 * Perform every `copy`, through the writer that owns each destination.
 *
 * Batched per destination — one atomic write for every credential, one for every secret, one for the
 * bootstrap set — because each of those writers is a read-modify-write and N of them is N chances to lose
 * what the file already held. `tokens.json` is keyed by environment and its writer takes one at a time.
 */
async function write(
  projectDir: string,
  project: string | null,
  entries: AdoptEntry[],
  planned: Map<string, unknown>,
  paths: StatePathOptions,
): Promise<void> {
  const credentials: Partial<Record<(typeof CLOUDFLARE_ENV_KEYS)[number], string>> = {};
  const secrets: Record<string, DevSecretEnvelope> = {};
  const bootstrap: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.action !== "copy") continue;
    // **The value the plan resolved, never a second derivation of it.** A `json` secret's line is parsed
    // once, in `planOne`, and that parse is what the comparison was made against; re-deriving it here from
    // the registry the writer cannot see is how a `text` secret whose value happens to be a JSON object
    // got compared as a string and written as an object — a run that conflicts with itself on the next
    // invocation, over a value nobody changed.
    const value = planned.get(slotKey(entry));
    if (entry.kind === "secret") {
      if (value !== undefined) secrets[entry.key] = initialDevSecret(value);
      continue;
    }
    // Every other destination is a flat string map; a non-string there could only come from a bug above.
    if (typeof value !== "string") continue;
    if (entry.kind === "credential") {
      if (isCloudflareKey(entry.key)) credentials[entry.key] = value;
      continue;
    }
    if (entry.kind === "binding") {
      bootstrap[entry.key] = value;
      continue;
    }
    if (entry.kind === "token" && project !== null && entry.env !== null) {
      await writeMintedToken(project, entry.env, entry.key, value, paths);
    }
  }

  if (Object.keys(credentials).length > 0) await writeCloudflareConfig(credentials, { ...paths, account: null });
  if (Object.keys(secrets).length > 0 && project !== null) {
    await writeDevSecrets(devSecretsFile(project, paths), secrets);
  }
  if (Object.keys(bootstrap).length > 0) await writeBootstrapVars(projectDir, bootstrap, paths);
}

/**
 * One entry's key into the planned-value map — the same one {@link settle} filed it under.
 *
 * `tokens.json` is keyed by environment as well as by name, so its slot carries the environment. Every
 * other destination is one flat map and its path is the whole slot.
 */
function slotKey(entry: AdoptEntry): string {
  const slot = entry.kind === "token" ? `${entry.destination}\0${entry.env ?? ""}` : `${entry.destination}`;
  return `${slot}\0${entry.key}`;
}

/** Whether a name is one of the account credentials `cloudflare.json` holds, narrowed for the writer. */
function isCloudflareKey(key: string): key is (typeof CLOUDFLARE_ENV_KEYS)[number] {
  return (CLOUDFLARE_ENV_KEYS as readonly string[]).includes(key);
}

/** Abbreviate a home-relative path for display, the way `pithy doctor` does. */
function tildify(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The report: one aligned row per value, then what this run did or would do.
 *
 * Names, paths and verdicts. **No value, on any path** — the assertion is in this module's test, over
 * every kind at once, because the one that leaks is always the kind nobody wrote a case for.
 */
export function renderAdoptText(result: AdoptResult, home = process.env.HOME ?? ""): string {
  if (result.entries.length === 0) {
    return "\nNothing to adopt. Every value this project has is already where the current layout keeps it.\n";
  }

  const rows = result.entries.map((entry) => ({
    key: entry.key,
    from: tildify(entry.source, home),
    to: entry.destination === null ? "nothing reads it" : tildify(entry.destination, home),
    verdict: verdictOf(entry, result.applied),
  }));
  const keyWidth = Math.max(...rows.map((row) => row.key.length));
  const fromWidth = Math.max(...rows.map((row) => row.from.length));
  const toWidth = Math.max(...rows.map((row) => row.to.length));

  const lines = [
    "",
    `${result.project ?? "this project"} — ${count(result.entries.length, "value")}, ${copies(result)} to copy.`,
    "",
    ...rows.map(
      (row) =>
        `  ${row.key.padEnd(keyWidth)}  ${row.from.padEnd(fromWidth)}  →  ${row.to.padEnd(toWidth)}  ${row.verdict}`,
    ),
  ];

  for (const entry of result.entries) {
    if (entry.reason !== null) lines.push("", `  ${entry.reason}`);
  }

  lines.push("", ...closing(result));
  return `${lines.join("\n")}\n`;
}

/** The word for what happened to one value, which is a different word before and after the write. */
function verdictOf(entry: AdoptEntry, applied: boolean): string {
  switch (entry.action) {
    case "copy":
      return applied ? "copied" : "would copy";
    case "present":
      return "already there";
    case "conflict":
      return "refused — a different value is there";
    case "refused":
      return "refused";
    case "leave":
      return "nothing reads it";
  }
}

/** How many entries this run would copy, or copied. */
function copies(result: AdoptResult): number {
  return result.entries.filter((entry) => entry.action === "copy").length;
}

/** `1 value` / `2 values`, so no line in the report reads like a template that lost its plural. */
function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

/** The last block: what was written, what is now safe to delete, and who deletes it. */
function closing(result: AdoptResult): string[] {
  // Said before anything else, because "nothing to copy" and "nothing to copy except the two I refused"
  // are not the same report, and the second one is the one somebody has to act on.
  const refused = adoptRefusals(result);
  const stuck = refused.length === 0 ? [] : [`${count(refused.length, "value")} refused above. Nothing was guessed.`];

  if (!result.applied) {
    return copies(result) === 0
      ? [...stuck, "Nothing to copy. Nothing written."]
      : [...stuck, "Nothing written. Run pithy adopt --apply to perform this."];
  }
  if (copies(result) === 0) {
    // "Every value is already where it belongs" is a claim, and it is false the moment anything was
    // refused: a refused value is not at its destination and never got there. Two states, two sentences.
    const already = result.entries.some((entry) => entry.action === "present");
    return [
      ...stuck,
      already && refused.length === 0 ? "Nothing copied — everything is already there." : "Nothing copied.",
    ];
  }

  const removable = result.entries.filter((entry) => entry.safeToRemove);
  const byFile = new Map<string, string[]>();
  for (const entry of removable) byFile.set(entry.source, [...(byFile.get(entry.source) ?? []), entry.key]);

  return [
    ...stuck,
    `Copied ${copies(result)}. Nothing was deleted — delete these yourself when you are ready:`,
    ...[...byFile.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, keys]) => `  ${inProject(result.projectDir, file)}: ${keys.sort().join(", ")}`),
  ];
}

/**
 * A source file's name for the removal list: relative when it is in the checkout, absolute when it is not.
 *
 * `dev.json` is one of the sources and it lives in the config directory, so a blanket `relative` printed
 * `../config/replay/dev.json` — a path that is correct, unopenable from anywhere the reader is standing,
 * and different for every worktree of the same project.
 */
function inProject(projectDir: string, file: string): string {
  const path = relative(projectDir, file);
  return path === "" || path.startsWith("..") ? file : path;
}

/** One source line, as the pair that identifies it — the file it is in and the name it is under. No value. */
export interface AdoptSourceLine {
  /** The absolute path of the file the line is in. */
  file: string;
  /** The name the line is under. */
  key: string;
}

/**
 * The lines that now have a copy at their destination, so the adopter can delete them.
 *
 * **Empty on a dry run**, because nothing was written and so nothing is safe to delete yet — a list that
 * did not distinguish the two would be this command telling somebody to delete a value it had not copied.
 */
export function adoptSafeToRemove(result: AdoptResult): AdoptSourceLine[] {
  if (!result.applied) return [];
  return result.entries.filter((entry) => entry.safeToRemove).map(sourceLine);
}

/** Whether this run has anything left to complain about — a conflict or a value it could not place. */
export function adoptRefusals(result: AdoptResult): AdoptEntry[] {
  return result.entries.filter((entry) => entry.action === "conflict" || entry.action === "refused");
}

/** One entry, reduced to the pair that identifies its source line. */
function sourceLine(entry: AdoptEntry): AdoptSourceLine {
  return { file: entry.source, key: entry.key };
}
