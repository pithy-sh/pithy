// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { readMigrationOwner } from "@pithy-sh/core/src/migrations/owner";
import { assertValidProjectName, isValidProjectName, kebab } from "@pithy-sh/core/src/naming/resource";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { loadProject, loadProjectCloudflare, type ProjectConfig } from "../project/config";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";

/**
 * Whether the project name in the root `pithy.config.ts` still matches the names this project's resources
 * were provisioned under.
 *
 * **Why this is a health check.** Every provisioned name now leads with the project
 * (`<project>-<env>-<thing>`), and teardown *recomputes* those names rather than scanning a prefix. So one
 * edit to `name` orphans everything: `pithy feature destroy` computes names that no longer exist, finds
 * nothing, and exits 0 while the real D1, KV, buckets, and Worker scripts keep running and keep billing.
 * Provisioning quietly builds a parallel set beside them. Nothing else in the toolchain notices, which is
 * exactly why it belongs in the command whose job is noticing.
 *
 * **A rename is never inferred from a name's shape.** `<app>-<env>-<resource>` is the ordinary Cloudflare
 * naming convention, so *every* database an adopter named that way before they had ever heard of Pithy has
 * Pithy's shape. Reading a project segment off one name and calling the difference a rename told adopters
 * on the migrate-an-existing-Worker-into-Pithy path — the adoption path — that their live production
 * database was an orphan, and advised deleting it. Shape narrows the candidates. It establishes nothing.
 *
 * Two kinds of evidence do, and they are ranked:
 *
 * 1. **Proof — Pithy's own owner stamp.** `pithy migrate` (and every other writing command) records the
 *    project in `pithy_migrations_owner` on the database itself. A live database whose stamp names a
 *    *different* project than the config is proof: Pithy made that database, under that name, for this
 *    codebase. Nothing about it is inferred. Only proof reaches `orphaned`, and even then the remedy never
 *    says "delete" — the stamp proves one database's provenance, not the whole list's.
 * 2. **Deduction — the wiring contradicts the config wholesale.** The stamp only covers databases Pithy has
 *    migrated, so it narrows rather than replaces the local check. The project name is **one string**: a
 *    rename moves every derived name at once, so it cannot leave some names on the new name. That makes the
 *    signature checkable from files alone — *every* declared name leads with one and the same other project,
 *    and the configured name appears nowhere. One odd name out is a resource the adopter brought with them;
 *    the whole wiring disagreeing is the config and the wiring contradicting each other, which is a fault
 *    whoever caused it. That is {@link wholesaleRename}, and it is what `drifted` means now.
 *
 * The account is still asked whether a name is live, but existence is *not* evidence of ownership: a
 * database that exists under a name the adopter chose is just their database. It only colors the report.
 */
export type ProjectNameState =
  /**
   * The root `pithy.config.ts` loaded and carries no `name`. Nothing to reconcile; never fails the exit.
   *
   * **Only that case.** It used to cover a missing config file too, and the one message the two shared —
   * "add `name` to pithy.config.ts" — was written for this branch and wrong for the other: it named a key
   * in a file that did not exist, in a directory with no project to name. A config with no `name` is now
   * the rare hand-edited case (`pithy init` always writes one), and it is the only case this answers.
   * When the config cannot be read at all, {@link checkProjectName} returns `null` instead.
   */
  | "unconfigured"
  /**
   * A `name` is set and no Cloudflare namespace could carry it — {@link isValidProjectName} refuses it.
   *
   * Distinct from `unconfigured` on purpose, and it **fails the exit**. Collapsing the two reported an
   * illegal name as "not set", which told the operator to add a name they had already added while
   * `pithy add`, `pithy migrate`, `pithy secrets provision`, and `pithy token mint` were all hard-failing
   * on that same project — and left a CI gate on `pithy doctor` green. Unlike `unconfigured` and
   * `could-not-check` this is a positively established fault, which is the standard the failing states
   * are held to.
   */
  | "invalid"
  /** Every provisioned name this project's wiring declares leads with the configured project. */
  | "ok"
  /** The wiring could not be read (no worker declares a name, or a `wrangler.jsonc` would not parse). Never fails the exit. */
  | "could-not-check"
  /**
   * The wiring contradicts the config wholesale — every declared name leads with one other project and the
   * configured name appears nowhere ({@link wholesaleRename}). Established from local files alone, and it
   * claims nothing about who owns what: the two sources of truth in this repo disagree, and one is wrong.
   */
  | "drifted"
  /**
   * Proven: a live database carries Pithy's own `pithy_migrations_owner` stamp naming a project other than
   * the configured one. Pithy made it, under that name, and the configured name will never find it again.
   */
  | "orphaned";

