// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CLOUDFLARE_ENV_KEYS, parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { cloudflareConfigPath } from "../cloudflare/config";
import { bootstrapVarsPath, readBootstrapVars } from "../devSecrets/bootstrapVars";
import { isGeneratedDevVars } from "../devSecrets/generate";
import { type DevSecretsTarget, resolveDevSecretsTargets, type UnresolvableWorker } from "../devSecrets/targets";
import type { StatePathOptions } from "../notifier/state";
import { loadProject, requireProjectName } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { mintedTokensPath } from "../tokens/mintedTokens";
import { declaredVars } from "./wranglerVars";

/**
 * The two `.dev.vars` questions nothing else in the toolchain asks: **is each Worker actually getting
 * anything**, and **is the project root's file still holding values nothing reads** (#178).
 *
 * There are two `.dev.vars` in a Pithy project and they are not the same file:
 *
 * ```
 * <root>/.dev.vars            hand-written. Read by the CLI, for CLOUDFLARE_ENV_KEYS and nothing else.
 * <root>/apps/<w>/.dev.vars   generated (#154). Read by wrangler, and so by the Worker.
 * ```
 *
 * Since #154 the root file is **not a source** for the generated one — generation reads the dev secrets
 * file and this machine's `dev.json`. So an upgraded project's secrets sit one file away from everything
 * that would use them, every generated file comes out with a header and no values, and the first thing
 * that says so is a 500 from a running Worker: `Missing required bindings: …`. Both facts are one `stat`
 * and one parse away from a diagnostic, and `doctor` is the command whose whole job is to notice.
 *
 * **Every key in the root file is classified, and the classification is total.** That is what stops a
 * new shape of key from arriving unreported, which is the failure this module exists for: the misplaced
 * check next door reached `backend: "d1"` and every other kind of stranded value fell through it in
 * silence. A key is either read from that file, reported by a neighboring check, or reported here.
 *
 * **Reported, never fixed, and never fatal to the exit.** #154 said migration is reported rather than
 * automatic, and silently rewriting an adopter's `.dev.vars` is what #142 was about. Every project that
 * predates the generated file is in this state by definition, so failing the exit would turn a green CI
 * red over a file that used to work. Reported means reported, though — and until now nothing did.
 */

/**
 * Why a key is in the project root's `.dev.vars`, and whether anything reads it there.
 *
 * Declared as a tuple rather than a bare union so a test can iterate it: a state added without a
 * sentence to print for it is a key class that would go silent, which is this module's whole subject.
 */
export const ROOT_DEV_VAR_STATES = [
  /**
   * One of {@link CLOUDFLARE_ENV_KEYS}. The CLI read these out of exactly this file until #182; they are
   * account-scoped, so they live in `<config>/cloudflare.json` now and nothing reads this copy.
   */
  "credential",
  /**
   * A secret some Worker's registry declares. It belongs in the dev secrets file whatever its backend,
   * and `checkDevSecrets` is what says so — named here only so the classification stays total.
   */
  "secret",
  /**
   * A name some Worker requires as a binding, or declares in its `wrangler.jsonc` `vars` — but not
   * from this file, which no Worker reads. The value is real and its home is elsewhere.
   */
  "binding",
  /**
   * A Worker's `pithy.config.ts` would not import, so **nothing here can say what reads this** (#208).
   *
   * The state that exists because `unread` is a *negative* claim — "nothing this project composes
   * declares it" — and a registry nobody could read is exactly what might have declared it. Registries
   * merge project-wide, so a healthy sibling does not settle it either: its registry is real, and it is
   * not the project's answer. Until #208 an unresolvable config answered `[]` like a project with no
   * secrets, so every key in the file classified `unread` and the report said "delete it" about the
   * broken Worker's own secrets.
   *
   * The three states above survive a partial read because each is positive evidence: a fixed credential
   * list, a registry that *did* declare the name, a composition that *does* want it. This one is what is
   * left when the only remaining answer would have been an inference from files nobody could open.
   */
  "unclassified",
  /** Nothing reads it: not a credential, not declared by anything this project composes. */
  "unread",
] as const;

