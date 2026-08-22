// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { applyDomains } from "./applyDomains";
import { writeFileAtomic } from "./atomic";
import {
  buildDomains,
  type DomainAnswer,
  describeZone,
  domainQuestions,
  renderDomainsBlock,
  renderDomainsConst,
  zoneForHostname,
} from "./domainPrompt";

/**
 * The interactive half of declaring where a Worker answers — the `@clack/prompts` calls `init` and
 * `worker add` both make.
 *
 * The decisions live in `domainPrompt.ts`, which is pure and tested. This file is the I/O around them:
 * fetching the account's zones when it can, asking, and reporting why it could not offer a picker.
 *
 * **Never required, and never blocking.** A project without a domain yet is legitimate — most are on the
 * first day — so an empty answer skips, and a run with no credentials still completes. `pithy init` has
 * never been a command that needs the network, and this does not make it one.
 */

/** The zones a picker can offer, or the reason there is no picker. */
interface ZoneLookup {
  zones: ZoneInfo[];
  /** Said out loud before falling back to free text, so an empty picker is never mistaken for an empty account. */
  note: string | null;
}

/**
 * Read the account's zones, or explain why not.
 *
 * Never throws. Every failure — no credentials, a token without `Zone:Read`, an unreachable account —
 * degrades to free text with a line saying so. Failing the command instead would make declaring a domain
 * impossible offline, which is exactly when someone is scaffolding.
 */
async function lookupZones(account: CloudflareAccountSelection | null): Promise<ZoneLookup> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    return { zones: [], note: "No Cloudflare credentials here, so zones cannot be listed. Type the domain instead." };
  }

  try {
    const zones = await new CloudflareClients({ accountId, apiToken }).zones().listZones();
    if (zones.length === 0) {
      return { zones: [], note: "This account has no zones yet. Type the domain anyway — add the zone before deploy." };
    }
    return { zones, note: null };
  } catch {
    return { zones: [], note: "Could not read this account's zones — the token may lack Zone:Read. Type the domain." };
  }
}

/** What `askDomains` decided, for the caller to report and to write. */
export interface AskedDomains {
  /** The declaration, or undefined when every environment was skipped. */
  domains: WorkerDomains | undefined;
  /** Whether anything was actually asked — a non-interactive run asks nothing. */
  prompted: boolean;
}

/**
 * Ask where a Worker answers, per environment, against the account's real zones.
 *
 * Returns `{ domains: undefined }` without asking anything when the session is not interactive: every
 * command must work non-interactively with full flags, and a required prompt would break that. An
 * adopter running headless declares `domains` in `pithy.config.ts` directly, which is the same thing this
 * writes.
 */
export async function askDomains(options: {
  projectDir: string;
  workerName: string;
  interactive: boolean;
  /**
   * The Cloudflare account whose zones the picker offers. Wrong account, wrong zone list — and a route
   * attached to a zone another account owns fails at deploy with an error naming neither problem.
   */
  account: CloudflareAccountSelection | null;
}): Promise<AskedDomains> {
  if (!options.interactive) return { domains: undefined, prompted: false };

  const { isCancel, note: showNote, select, text } = await import("@clack/prompts");
  const { zones, note } = await lookupZones(options.account);
  if (note) showNote(note);

  const answers: DomainAnswer[] = [];
  for (const question of domainQuestions(options.workerName)) {
    const hostname = await text({
      message: question.message,
      placeholder: question.placeholder,
      // Empty is a real answer here, so the prompt must not insist. Skipping leaves the resolver to fall
      // through to a route or `BASE_URL`, exactly as it does for a project predating the declaration.
      defaultValue: "",
    });
    if (isCancel(hostname)) {
      process.stderr.write("Canceled.\n");
      process.exit(1);
    }
    const value = String(hostname ?? "").trim();
    if (!value) continue;

    // With zones in hand, confirm the one that owns this hostname rather than inferring it. The
    // inference is right for `api.example.com` and wrong for a nested or multi-part-suffix zone, and
    // getting it wrong produces a route Cloudflare refuses with an error naming neither value.
    let zone: string | undefined;
    if (zones.length > 0) {
      const owning = zoneForHostname(value, zones);
      const choice = await select({
        message: `Zone for ${value}`,
        options: zones.map((candidate) => ({ value: candidate.name, label: describeZone(candidate) })),
        ...(owning ? { initialValue: owning.name } : {}),
      });
      if (isCancel(choice)) {
        process.stderr.write("Canceled.\n");
        process.exit(1);
      }
      zone = String(choice);
    }

    answers.push({ env: question.env, hostname: value, ...(zone ? { zone } : {}) });
  }

  const built = buildDomains(answers);
  if ("rejected" in built) {
    throw new ValidationError({ message: built.rejected.message, action: built.rejected.action });
  }
  return { domains: built.domains, prompted: true };
}