/** One resource whose declared name leads with a project segment that is not the configured one. */
export interface MisnamedResource {
  /** The resource name exactly as `wrangler.jsonc` declares it. */
  name: string;
  /** The project segment that name leads with — a *candidate* old name until something proves it. */
  project: string;
  /** The kind of Cloudflare resource: the two whose names live in `wrangler.jsonc`. */
  kind: "d1" | "r2";
  /** The Worker whose `wrangler.jsonc` declares it, so the fix has an address. */
  worker: string;
  /** The environment stanza it sits in — `dev` for the top-level one. */
  env: string;
  /** The Worker env binding it is bound to. */
  binding: string;
  /**
   * Whether the account holds a resource by this name — `null` when the account was not consulted or would
   * not answer. Existence is context, never evidence of ownership: a live database under a name the adopter
   * chose is simply theirs. Tri-state on purpose, because "I did not find out" is not "it is not there".
   */
  provisioned: boolean | null;
  /**
   * The project recorded in this database's `pithy_migrations_owner` stamp, or `null` when there is none to
   * read (an R2 bucket, a database Pithy never migrated, an unreachable account). This is the only field
   * that ever *proves* ownership — `owner === project` means Pithy made this resource under that name.
   */
  owner: string | null;
}

/** What `doctor` learned about the configured project name. */
export interface ProjectNameCheck {
  state: ProjectNameState;
  /**
   * The configured project name, or `null` when there is none to report. Kebabed — the form every
   * resource name is composed from — except under `invalid`, where it is the raw configured value: an
   * illegal name is never composed with, and the operator has to recognize the string they typed.
   */
  project: string | null;
  /** Every declared resource name leading with a different project segment. Empty unless drifted or orphaned. */
  misnamed: MisnamedResource[];
}

/** One resource name a Worker's `wrangler.jsonc` declares, with the environment and binding it belongs to. */
export interface DeclaredResource {
  /** The declared `database_name` / `bucket_name`. */
  name: string;
  /** Which kind of entry it came from. */
  kind: "d1" | "r2";
  /** The Worker that declares it. */
  worker: string;
  /** The environment stanza — `dev` for the top-level one. */
  env: string;
  /** The binding the entry is bound to. */
  binding: string;
}

/** The `wrangler.jsonc` keys this reads. Only the two entry kinds that carry a resource *name*. */
interface NamedBindings {
  d1_databases?: { binding?: string; database_name?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
  env?: Record<string, NamedBindings | undefined>;
}

/** Every environment's stanza: the top-level one (the dev environment) plus each `env.<name>`. */
function envStanzas(config: NamedBindings): { env: string; stanza: NamedBindings }[] {
  const list: { env: string; stanza: NamedBindings }[] = [{ env: "dev", stanza: config }];
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    if (stanza) list.push({ env, stanza });
  }
  return list;
}

/** Pull the named entries out of one stanza. An entry with no binding or no name declares nothing. */
function stanzaResources(stanza: NamedBindings, worker: string, env: string): DeclaredResource[] {
  const found: DeclaredResource[] = [];
  for (const entry of stanza.d1_databases ?? []) {
    if (entry.binding && entry.database_name) {
      found.push({ name: entry.database_name, kind: "d1", worker, env, binding: entry.binding });
    }
  }
  for (const entry of stanza.r2_buckets ?? []) {
    if (entry.binding && entry.bucket_name) {
      found.push({ name: entry.bucket_name, kind: "r2", worker, env, binding: entry.binding });
    }
  }
  return found;
}