/** Why one root `.dev.vars` key is there. See {@link ROOT_DEV_VAR_STATES}. */
export type RootDevVarState = (typeof ROOT_DEV_VAR_STATES)[number];

/** One key in the project root's `.dev.vars`, and what reads it. Never its value. */
export interface RootDevVar {
  /** The variable name, as the adopter wrote it. */
  key: string;
  /** What reads it, if anything. */
  state: RootDevVarState;
  /** The Workers that want it, for a `binding` key — so the sentence can name one. Sorted. */
  workers: string[];
}

/** One Worker whose generated `.dev.vars` is a header and nothing else. */
export interface EmptyDevVars {
  /** The Worker's name — the whole point of the finding is which one is getting nothing. */
  worker: string;
  /** The generated file, relative to the project root. */
  file: string;
}

/** What doctor learned about this project's `.dev.vars` files. */
export interface DevVarsCheck {
  /**
   * Every key in the project root's `.dev.vars`, classified, sorted by key. **Total**: one entry per
   * key in the file, so no key can be silently skipped. `credential` and `secret` print nothing.
   */
  root: RootDevVar[];
  /**
   * Workers whose generated `.dev.vars` pithy wrote with no values in it. A Worker in this list cannot
   * serve a request — it has none of its bindings — and nothing else in the toolchain would say so
   * before the first 500.
   */
  empty: EmptyDevVars[];
  /**
   * Where this machine's per-project dev values live — the file a `binding` key belongs in. `null`
   * when the project has no name to key one on, which is the same condition every other per-project
   * path in the report declines under.
   */
  devConfigPath: string | null;
  /**
   * Where a minted credential belongs — `<config>/<project>/tokens.json`. `null` when the project has
   * no name to key one on, which is the same condition {@link devConfigPath} declines under.
   *
   * Carried because the sentence has to name it. Nothing copies an existing token into that file —
   * `writeMintedToken` is reached only on a *fresh* mint — so the remedy is a person moving a line, and
   * a remedy that cannot say where is not one.
   */
  mintedTokensPath: string | null;
  /**
   * Minted-credential files left in the project by the old `dev-vars` token sink — `.dev.vars.<env>`,
   * one per environment, each holding that environment's live Cloudflare token (#182). Sorted.
   *
   * **Named, never deleted.** #142 is why: a run that rewrote an adopter's `.dev.vars` deleted gitignored
   * secrets with no copy anywhere. The value in a `.dev.vars.production` may be the only copy of a
   * production credential that exists, and this report is the thing that tells somebody it is there.
   */
  minted: MintedDevVarsFile[];
  /**
   * Registry secrets still sitting in `<config>/<project>/dev.json` under `vars` — the copy `pithy seed`
   * used to make, which nothing reads since #179. Names only, sorted. Never a value.
   */
  devJsonSecrets: string[];
  /**
   * Every Worker with a `pithy.config.ts` that would not import, and why (#208). Empty on an ordinary run.
   *
   * It is a field rather than an absence because an absence is what the defect was: the lossy target list
   * answered `[]` for this state and for a project that never composed `secrets`, so every consumer read
   * a config that would not load as a Worker that declares nothing. A caller now has to drop it on
   * purpose. It also decides {@link RootDevVarState} — see `unclassified`.
   */
  unresolvable: UnresolvableWorker[];
}

/** One `.dev.vars.<env>` the old token sink left in the checkout. */
export interface MintedDevVarsFile {
  /** The file, relative to the project root. */
  file: string;
  /** The environment it was minted for — the whole point of naming it. */
  env: string;
}

