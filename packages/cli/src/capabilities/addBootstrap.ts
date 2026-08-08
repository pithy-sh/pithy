// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { isProvisionedBinding } from "@pithy-sh/core/src/capability/bindings";
import type { DevSecret } from "@pithy-sh/core/src/capability/devSecret";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { type DevSecretsFile, initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { mintDevValue } from "@pithy-sh/secrets/src/devValue";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { SECRETS_CAPABILITY } from "@pithy-sh/secrets/src/manager/dispatcher";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { readBootstrapVars } from "../devSecrets/bootstrapVars";
import { readDevVarsSource, writeDevVars } from "../devSecrets/devVars";
import { readDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { ownProperties } from "../devSecrets/records";
import { renderDevSecretsNotes, renderDevVarsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, seedProjectDevSecrets } from "../devSecrets/seed";

export interface AddBootstrapOptions {
  /**
   * The project root. A bootstrap value is recorded against the *project*, not a Worker, so one master
   * key reaches every Worker's generated `.dev.vars` (#154) — a per-Worker mint would give a project with
   * two Workers two divergent keys and orphan whichever secrets the loser encrypted.
   */
  projectDir: string;
  /** The manifest of the capability just wired — the authority on which bindings it needs. */
  manifest: CapabilityManifest;
  /**
   * Seam: seed the whole project's dev secrets. Defaults to the real seeder, with `reload` on.
   *
   * It is a seam because this function and the seeder can reach the *same* sentence in one run, and the
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
  // **Deduplicated, in order.** Two `.dev.vars` writes happen in one run — the master key above, and
  // the seeder's `cf-secrets-store` values — and both report delivery against the same Worker
  // directories, so a Worker shadowing the project's file produces the same sentence twice. Both must
  // be able to speak (a project that has not composed `secrets` has no targets, so only the first one
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
 * Put this project's dev master key where every Worker's generated `.dev.vars` will pick it up, unless
 * one is already recorded.
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
 * **A key in a pre-#154 project's root `.dev.vars` is adopted, never re-minted.** That file used to be
 * the store, and it is the one value whose replacement cannot be undone: every secret already encrypted
 * under the old key becomes unreadable, with no error that names the cause. So the old key is carried
 * into the bootstrap store as it stands, and the project keeps reading what it already wrote. Their file
 * is not rewritten — nothing here ever rewrites an adopter's `.dev.vars`.
 */
async function ensureDevMasterKey(projectDir: string): Promise<string[]> {
  const recorded = (await readBootstrapVars(projectDir))[MASTER_KEY_BINDING];
  if (recorded) {
    return [`${MASTER_KEY_BINDING} is already recorded. Left as it is — a new key orphans every stored secret.`];
  }
  // Through the writer's own reader: only `ENOENT` is "no key here". `.catch(() => "")` answered that
  // for every errno, so an unreadable file read as absent and this minted a second key — and a second
  // master key orphans every secret the first one encrypted, which is what this function exists to
  // prevent. See {@link readDevVarsSource}.
  const legacy = parseDevVars((await readDevVarsSource(join(projectDir, ".dev.vars"))) ?? "")[MASTER_KEY_BINDING];
  // Stringified, because that is the shape the binding has in a deployed worker too: the Secrets Store
  // holds the same JSON, and `resolveEncryptionConfig` parses one string in both places.
  const value = legacy && legacy !== "" ? legacy : JSON.stringify(await initialMasterKeyConfig());
  // Through `writeDevVars`, like every other value that has to reach a Worker: it records the value and
  // regenerates every Worker's file from it. Written to the project root alone, the key never arrived —
  // the Worker answered `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS` on a project that
  // had just minted one.
  const wrote = await writeDevVars({ projectDir, values: { [MASTER_KEY_BINDING]: value } });
  // Everything the write has to say, not only its refusals. A Worker whose `.dev.vars` pithy may not
  // write is a Worker with no master key, and this used to mint one, announce it, and say nothing about
  // the Worker that never got it.
  const delivery = renderDevVarsNotes(wrote);
  if (wrote.written.length === 0) return delivery;
  if (legacy && legacy !== "") {
    return [
      `Adopted the ${MASTER_KEY_BINDING} already in .dev.vars. A new key would orphan every secret the old one encrypted.`,
      ...delivery,
    ];
  }
  return [
    `Minted a dev master key as ${MASTER_KEY_BINDING}. Local only, and it reaches each Worker's generated .dev.vars.`,
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
 * **The secrets file, not `.dev.vars` (#149), and that file is outside the checkout (#156).** Only the
 * destination changed; the declaration and the minting are the ones `pithy add` has always done.
 * `.dev.vars` is wrangler's file — env bindings, `UPPER_SNAKE` — and a kebab secret name sitting in it
 * taught every adopter that one of the two conventions was a mistake. The value is written as a full
 * version-1 envelope, which is the shape the store actually holds, so dev stops being a shape
 * production never sees. **Every note here names the absolute path**, because nothing in the project
 * does: "already in the secrets file" is not actionable if the reader cannot open it.
 *
 * **Only when the secrets file lacks it.** A session secret replaced is every live session invalidated;
 * a link-signing key replaced is every link already in an inbox broken.
 *
 * **A copy in `.dev.vars` no longer counts as having it (#153).** It used to: dev resolved every secret
 * from its injected binding, so minting beside one produced two live values with nothing to say which
 * signed what, and the honest answer was to refuse and say where it belonged. Dev reads the seeded row
 * now, so that line signs nothing — refusing over it would leave the Worker with no session key at all,
 * which is the failure this whole function exists to prevent. So the mint happens and the note names the
 * stranded line. Nothing rewrites their `.dev.vars`; the value is still there if they want it, and
 * `pithy doctor` repeats it every run until it is deleted.
 *
 * One write for the whole set, so a capability declaring several either lands them all or lands none.
 */
async function ensureDevSecrets(projectDir: string, declared: readonly DevSecret[]): Promise<string[]> {
  if (declared.length === 0) return [];
  // Prototype-free: a secret named `constructor` must not read back `Object.prototype.constructor` and
  // be reported as sitting in a `.dev.vars` the project does not have. See {@link ownProperties}.
  //
  // And read honestly: `.catch(() => "")` on an unreadable file said "nothing here" for every errno, so
  // a stranded line went unmentioned. It costs a sentence, not a value. See {@link readDevVarsSource}.
  const source = (await readDevVarsSource(join(projectDir, ".dev.vars"))) ?? "";
  const inDevVars = ownProperties(parseDevVars(source));
  const path = await resolveDevSecretsFile(projectDir);
  const stated = await readDevSecrets(path);
  const minted: DevSecretsFile = {};
  const notes: string[] = [];
  for (const secret of declared) {
    if (stated[secret.name]) {
      notes.push(
        `${secret.name} is already in ${path}. Left as it is — a new value invalidates what the old one signed.`,
      );
      continue;
    }
    minted[secret.name] = initialDevSecret(mintDevValue(secret.devValue));
    notes.push(
      `Minted a dev ${secret.name} into ${path}. Local only.`,
      `Deployed environments need pithy secrets create ${secret.name}.`,
    );
    const stranded = inDevVars[secret.name];
    if (stranded !== undefined && stranded !== "") {
      notes.push(
        `${secret.name} is also in .dev.vars, which dev no longer reads. Nothing was rewritten — delete that line, or move its value into ${path} as { "currentVersion": "1", "versions": { "1": <value> } }.`,
      );
    }
  }
  await writeDevSecrets(path, minted);
  return notes;
}