/** What {@link declaredResources} found, and whether it managed to read everything it tried to. */
export interface DeclaredResources {
  /** Every named D1 database and R2 bucket declared across every Worker and every environment. */
  resources: DeclaredResource[];
  /**
   * True when the wiring could not be read in full: the Worker set would not enumerate (a
   * `pithy.worker.jsonc` that will not parse), or at least one Worker's `wrangler.jsonc` would not.
   */
  unreadable: boolean;
}

/**
 * Every resource name this project's Workers declare, across every environment.
 *
 * Only D1 and R2 appear, because they are the only entries wrangler gives a name field
 * (`database_name`, `bucket_name`). A `kv_namespaces` entry has no title, so a KV namespace's name lives
 * only in the account and there is nothing local to compare it against.
 *
 * An unreadable `wrangler.jsonc` is recorded rather than thrown: the other Workers still have something
 * to say, and a partial answer plus "I could not read all of it" beats a diagnostic that gives up. A
 * Worker that has **no** `wrangler.jsonc` is skipped outright and is not unreadable — `apps/` also holds
 * non-Worker processes (a Vite frontend joins the dev set through `pithy.worker.jsonc` alone), and
 * reporting a healthy project as unchecked because of one is worse than saying nothing about it.
 *
 * Discovery itself gets the same treatment. `discoverWorkers` parses every `pithy.worker.jsonc` and
 * **throws** on one that will not parse or will not validate — correct for `dev` and `deploy`, where a
 * typo'd manifest must stop the run, and exactly wrong here: `doctor` exists to work in the broken
 * project. So a failed enumeration is the same answer as an unreadable Worker, just for all of them.
 */
export async function declaredResources(projectDir: string): Promise<DeclaredResources> {
  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { resources: [], unreadable: true };
  }
  const resources: DeclaredResource[] = [];
  let unreadable = false;
  for (const worker of workers) {
    if (!worker.hasWrangler) continue;
    let config: NamedBindings;
    try {
      config = (await readWranglerConfig(worker.dir)) as NamedBindings;
    } catch {
      unreadable = true;
      continue;
    }
    for (const { env, stanza } of envStanzas(config)) {
      resources.push(...stanzaResources(stanza, worker.name, env));
    }
  }
  return { resources, unreadable };
}

/**
 * The project segment of a declared name, when that name is one Pithy's rule *could* have produced for this
 * binding in this environment — otherwise `null`.
 *
 * The suffix is the discriminator: `<env>-<binding>`, kebab-cased, is exactly what the naming rule puts
 * after the project, so a name ending in it has Pithy's shape and everything before it reads as a project
 * segment. **Shape is a filter, never a finding.** `<app>-<env>-<resource>` is also the ordinary Cloudflare
 * convention every adopter already uses, so this says only "that name is a candidate" — never "Pithy made
 * it". A caller that treats a non-null return as a rename is the bug this comment used to describe as the
 * fix. See {@link wholesaleRename} and the owner stamp for what actually establishes one.
 */
export function projectSegmentOf(name: string, env: string, binding: string): string | null {
  const suffix = `-${kebab(env)}-${kebab(binding)}`;
  if (!name.endsWith(suffix)) return null;
  const project = name.slice(0, -suffix.length);
  return project.length > 0 ? project : null;
}

/**
 * Whether a declared name leads with this project — the whole leading segment, and nothing about the rest.
 *
 * The counterpart to {@link projectSegmentOf}, and deliberately not it. That function answers "could Pithy's
 * rule have produced this exact name for this binding", which is the right filter for picking *candidates*
 * and the wrong one for asking whether the configured project appears at all: **several Pithy-provisioned
 * names put the capability in the thing slot rather than the binding.**
 * `resourceNames(project).env(env).r2("storage")` composes `acme-prod-storage` for the `STORAGE_BUCKET`
 * binding; media and support do the same. Asked through the strict tail, a correctly named bucket Pithy made
 * itself reads as no evidence at all, and {@link wholesaleRename} fires on the adoption path it exists to
 * protect.
 *
 * A whole segment, not a prefix: `acmecorp-prod-db` does not lead with `acme`.
 */