/** What {@link checkDevVars} needs. Every seam defaults to the real project. */
export interface CheckDevVarsOptions {
  /** The project root — owner of the hand-written `.dev.vars` and of `apps/`. */
  projectDir: string;
  /** The Workers whose registries declare the secrets. Defaults to every one composing `secrets`. */
  targets?: DevSecretsTarget[];
  /**
   * The Workers whose `pithy.config.ts` would not import. Read only when {@link targets} is supplied —
   * both halves of one resolution, so a seam cannot state one and let the other default to a lie.
   */
  unresolvable?: UnresolvableWorker[];
  /** The Workers whose bindings are read and whose generated files are checked. Defaults to all of them. */
  workers?: { name: string; dir: string; capabilities: Capability[] }[];
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test reads its own. */
  paths?: StatePathOptions;
}

/**
 * Read both scopes and answer both questions. Never throws — a diagnostic has to work in the broken
 * environment it exists to diagnose, and every one of these reads is of a file that may not be there.
 */
export async function checkDevVars(options: CheckDevVarsOptions): Promise<DevVarsCheck> {
  const workers =
    options.workers ??
    (await resolveWorkers({ projectDir: options.projectDir }).catch(() => [])).map((worker) => ({
      name: worker.name,
      dir: worker.dir,
      capabilities: worker.capabilities,
    }));
  // Both halves of one resolution (#208). `resolveDevSecretsTargets` cannot drop the failure, because
  // the failure is a field — the lossy wrapper's `.catch(() => [])` used to stand here and answered a
  // config that would not import exactly as it answered a project with no secrets.
  const { targets, unresolvable } =
    options.targets === undefined
      ? await resolveDevSecretsTargets(options.projectDir)
      : { targets: options.targets, unresolvable: options.unresolvable ?? [] };

  // What the registries declare, and what the compositions require. Two different answers to "does
  // anything read this name", kept apart because they have two different fixes.
  const declaredSecrets = new Set(targets.flatMap((target) => Object.keys(target.registry)));
  const wants = new Map<string, string[]>();
  for (const worker of workers) {
    const names = new Set<string>();
    for (const capability of worker.capabilities) {
      for (const binding of capability.requiredBindings ?? []) names.add(binding.name);
    }
    for (const name of await declaredVars(worker.dir)) names.add(name);
    for (const name of names) wants.set(name, [...(wants.get(name) ?? []), worker.name].sort());
  }

  const inRoot = parseDevVars(await readFile(join(options.projectDir, ".dev.vars"), "utf8").catch(() => ""));
  const root: RootDevVar[] = Object.keys(inRoot)
    .sort()
    .map((key) => ({
      key,
      state: classify(key, declaredSecrets, wants, unresolvable.length > 0),
      workers: wants.get(key) ?? [],
    }));

  const empty: EmptyDevVars[] = [];
  for (const worker of workers) {
    const path = join(worker.dir, ".dev.vars");
    const source = await readFile(path, "utf8").catch(() => null);
    // No file is not a finding: nothing has generated one yet, and the first `pithy dev` will. A file
    // pithy did not write is the adopter's own — `generateDevVars` refuses to touch it, and judging its
    // contents here would be the same overreach one report further along.
    if (source === null || !isGeneratedDevVars(source)) continue;
    if (Object.keys(parseDevVars(source)).length > 0) continue;
    empty.push({ worker: worker.name, file: relative(options.projectDir, path) });
  }

  // The registry is what says a `dev.json` value has a better home now. A name nothing declares is a
  // legitimate machine-local variable — a Turnstile sitekey — and `dev.json` is still where it belongs.
  const recorded = await readBootstrapVars(options.projectDir, options.paths ?? {}).catch(() => ({}));
  const devJsonSecrets = Object.keys(recorded).filter((key) => declaredSecrets.has(key));

  return {
    root,
    empty: empty.sort((a, b) => a.worker.localeCompare(b.worker)),
    devConfigPath: await bootstrapVarsPath(options.projectDir, options.paths ?? {}).catch(() => null),
    mintedTokensPath: await tokensPath(options.projectDir, options.paths ?? {}),
    minted: await mintedDevVarsFiles(options.projectDir),
    devJsonSecrets: devJsonSecrets.sort(),
    unresolvable,
  };
}