/**
 * Write a declaration into a Worker: the `domains` block in its `pithy.config.ts`, and the `routes` and
 * `vars.BASE_URL` generated from it.
 *
 * Both, always, and in that order. Writing only the declaration would leave a Worker that says where it
 * answers and a `wrangler.jsonc` that does not route there; writing only the generated values would put
 * the truth in the file this whole feature exists to stop hand-maintaining.
 */
export async function writeDomains(workerDir: string, domains: WorkerDomains): Promise<{ declared: boolean }> {
  const declared = await writeDomainsDeclaration(workerDir, domains);
  await applyDomains(workerDir, domains);
  return { declared };
}

/** The hoisted declaration a scaffolded config carries: `const DOMAINS = {` through its closing `};`. */
const DOMAINS_CONST = /^const DOMAINS = \{\n(?:.*\n)*?\};$/m;

/**
 * Write the domains a scaffolded Worker's `pithy.config.ts` declares.
 *
 * **Two shapes, in this order, and the first one is what the scaffold now emits.** A config scaffolded
 * today hoists the declaration above the object —
 *
 * ```ts
 * const DOMAINS = { … };
 * export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);
 * const config = { domains: DOMAINS, … };
 * ```
 *
 * — because the origin has to be derivable *before* the capabilities that need it are constructed, and a
 * value nested inside the object literal cannot be read by the same literal (#256). So the writer fills
 * the const, and the `domains: DOMAINS` key beside it is left exactly as it is.
 *
 * Filling the const is not optional politeness. The previous shape inserted a `domains: { … }` key after
 * `const config = {`, guarded only by "does this file already mention a `domains:` key" — and a hoisted
 * config mentions one, `domains: DOMAINS`. So against the scaffold this feature exists to produce, that
 * writer either declined to write at all or, without the guard, wrote a **second** `domains` key into the
 * same object literal, where the last one silently wins.
 *
 * The second shape is the older one: no const, no `domains:` key, so the block goes in after
 * `const config = {`, at the top of the object where an adopter reads it first. That keeps a project
 * scaffolded before this working.
 *
 * A config matching neither is left alone rather than edited blind: returning false lets the caller say
 * the declaration could not be written and print it for the adopter to paste, which is a better outcome
 * than a corrupted config file.
 */
async function writeDomainsDeclaration(workerDir: string, domains: WorkerDomains): Promise<boolean> {
  const path = join(workerDir, "pithy.config.ts");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return false;
  }

  // The hoisted const wins, and is checked first: a scaffolded config has *both* the const and a
  // `domains:` key, so testing for the key first would send every current project down the older path.
  if (DOMAINS_CONST.test(source)) {
    // A replacement function, so a `$` in a hostname is not read as a capture reference.
    const filled = source.replace(DOMAINS_CONST, () => renderDomainsConst(domains));
    await writeFileAtomic(path, filled);
    return true;
  }

  // Line-anchored, not `includes`. A bare substring match also fires on a comment mentioning `domains:`,
  // on a nested key, and on the word inside a string — any of which would silently skip a write the
  // adopter asked for.
  if (/^\s*domains\s*:/m.test(source)) return false;
  const anchor = source.indexOf("const config = {");
  if (anchor === -1) return false;
  const insertAt = source.indexOf("\n", anchor) + 1;
  if (insertAt === 0) return false;

  await writeFileAtomic(path, `${source.slice(0, insertAt)}${renderDomainsBlock(domains)}\n${source.slice(insertAt)}`);
  return true;
}