function leadsWithProject(name: string, project: string): boolean {
  return name === project || name.startsWith(`${project}-`);
}

/** A candidate before the account has said anything about it: shape only, no evidence attached. */
export type MisnamedCandidate = Omit<MisnamedResource, "provisioned" | "owner">;

/**
 * Every declared resource whose name has Pithy's shape but leads with a project segment that is not ours.
 *
 * These are **candidates**, not findings. Most projects with one legacy database have exactly one, and it is
 * not a rename. {@link checkProjectName} decides.
 */
export function misnamedResources(project: string, declared: DeclaredResource[]): MisnamedCandidate[] {
  const ours = kebab(project);
  const found: MisnamedCandidate[] = [];
  for (const resource of declared) {
    const segment = projectSegmentOf(resource.name, resource.env, resource.binding);
    if (segment === null || segment === ours) continue;
    found.push({
      name: resource.name,
      project: segment,
      kind: resource.kind,
      worker: resource.worker,
      env: resource.env,
      binding: resource.binding,
    });
  }
  return found;
}

/**
 * Whether the wiring contradicts the config *wholesale* — the one shape a rename can leave.
 *
 * The project name is a single string. Change it and every name derived from it moves together, so a rename
 * cannot leave some declared names on the new name and some on the old. Three conditions follow, and all
 * three are checked against local files only:
 *
 * - **The configured name appears nowhere.** One resource declared under the configured project settles it:
 *   this project provisions under its current name, so the odd names out are things brought in from
 *   somewhere else, not stragglers. (A rename followed by re-provisioning does produce a mix — that case is
 *   the owner stamp's, which is the only thing that can tell the two apart.) Asked through
 *   {@link leadsWithProject} rather than the strict shape: the question is whether the project *leads* any
 *   declared name, and a bucket named `<project>-<env>-storage` for a `STORAGE_BUCKET` binding is the
 *   configured name appearing, however little it looks like `<env>-<binding>`.
 * - **Exactly one foreign segment.** Two would be two renames, which one string cannot have done.
 * - **More than one distinct name carries it.** This is the concession, and it is deliberate: a single
 *   `<something>-<env>-<binding>` is indistinguishable from the Cloudflare convention, and calling one name
 *   a rename is precisely the false positive that reported an adopter's production database as an orphan.
 *   Deduped by name, because two Workers sharing a binding declare one resource twice, not two resources.
 */
export function wholesaleRename(
  project: string,
  declared: DeclaredResource[],
  candidates: MisnamedCandidate[],
): boolean {
  if (candidates.length === 0) return false;
  const ours = kebab(project);
  for (const resource of declared) {
    if (leadsWithProject(resource.name, ours)) return false;
  }
  if (new Set(candidates.map((entry) => entry.project)).size !== 1) return false;
  return new Set(candidates.map((entry) => entry.name)).size >= 2;
}

/** What the account could be made to say about one candidate name. Absent from the map means "unknown". */
export interface AccountEvidence {
  /** A resource by this exact name exists in the account. Context for the report, never proof of ownership. */
  exists: boolean;
  /** The project in this database's `pithy_migrations_owner` stamp — the one authoritative ownership record. */
  owner: string | null;
}

/**
 * The account seam: per-name evidence for the candidates, keyed by resource name. A name with no entry was
 * never established either way (no credentials, an unreachable account, a listing that was refused), which
 * is reported as unknown rather than as absence.
 *
 * **The account is on the seam, not behind it (#234).** A stub that took only the candidates would let the
 * real implementation keep a defaulted account and no test would ever notice, which is exactly the state
 * this replaced.
 */
export type AccountProbe = (
  candidates: MisnamedCandidate[],
  account: CloudflareAccountSelection | null,
) => Promise<Map<string, AccountEvidence>>;

