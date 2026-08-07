// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { isProvisionedBinding } from "@pithy-sh/core/src/capability/bindings";
import type { DevSecret } from "@pithy-sh/core/src/capability/devSecret";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { encodeVersionedValue, initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { DEV_SECRETS_FILE, type DevSecretsFile, initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { mintDevValue } from "@pithy-sh/secrets/src/devValue";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { SECRETS_CAPABILITY } from "@pithy-sh/secrets/src/manager/dispatcher";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { writeDevVars } from "../devSecrets/devVars";
import { readDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { ownProperties } from "../devSecrets/records";
import { renderDevSecretsNotes, renderDevVarsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, ourOwnInjection, seedProjectDevSecrets } from "../devSecrets/seed";

export interface AddBootstrapOptions {
  /**
   * The project root — owner of the one shared `.dev.vars` every worker symlinks to, so a value written
   * here reaches every worker at once. The Worker directory would be the wrong file: it is a symlink,
   * and a project with two workers would get two divergent keys.
   */
  projectDir: string;
  /** The manifest of the capability just wired — the authority on which bindings it needs. */
  manifest: CapabilityManifest;
  /**
   * Seam: seed the whole project's dev secrets. Defaults to the real seeder, with `reload` on.
   *
   * It is a seam because this function and the seeder can reach the *same* refusal in one run, and the
   * only way to prove they say it once is to make both of them say it.
   */
  seed?: (projectDir: string) => Promise<DevSecretsSeedReport>;
}

/**
 * Finish `pithy add` for the values `add` itself cannot write, and say plainly what is left.
 *
 * Two kinds of gap, and only one of them is loud. A **binding** `add` cannot write — a Secrets Store
 * entry, a Workflow, a Vectorize index — makes the Worker refuse its first request naming what is
 * absent. A **registry secret** is read lazily, so the app boots healthy, `/health` is green, and the
 * failure arrives at the first sign-in or the first tracked link as `secrets/not_found` on a name the
 * adopter has never heard of. Both are handled here: where a *dev* value can be minted honestly, it is
 * minted; where it cannot, the command names the provision command that creates it — at the moment the
 * adopter is thinking about the capability rather than in a doc they read later.
 *
 * Returns the lines to print (`AddResult.notes`), in order. Nothing here ever prints a value.
 */
export async function bootstrapAdd({ projectDir, manifest, seed }: AddBootstrapOptions): Promise<string[]> {
  const notes: string[] = [];
  for (const binding of manifest.requiredBindings) {
    // Optional bindings are skipped for the same reason `validateBindings` skips them: nothing refuses
    // a request over one, so a note would send the adopter provisioning what their app never asks for.
    if (binding.optional || !isProvisionedBinding(binding.type)) continue;
    if (isMasterKey(manifest, binding)) notes.push(...(await ensureDevMasterKey(projectDir)));
    else notes.push(provisionNote(manifest.name, binding));
  }
  notes.push(...(await ensureDevSecrets(projectDir, manifest.devSecrets)));
  // Last, and over the whole project rather than this capability: the value just minted has to reach the
  // local `SECRETS` store to be worth anything, and so does every value already in the file that a
  // previous run could not seed — `pithy add secrets` is exactly the run that makes the store openable.
  // Never fatal. A project whose store is not wired yet gets a reason, not a failed `pithy add`.
  //
  // **`reload`, because this process is holding a stale config.** `pithy add` rewrote the Worker's
  // `pithy.config.ts` several steps ago, and the module it imported before that write is the one still
  // in the ESM cache — so the aggregate registry seeded against is the composition from *before* the
  // add, and the secret this same run has just minted is not in it. It reached the store only on some
  // later, unrelated command, which is what made it look like a store problem.
  const seedProject = seed ?? ((dir: string) => seedProjectDevSecrets({ projectDir: dir, reload: true }));
  notes.push(...renderDevSecretsNotes(await seedProject(projectDir)));
  // **Deduplicated, in order.** Two halves of this function reach the same refusal in one run — the
  // mint above, and the seeder that has just tried the same write for the same project. Both must be
  // able to speak (a project that has not composed `secrets` has no targets, so only the first one
  // does), and printing one sentence twice reads as two problems. An adopter counts lines.
  return [...new Set(notes)];
}

/** The secrets capability's master-key binding — the one provisioned binding with an honest dev value. */
function isMasterKey(manifest: CapabilityManifest, binding: BindingSpec): boolean {
  return manifest.name === SECRETS_CAPABILITY && binding.name === MASTER_KEY_BINDING;
}

/**
 * What a binding needs that only provisioning can supply. `pithy <capability> provision` is the command
 * in every case — each capability that owns provisioned resources subcommands its own name.
 */
function provisionNote(capability: string, binding: BindingSpec): string {
  return `${binding.name} is created by pithy ${capability} provision. Nothing local stands in for it.`;
}

/**
 * Mint this project's dev master key into `.dev.vars`, unless one is already there.
 *
 * **A fresh key per project, never a literal.** One key shipped in a template is one key across every
 * adopter, and the first person to copy it into a deployed environment hands everyone else their
 * secrets. `initialMasterKeyConfig` generates one.
 *
 * **Only when absent** — the same rule `ensureMasterKey` states for the provisioned key. Replacing the
 * key orphans every secret already stored under it, and re-running `pithy add secrets` must be a no-op.
 * An *empty* value is treated as absent: nothing could have been encrypted under it, so there is
 * nothing to orphan, and leaving it would leave `pithy dev` refusing every request.
 *
 * **`.dev.vars`, never `.dev.vars.example`.** The former is gitignored; the latter is committed, and a
 * key written into it is a key in the repository.
 */
async function ensureDevMasterKey(projectDir: string): Promise<string[]> {
  const path = join(projectDir, ".dev.vars");
  const existing = parseDevVars(await readFile(path, "utf8").catch(() => ""));
  if (existing[MASTER_KEY_BINDING]) {
    return [`${MASTER_KEY_BINDING} is already in .dev.vars. Left as it is — a new key orphans every stored secret.`];
  }
  // Stringified, because that is the shape the binding has in a deployed worker too: the Secrets Store
  // holds the same JSON, and `resolveEncryptionConfig` parses one string in both places.
  //
  // Through `writeDevVars`, like every other value that has to reach a Worker. The master key is the
  // clearest case for it: written to the project root alone it never arrived, and the Worker answered
  // `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS` on a project that had just minted one.
  const wrote = await writeDevVars({
    projectDir,
    values: { [MASTER_KEY_BINDING]: JSON.stringify(await initialMasterKeyConfig()) },
  });
  // Everything the write has to say, not only its refusals. A Worker shadowing the project's `.dev.vars`
  // or one the link could not be made into is a Worker with no master key, and this used to mint one,
  // announce it, and say nothing about the Worker that never got it.
  const delivery = renderDevVarsNotes(wrote);
  if (wrote.written.length === 0) return delivery;
  return [
    `Minted a dev master key into .dev.vars as ${MASTER_KEY_BINDING}. Local only.`,
    "Deployed environments get theirs from pithy secrets provision.",
    ...delivery,
  ];
}

/**
 * Mint a dev value for every secret this capability declares as generatable, unless one is already there.
 *
 * **The capability decides, not this file.** Each value comes from a `devSecrets` entry the capability
 * ships in its own manifest, mirroring the `devValue` on the registry entry that owns the secret. A
 * list of names here would drift the moment a capability shipped another one — and drift silently,
 * because a missing lazily-read secret is invisible until the code path that reads it runs.
 *
 * **`.dev.secrets.jsonc`, not `.dev.vars` (#149).** Only the destination changed; the declaration and
 * the minting are the ones `pithy add` has always done. `.dev.vars` is wrangler's file — env bindings,
 * `UPPER_SNAKE` — and a kebab secret name sitting in it taught every adopter that one of the two
 * conventions was a mistake. The value is written as a full version-1 envelope, which is the shape the
 * store actually holds, so dev stops being a shape production never sees.
 *
 * **And the value is injected into `.dev.vars` as well. That is a TRANSITION, not the design (#153).**
 * `secretsStore`'s dev branch resolves every secret from its injected binding regardless of backend,
 * so the new file alone is a place dev never reads: writing only there gave a fresh project a Worker
 * that answers `secrets/not_found` at the first sign-in. The seeder does the same for every value the
 * local `SECRETS` store holds — but it needs a registry, and a project that has not composed `secrets`
 * yet has none, so a mint here must carry itself across. #153 routes dev by backend and deletes both
 * halves in one commit. Until then, deleting this line breaks `pithy add auth`.
 *
 * **Only when absent, from either file.** A session secret replaced is every live session invalidated;
 * a link-signing key replaced is every link already in an inbox broken.
 *
 * **The file is consulted first, then `.dev.vars`.** A name in both is this command's own pair, and it
 * says so. A name in `.dev.vars` *alone* is the migration case: an existing project has the value
 * there, dev reads it, and minting a second one would leave two values with nothing to say which
 * signed what. Rewriting their `.dev.vars` unasked is worse. So the note says where it is and where it
 * belongs, and `pithy doctor` repeats it every run until they move it.
 *
 * **But only an adopter's line is that case.** The transition injects an encoded envelope under the
 * same name, so once a project had been seeded, deleting the secret from `.dev.secrets.jsonc` — the
 * obvious way to ask for a fresh one — met "auth-session-secret is in .dev.vars, where secrets no
 * longer live. Move it." about a line pithy had written itself, an hour earlier, on purpose.
 * `ourOwnInjection` is the same discriminator the seeder uses, for the same reason.
 *
 * One write for the whole set, so a capability declaring several either lands them all or lands none.
 */
async function ensureDevSecrets(projectDir: string, declared: readonly DevSecret[]): Promise<string[]> {
  if (declared.length === 0) return [];
  // Prototype-free: a secret named `constructor` must not read back `Object.prototype.constructor` and
  // be reported as already in a `.dev.vars` the project does not have. See {@link ownProperties}.
  const inDevVars = ownProperties(parseDevVars(await readFile(join(projectDir, ".dev.vars"), "utf8").catch(() => "")));
  const stated = await readDevSecrets(projectDir);
  const minted: DevSecretsFile = {};
  const notes: string[] = [];
  for (const secret of declared) {
    if (stated[secret.name]) {
      notes.push(
        `${secret.name} is already in ${DEV_SECRETS_FILE}. Left as it is — a new value invalidates what the old one signed.`,
      );
      continue;
    }
    const existing = inDevVars[secret.name];
    if (existing !== undefined && existing !== "" && !ourOwnInjection(existing)) {
      notes.push(
        `${secret.name} is in .dev.vars, where secrets no longer live. Move it into ${DEV_SECRETS_FILE} as { "currentVersion": "1", "versions": { "1": <value> } }. Nothing was rewritten.`,
      );
      continue;
    }
    minted[secret.name] = initialDevSecret(mintDevValue(secret.devValue));
    notes.push(
      `Minted a dev ${secret.name} into ${DEV_SECRETS_FILE}. Local only.`,
      `Deployed environments need pithy secrets create ${secret.name}.`,
    );
  }
  const written = await writeDevSecrets(projectDir, minted);
  // A refusal replaces the mint notes rather than joining them. "Minted a dev auth-session-secret"
  // beside "nothing was written" is two claims about one value, and the adopter acts on the first.
  if (written.refused) return [written.refused];
  // TRANSITION (#153): the same values, injected. Only what actually landed in the file — claiming a
  // mint the write did not make would put a value in `.dev.vars` that nothing else in the project has.
  return [...notes, ...(await injectDevSecrets(projectDir, pick(minted, written.added)))];
}

/** The entries of `file` named in `names`. */
function pick(file: DevSecretsFile, names: readonly string[]): DevSecretsFile {
  const picked: DevSecretsFile = {};
  for (const name of names) {
    const envelope = file[name];
    if (envelope) picked[name] = envelope;
  }
  return picked;
}

/**
 * **TRANSITION (#153).** Inject each minted value into `.dev.vars` under its registry name, encoded as
 * the envelope — the shape the store holds and `decodeInjectedValue` round-trips, rather than the bare
 * string dev used to be handed. Deleted when dev's read path routes by backend.
 *
 * Every envelope here was made by `initialDevSecret(mintDevValue(...))` moments ago, so it has exactly
 * one version and that version is a string. Nothing is inferred about the registry — this path runs
 * before any registry is loadable, which is the whole reason it exists — and a value that is somehow
 * neither is skipped rather than coerced. The seeder consults the real entry on the next run.
 */
async function injectDevSecrets(projectDir: string, file: DevSecretsFile): Promise<string[]> {
  const vars: Record<string, string> = {};
  for (const [name, envelope] of Object.entries(file)) {
    const value = envelope.versions[envelope.currentVersion];
    if (typeof value !== "string") continue;
    vars[name] = encodeVersionedValue(initialVersionedValue(value));
  }
  if (Object.keys(vars).length === 0) return [];
  const wrote = await writeDevVars({ projectDir, values: vars });
  // The whole delivery report, for the same reason the master key's is: dev reads this copy and nothing
  // else until #153, so a Worker the copy did not reach has the secret in two files and none of them.
  return renderDevVarsNotes(wrote);
}