/**
 * `<config>/<project>/tokens.json` for a project root, or `null` when the project has no name.
 *
 * Composed through `mintedTokensPath` rather than assembled beside `devConfigPath`'s directory: the two
 * files are siblings today, and a path built from that fact would be a second producer of a name this
 * repo keeps in one place.
 */
async function tokensPath(projectDir: string, options: StatePathOptions): Promise<string | null> {
  try {
    return mintedTokensPath(requireProjectName(await loadProject(projectDir)), options);
  } catch {
    return null;
  }
}

/**
 * Every `.dev.vars.<env>` still in the project root.
 *
 * Read by listing the directory rather than by composing a name per known environment: the old sink
 * wrote whatever `--env` it was handed, so a project can hold a `.dev.vars.qa` no list here would guess.
 * `.dev.vars` and `.dev.vars.local` and `.dev.vars.example` are all other things and are not this.
 */
async function mintedDevVarsFiles(projectDir: string): Promise<MintedDevVarsFile[]> {
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
  const found: MintedDevVarsFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const env = /^\.dev\.vars\.(.+)$/.exec(entry.name)?.[1];
    if (env === undefined || env === "local" || env === "example") continue;
    found.push({ file: entry.name, env });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Whether the CLI itself reads this name out of the project root's `.dev.vars`.
 *
 * **The one place that answers it, because the answer used to be inferred from `backend`.** A
 * `cf-secrets-store` secret was left unreported there on the grounds that `CLOUDFLARE_API_TOKEN` has
 * no local store to live in — true of that one name, and not true of the backend. The dashboard's own
 * `cf-secrets-store` secrets sat stranded in that file with nothing to say so (#178). The list the
 * readers use is the list that decides, and it is `CLOUDFLARE_ENV_KEYS`.
 */
export function isCloudflareEnvKey(name: string): boolean {
  return (CLOUDFLARE_ENV_KEYS as readonly string[]).includes(name);
}

/**
 * One root key's state. Ordered by who reads it: the CLI, then a registry, then a composition.
 *
 * The first three are positive evidence and survive a `partial` read — a fixed credential list, a
 * registry that did declare the name, a composition that does want it. `unread` is the one negative
 * claim, so with a Worker nobody could ask it becomes `unclassified` instead (#208).
 */
function classify(
  key: string,
  declaredSecrets: Set<string>,
  wants: Map<string, string[]>,
  partial: boolean,
): RootDevVarState {
  if (isCloudflareEnvKey(key)) return "credential";
  if (declaredSecrets.has(key)) return "secret";
  if (wants.has(key)) return "binding";
  return partial ? "unclassified" : "unread";
}

/**
 * The lines the report prints, or none at all when there is nothing to say.
 *
 * The empty-Worker lines come first because they are the loudest thing `doctor` can say about a dev
 * environment: that Worker answers every request with a missing-binding error, and the root-file lines
 * below are usually the reason why.
 */
export function describeDevVars(check: DevVarsCheck): string[] {
  const lines: string[] = [];
  // First, above everything, because it is the sentence that explains the lines under it: a Worker
  // nobody could ask is why half of them say "unclassified" rather than naming a destination. `doctor`
  // is run *because* something is already wrong, so this is a finding and never a refusal — the rest of
  // the block still prints (#208).
  for (const worker of check.unresolvable) {
    lines.push(
      `${worker.name}'s pithy.config.ts would not import, so nothing here knows what it declares. ${worker.reason}`,
    );
  }
  for (const { file, env } of check.minted) {
    const home = check.mintedTokensPath === null ? "this project's config directory" : check.mintedTokensPath;
    lines.push(
      `${file} holds a credential minted for ${env}, inside the checkout. Nothing writes one there now — move each line into ${home} as { "${env}": { "<NAME>": "<value>" } }, chmod 600 it and 700 its directory, then delete the file. Gitignored is not enough: npm pack does not read .gitignore.`,
    );
  }
  if (check.devJsonSecrets.length > 0) {
    const home = check.devConfigPath === null ? "this machine's dev config" : check.devConfigPath;
    lines.push(
      `${check.devJsonSecrets.join(", ")} ${check.devJsonSecrets.length === 1 ? "is" : "are"} in ${home} under "vars". Nothing reads that copy — the value belongs in the dev secrets file. Run pithy secrets edit to put it there, then delete the copy.`,
    );
  }
  for (const { worker, file } of check.empty) {
    lines.push(
      `${worker} has no dev values: ${file} was generated with none. That Worker starts with none of its bindings. Run pithy seed.`,
    );
  }
  for (const entry of check.root) {
    const line = describeRootDevVar(entry, check.devConfigPath, check.unresolvable);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/**
 * One root key's sentence, or `null` when the key is where it belongs or is another check's to report.
 *
 * A switch over {@link RootDevVarState} with no default, so adding a state is a type error here rather
 * than a key class that goes quiet — which is exactly how the `d1`-only check lost the other backend.
 */
function describeRootDevVar(
  entry: RootDevVar,
  devConfigPath: string | null,
  unresolvable: UnresolvableWorker[],
): string | null {
  switch (entry.state) {
    case "credential":
      // Named, not deleted for them. The value is real and it is a live Cloudflare credential — the one
      // class of value in this file that is worth naming twice rather than removing on somebody's behalf.
      return `${entry.key} is in .dev.vars, which nothing reads now. It is account-scoped — copy it into ${cloudflareConfigPath({ account: null })} as { "${entry.key}": "<value>" }, chmod 600, or export it.`;
    case "secret":
      return null; // `describeDevSecrets` names it, and says which file it belongs in.
    case "binding": {
      // The shape and the mode are stated because nothing else will write that file. No `pithy` subcommand
      // takes a name and a value for `dev.json`'s `vars` — `writeBootstrapVars` is reached only from
      // provisioning and mint paths — so the remedy is a person editing JSON. Every writer of these files
      // creates them `0600` in a `0700` directory (#182); a hand-written one lands at the umask default
      // and nothing here checks it afterwards, so the mode belongs in the sentence.
      const wanted = entry.workers.length > 0 ? entry.workers.join(", ") : "this project";
      const home = devConfigPath === null ? "this machine's dev config" : devConfigPath;
      return `${entry.key} is in .dev.vars, which no Worker reads. ${wanted} needs it as a binding — its dev value belongs in ${home}, as { "vars": { "${entry.key}": "<value>" } }, chmod 600.`;
    }
    case "unclassified": {
      // Named, never advised on. The one thing this line must not do is repeat what `unread` says: the
      // whole point is that "nothing reads it, delete it" is the claim nobody could establish, and this
      // key may be the unreadable Worker's own registry secret.
      const named = unresolvable.map((worker) => worker.name).join(", ");
      const who = named === "" ? "a Worker whose pithy.config.ts will not import" : named;
      return `${entry.key} is in .dev.vars, and nothing here can say what reads it while ${who} will not import. Fix that first.`;
    }
    case "unread":
      return `${entry.key} is in .dev.vars and nothing reads it — not a Cloudflare credential, and nothing this project composes declares it. Delete it.`;
  }
}

/**
 * Whether there is anything here to *fix*.
 *
 * Every finding this module produces is one, which is why there is no `devSecretsHealthy`-shaped
 * exception list: a Worker with no bindings and a value nothing reads are both faults. Neither fails
 * the exit — see the module note — but both are worth dragging the report verbose for.
 */
export function devVarsHealthy(check: DevVarsCheck): boolean {
  return describeDevVars(check).length === 0;
}