/**
 * The recorded owner of a database, read through the one read-only seam `@pithy-sh/core` exposes.
 *
 * Never throws and never invents: an unstamped database, a database whose bookkeeping table has never been
 * created, or a token without query permission all come back `null` — absence of proof, which keeps the
 * verdict on the local deduction instead of escalating it.
 */
async function ownerStampOf(clients: CloudflareClients, databaseId: string): Promise<string | null> {
  try {
    const owner = await readMigrationOwner(clients.d1(databaseId) as unknown as D1Database);
    return owner?.project ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask the account about the candidates: does a resource by that name exist, and — for D1, the only kind
 * that records it — which project stamped it. Never throws; a failed listing simply leaves those names out
 * of the map.
 */
export async function probeAccountEvidence(
  candidates: MisnamedCandidate[],
  /**
   * The Cloudflare account this project belongs to, from its own root `pithy.config.ts`. The verdict this
   * function can reach — `orphaned`, "a live database is not yours" — is one no adopter should ever read
   * off the wrong account (#206).
   *
   * **Required, and ahead of the `connect` seam, because it used to be `= null` behind it (#234).** A
   * default parameter is the quietest of the three shapes an optional account can take: the `null` is
   * written at the declaration, so it reads like a decision somebody made, while every call site says
   * nothing at all. And the failure it produces is not a failed call — it is a *sentence*. A project on
   * `cloudflare.accountName` got the default account's credentials here, found no database by its own
   * name in a tenant that was never asked, and the deduction it fed says the adopter's live production
   * database belongs to someone else. Wrong credentials that refuse are a bad afternoon; wrong
   * credentials that answer confidently are the bug this parameter exists to make unwritable.
   */
  account: CloudflareAccountSelection | null,
  /**
   * How the account is reached. Injectable for the same reason `probeAccount` is one level up, but a level
   * lower: stubbing `probeAccount` replaces this whole function, so the branching *inside* it — which kinds
   * get probed, how a missing database differs from an unreadable listing, whether a stamp is read at all —
   * had no test at all. It is the only path that can reach the `orphaned` verdict, and that verdict tells
   * an adopter a live database is not theirs.
   */
  connect: (credentials: { accountId: string; apiToken: string }) => CloudflareClients = (credentials) =>
    new CloudflareClients(credentials),
): Promise<Map<string, AccountEvidence>> {
  const evidence = new Map<string, AccountEvidence>();
  // **A pin the credentials contradict ends the probe, before the network.** `cloudflareEnv` throws on a
  // mismatch, which is right everywhere it is a command's own resolution — but this is a diagnostic, and a
  // `pithy doctor` that exits on the fault it exists to report tells nobody anything. So the refusal is
  // kept and the throw is not: there is no account this run is entitled to ask, so it asks none and
  // establishes nothing, which leaves the verdict on the local deduction and out of reach of `orphaned`.
  // The mismatch itself is already a line of this same report — `Cloudflare:`, `account_mismatch` — and
  // one fact belongs in one line, which is the rule the rest of this file is written to.
  let vars: Record<string, string>;
  try {
    vars = cloudflareEnv({ account });
  } catch {
    return evidence;
  }
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return evidence;

  const clients = connect({ accountId, apiToken });
  const databases = new Set(candidates.filter((entry) => entry.kind === "d1").map((entry) => entry.name));
  const buckets = new Set(candidates.filter((entry) => entry.kind === "r2").map((entry) => entry.name));

  if (databases.size > 0) {
    try {
      const live = new Map((await clients.d1Provisioner().listDatabases()).map((db) => [db.name, db.uuid]));
      for (const name of databases) {
        const id = live.get(name);
        evidence.set(name, { exists: id !== undefined, owner: id ? await ownerStampOf(clients, id) : null });
      }
    } catch {
      // Unreachable or unauthorized. The names stay unknown — the verdict falls back to the local deduction.
    }
  }
  if (buckets.size > 0) {
    try {
      const live = new Set((await clients.r2Provisioner().listBuckets()).map((bucket) => bucket.name));
      for (const name of buckets) evidence.set(name, { exists: live.has(name), owner: null });
    } catch {
      // Same. R2 carries no stamp either way, so a bucket is only ever context.
    }
  }
  return evidence;
}

/** Injectable seams for {@link checkProjectName} — the account probe, so a unit test never reaches one. */
export interface CheckProjectNameOptions {
  /** Account-evidence seam; defaults to {@link probeAccountEvidence}. */
  probeAccount?: AccountProbe;
}

/**
 * Probe the configured project name against what this project's wiring declares and what the account
 * holds.
 *
 * Never throws: a diagnostic command has to keep working in exactly the broken environment it exists to
 * diagnose, so every failure becomes a state rather than an exception. The account is consulted only when
 * there is a candidate to ask about — a healthy project pays for no network call at all.
 *
 * **The verdict is evidence-ranked, and shape is not evidence.** Proof first: a candidate database whose
 * `pithy_migrations_owner` stamp names its own segment was made by Pithy under that name, which is
 * `orphaned` and is the only state that says a resource is this project's. Then the local deduction: a
 * {@link wholesaleRename}, which is `drifted` and says only that the config and the wiring contradict each
 * other. Anything less — one legacy name, a mix of names, two unrelated foreign projects — is `ok`. It has
 * to be: the adopter who migrates an existing Worker in has all three, and none of them is a rename.
 *
 * **`requireProjectName`'s two refusals are taken apart rather than caught together.** It throws both for
 * an absent `name` and for a present-but-illegal one, and one `catch` around it turned the second into the
 * first — an illegal name reported as "not set", exiting 0, in the one command whose job is to name that
 * problem. So the config is read directly and the two are branched, through the same seams
 * `requireProjectName` itself uses ({@link isValidProjectName}, {@link kebab}) so no second rule exists here
 * to drift from it.
 *
 * **`null` means the question does not arise here.** There is a configured project name to check only if
 * the root `pithy.config.ts` could be read; when it could not — absent, or present and unloadable — this
 * declines to answer rather than inventing a verdict. Its caller already reports *which* of the two it was
 * (`doctor`'s `Project:` block: "no pithy.config.ts here", or "could not load — …"), and a second line
 * restating that fact in different words is how the message this replaced came to advise adding a key to a
 * file that did not exist. One fact, one line, in the block whose job it is.
 */
export async function checkProjectName(
  projectDir: string,
  options: CheckProjectNameOptions = {},
): Promise<ProjectNameCheck | null> {
  let config: ProjectConfig;
  try {
    config = await loadProject(projectDir);
  } catch {
    return null;
  }
  const configured = config.name;
  if (!configured) return { state: "unconfigured", project: null, misnamed: [] };
  if (!isValidProjectName(configured)) return { state: "invalid", project: configured, misnamed: [] };
  const project = kebab(configured);

  const { resources, unreadable } = await declaredResources(projectDir);
  const nothingToSay: ProjectNameCheck = {
    state: unreadable ? "could-not-check" : "ok",
    project,
    misnamed: [],
  };

  const candidates = misnamedResources(project, resources);
  if (candidates.length === 0) return nothingToSay;

  // The account comes from the config already loaded above — the same value `projectCloudflareAccount`
  // returns, without a second import of the adopter's `pithy.config.ts`. A project naming none passes
  // `null`, which is a claim about this project rather than an omission (#234).
  const account = loadProjectCloudflare(config) ?? null;
  const evidence = await (options.probeAccount ?? probeAccountEvidence)(candidates, account);
  const misnamed: MisnamedResource[] = candidates.map((entry) => {
    const found = evidence.get(entry.name);
    return { ...entry, provisioned: found ? found.exists : null, owner: found?.owner ?? null };
  });

  // Proof. Only a stamp that names the candidate's own segment says Pithy made it under that name, and
  // only the segments that were proven are reported — a second foreign project in the same wiring is not
  // implicated by the first one's stamp.
  const proven = new Set(misnamed.filter((entry) => entry.owner === entry.project).map((entry) => entry.project));
  if (proven.size > 0) {
    return { state: "orphaned", project, misnamed: misnamed.filter((entry) => proven.has(entry.project)) };
  }

  // Deduction. Nothing here claims a resource is ours; it says the two local sources of truth disagree.
  // Only on a *complete* read of the wiring: the deduction turns on the configured name appearing nowhere,
  // and a `wrangler.jsonc` that would not parse is exactly where it might have been. Proof above survives a
  // partial read — a stamp is a fact about one database — but an inference drawn from missing files is not
  // one, and `could-not-check` is the honest answer.
  if (!unreadable && wholesaleRename(project, resources, candidates)) {
    return { state: "drifted", project, misnamed };
  }

  return nothingToSay;
}

/** The old project name every mismatch leads with, deduplicated and joined — usually exactly one. */
function formerProjects(check: ProjectNameCheck): string {
  return [...new Set(check.misnamed.map((entry) => entry.project))].sort((a, b) => a.localeCompare(b)).join(", ");
}

/**
 * Why {@link isValidProjectName} refused this name, in the words of the rule itself.
 *
 * Asked of `assertValidProjectName` rather than restated, so the sentence stays true as that rule grows —
 * a second copy here would keep describing the charset long after another constraint started doing the
 * refusing, and doctor would name a rule the name does not break.
 */
function projectNameProblem(name: string): string {
  try {
    assertValidProjectName(name);
    return `"${name}" can't be a project name.`; // unreachable while the state is set by the same rule
  } catch (error) {
    if (!(error instanceof PithyError)) throw error;
    return `${error.payload.message} ${error.payload.action ?? ""}`.trim();
  }
}

/** The one-line report for `renderDoctorText`, and the `action` a failing state should prompt. */
export function describeProjectName(check: ProjectNameCheck): string {
  switch (check.state) {
    case "ok":
      return `${check.project} — every resource name matches`;
    case "unconfigured":
      return "not set (add `name` to pithy.config.ts — every resource name derives from it)";
    case "invalid":
      return `${projectNameProblem(check.project ?? "")} Nothing can be provisioned until it changes — pithy add, migrate, secrets, and token all refuse it.`;
    case "could-not-check":
      return "could not read every worker's wrangler.jsonc — nothing to compare the name against";
    // Says only what the files say: every name this project declares belongs to another project. It does
    // not claim those resources are ours — nothing has established that — so it names both readings of the
    // contradiction and asks for one of them, and it never suggests deleting anything.
    case "drifted": {
      // Plural by construction — `wholesaleRename` needs two distinct names before it will say anything.
      // Counted off `misnamed`, and phrased to claim exactly that: these are the names that lead with the
      // other project, not the whole declared set. The wiring can also hold names Pithy's rule could never
      // have produced — a hand-picked `legacy_store` is neither a candidate nor the configured name — so
      // "all N resource names this project declares" was a number the check had not established.
      const count = new Set(check.misnamed.map((entry) => entry.name)).size;
      return `${count} resource names this project declares lead with "${formerProjects(check)}", and none leads with ${check.project} — pithy would provision a second set beside them; rename the project, or rename the resources`;
    }
    // Proven, and still no deletion advice: the stamp establishes one database's provenance, not the whole
    // list's, and telling an adopter to delete a live database on anything less than certainty is the
    // failure mode this guards. The action covers both readings of a foreign stamp — a rename to undo, or a
    // binding pointed at another project's database, which `claimMigrationOwnership` refuses either way.
    case "orphaned": {
      const count = check.misnamed.filter((entry) => entry.owner === entry.project).length;
      const subject = count === 1 ? "1 resource is" : `${count} resources are`;
      return `${subject} stamped "${formerProjects(check)}" by pithy migrate, not ${check.project} — ${check.project} will never find ${count === 1 ? "it" : "them"} again; rename the project back, or move the data onto resources ${check.project} owns`;
    }
  }
}
