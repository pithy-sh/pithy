// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { CloudflareNotConfiguredError, cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";

/** Scopes attached to every secret we create. CF requires at least one; "workers" is the bind target. */
const DEFAULT_SCOPES = ["workers"] as const;

/**
 * One secret in the store, decoded from the CF list response. CF Secrets Store never returns
 * plaintext over REST — values are bind-only by design — so this carries only metadata. The
 * `created`/`modified` ISO strings decode through `JsonDate` to real `Date`s at the wire boundary.
 */
export const CfSecretEntry = z
  .object({
    id: z.string().describe("The CF-assigned secret identifier, used to address delete by id."),
    name: z.string().describe("The secret's name within the store (the key the CLI references)."),
    status: z.enum(["pending", "active", "deleted"]).describe("The secret's lifecycle status in the store."),
    created: JsonDate.describe("When the secret was created (ISO string on the wire, Date in app)."),
    modified: JsonDate.describe("When the secret was last modified (ISO string on the wire, Date in app)."),
    comment: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Freeform text Cloudflare stores beside the value and returns on list and get. The one field of an entry a write sets and a read answers, so it is the only REST-readable fact *about* a value — never key material, and never a substitute for reading the value through its binding. Nullable **and** optional because the live API returns an explicit `null` for an entry nothing annotated, not an absent key: declared `.optional()` alone, every list against a store holding one un-annotated entry failed its own schema and threw `cloudflare/invalid_response`, which took `entriesNamed` and therefore the rotation's edit-only write with it. Found against a real store, not a mock (#647).",
      ),
  })
  .describe("A single Cloudflare Secrets Store secret's metadata (never its plaintext value).");
export type CfSecretEntry = z.output<typeof CfSecretEntry>;

/** What {@link CloudflareSecretsStoreManager.createSecretIfAbsent} did — see it for each value. */
export type CreateSecretOutcome = "created" | "present" | "unconfirmed";

/** Oldest first, the smaller id breaking a tie — one order whoever asks, so two readers never disagree. */
function byAge(a: CfSecretEntry, b: CfSecretEntry): number {
  return a.created.getTime() - b.created.getTime() || a.id.localeCompare(b.id);
}

/**
 * A `deleted` entry is not there (#643); a `pending` one is, since creating over it would duplicate it.
 * Cloudflare lists the three statuses without saying what each means, and a deleted entry is the one
 * reading that cannot be "there".
 */
function isLive(entry: CfSecretEntry): boolean {
  return entry.status !== "deleted";
}

/**
 * The `comment` a write sends, or no such field at all when the caller passed none.
 *
 * Omitted rather than sent empty, so a write with no comment is byte-identical to what this manager
 * sent before the field existed — and so a caller that has nothing to say cannot blank an annotation
 * somebody else wrote. The comment is a plain string here on purpose: what belongs in one is
 * `@pithy-sh/secrets`' question, and the codec lives where it is read rather than where it is posted.
 */
function commentField(comment: string | undefined): { comment?: string } {
  return comment === undefined ? {} : { comment };
}

/** Config for the Secrets Store manager: the shared client config plus the store it targets. */
export interface SecretsStoreManagerConfig extends CloudflareManagerConfig {
  /** The CF Secrets Store id (the REST API addresses stores by id). */
  storeId: string;
}

/**
 * Out-of-Worker access to the account-level Cloudflare Secrets Store over the REST API: provisioning
 * and audit from a CLI/CI context. Inside a Worker, secret values resolve via bindings — this manager
 * is the REST counterpart for managing the store, addressed by store id.
 *
 * CF Secrets Store does not expose secret plaintext via REST (values are bind-only by design), so
 * there is no `getSecret`. The provisioning and audit flows only need put, delete, and list.
 */
export class CloudflareSecretsStoreManager extends CloudflareManager {
  private readonly storeId: string;

  constructor(config: SecretsStoreManagerConfig) {
    super(config);
    if (!config.storeId) {
      throw new CloudflareNotConfiguredError({ detail: "Missing storeId for Secrets Store REST access." });
    }
    this.storeId = config.storeId;
  }

  getServiceType(): string {
    return "Cloudflare Secrets Store";
  }

  /** Prove access by listing the store's secrets. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.listSecrets();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Insert or update a secret. An existing entry is updated in place via `edit`; otherwise a fresh
   * secret is created.
   *
   * `edit` is what makes this safe. The old value is overwritten, never deleted first, so a failed
   * update leaves the prior value intact and bound — there is no window where the secret is absent
   * from the store (which, for a secret like the master encryption key, is a platform-level outage).
   * Scopes are re-sent so an entry converges on the same shape whichever branch wrote it.
   *
   * **It upserts, and at a name nothing reads that is the whole problem.** A caller replacing a value
   * that must already exist wants {@link updateExistingSecret}: here a stale or misspelled name finds
   * nothing, creates an entry, and answers 200 — leaving live key material at an address no binding
   * resolves while the value the caller meant to replace goes on being served. This one is for a
   * caller that genuinely means either branch.
   *
   * `comment` is the non-secret text written beside the value, and the only thing about a value REST
   * can read back. Omit it and whatever comment is on the entry is left exactly as it stands.
   */
  async putSecret(name: string, value: string, comment?: string): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing) {
      await this.createSecret(name, value, comment);
      return;
    }

    await cloudflareRequest(`put secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.edit(existing.id, {
        account_id: this.accountId,
        store_id: this.storeId,
        value,
        scopes: [...DEFAULT_SCOPES],
        ...commentField(comment),
      }),
    );
  }

  /**
   * Create a secret only if no entry of that name is there, and say what happened — never "somebody else did"
   * when this call cannot know that.
   *
   * - `created` — this call's create landed, and no older entry of the name exists beside it.
   * - `present` — an entry of the name was there before this call, or appeared beside this one's and is older;
   *   in the second case this call's own entry is deleted, so exactly one entry of the name remains.
   * - `unconfirmed` — the create threw, and an entry of the name is there now. It may be this call's own, landed
   *   server-side before the response was lost, or another run's. Nothing can tell which (F1 of #643's review), so
   *   the answer says so rather than guess, and a caller must not make correctness depend on who created it.
   *
   * **Never an overwrite, even in a race (#643)**, and **never reliant on the store refusing a duplicate name**:
   * Cloudflare does not document that it does. So after a create lands, the entries of that name are listed, and
   * if another is older this one is the loser and removes itself. The oldest wins, deterministically, whichever
   * run looks. A failure with no entry there afterwards — an outage, a refused token — is thrown as it came.
   */
  async createSecretIfAbsent(name: string, value: string, comment?: string): Promise<CreateSecretOutcome> {
    if (await this.findByName(name)) return "present";
    let ownId: string | undefined;
    try {
      ownId = await this.createSecret(name, value, comment);
    } catch (error) {
      if (await this.findByName(name)) return "unconfirmed";
      throw error;
    }
    const oldest = (await this.entriesNamed(name))[0];
    if (oldest === undefined || ownId === undefined || oldest.id === ownId) return "created";
    // Another run's entry of the same name is older: it is the one that stands.
    await cloudflareRequest(`delete duplicate secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.delete(ownId as string, {
        account_id: this.accountId,
        store_id: this.storeId,
      }),
    );
    return "present";
  }

  /**
   * Write a value to an entry that must already be there, refusing to create one.
   *
   * **The verb that exists because {@link putSecret} upserts.** A put addressed to a name nothing reads
   * — a composed name gone stale, a misspelled binding, an environment segment that never got
   * substituted — finds no entry, creates one, and answers 200. The caller hears success, the value it
   * meant to replace is untouched and still bound, and an orphan entry nobody reads sits in the store
   * holding live key material. That is how a sibling codebase lost an environment's secrets: the
   * master-key envelope went to a name the `SECRETS_ENCRYPTION_KEYS` binding does not resolve, every
   * row was re-encrypted under the new key, and the binding kept serving the old one. Nothing returned
   * an error, anywhere.
   *
   * So the create branch is removed rather than guarded. A caller replacing a value has already
   * asserted the entry exists — it is bound, something reads it — and where that assertion is false the
   * honest answer is a refusal before any write, not a second entry. {@link createSecretIfAbsent}
   * establishes a secret, this replaces one, and `putSecret` stays for a caller that means either.
   *
   * **Two live entries of one name is a refusal too, and the same one in spirit.** The oldest wins
   * everywhere else here, which is right for a create that raced. It is wrong for a replace: editing
   * one of two is a coin toss over which value the binding goes on serving. The store is ambiguous, so
   * the caller is told, before anything is written.
   *
   * Name-addressed rather than id-addressed, deliberately: the name is what a caller composes and what
   * a binding resolves, so addressing by it keeps the misaddressing this verb exists to catch inside
   * the one thing that can catch it. Returns the entry id written, so a caller reading back afterwards
   * can assert it is looking at the same address. `comment` is written beside the value when given.
   */
  async updateExistingSecret(name: string, value: string, comment?: string): Promise<string> {
    const named = await this.entriesNamed(name);
    const target = named[0];
    if (!target) {
      throw new NotFoundError({
        message: `Secret '${name}' is not in the store, so there is nothing to update.`,
        action: "Run `pithy secrets provision` to establish the entry, then run this again.",
        detail: `update secret ${name}: no live entry of that name, and this verb never creates one`,
      });
    }
    if (named.length > 1) {
      throw new ConflictError({
        message: `Secret '${name}' names ${named.length} live entries in the store, so a replacement is ambiguous.`,
        action: "Delete the entries nothing binds from the Secrets Store in the Cloudflare dashboard, then re-run.",
        detail: `update secret ${name}: ${named.map((entry) => entry.id).join(", ")}`,
      });
    }
    await cloudflareRequest(`update secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.edit(target.id, {
        account_id: this.accountId,
        store_id: this.storeId,
        value,
        scopes: [...DEFAULT_SCOPES],
        ...commentField(comment),
      }),
    );
    return target.id;
  }

  /** Delete a secret by name. Resolves the id via `listSecrets`, then issues DELETE by id. */
  async deleteSecret(name: string): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing) {
      throw new NotFoundError({
        message: `Secret '${name}' was not found in the store.`,
        detail: `delete secret ${name}: no entry with that name`,
      });
    }
    await cloudflareRequest(`delete secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.delete(existing.id, {
        account_id: this.accountId,
        store_id: this.storeId,
      }),
    );
  }

  /**
   * Delete a secret, treating an absent one as already done.
   *
   * The typed not-found on {@link deleteSecret} is right for a caller that named a specific secret and
   * needs to hear it was not there. It is wrong for anything reconciling toward absence — teardown, a
   * reaper, a re-run of a provisioning step — where "gone" is the goal and a second delete is a no-op,
   * not a failure. Two callers race on the store all the time: another runner's sweep, or a listing that
   * has not caught up.
   *
   * Given as its own method rather than a flag, so which semantics a call site wants is legible at the
   * call site. The alternative every caller reaches for otherwise is `.catch(() => {})`, which also
   * swallows the auth failure and the outage — and a teardown that swallows is how debris becomes
   * permanent with no signal at all.
   */
  async deleteSecretIfPresent(name: string): Promise<boolean> {
    const existing = await this.findByName(name);
    if (!existing) return false;
    await cloudflareRequest(`delete secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.delete(existing.id, {
        account_id: this.accountId,
        store_id: this.storeId,
      }),
    );
    return true;
  }

  /**
   * List every secret in the store. The SDK auto-paginates via `for await`, so callers receive the
   * full set in one array. Each entry is Zod-validated (`CfSecretEntry`) at the wire boundary.
   */
  async listSecrets(): Promise<CfSecretEntry[]> {
    return cloudflareRequest("list secrets", async () => {
      const out: CfSecretEntry[] = [];
      for await (const entry of this.getClient().secretsStore.stores.secrets.list(this.storeId, {
        account_id: this.accountId,
      })) {
        out.push(decodeResponse(CfSecretEntry, entry, "Secrets Store list entry"));
      }
      return out;
    });
  }

  /**
   * Every live entry carrying this name, oldest first.
   *
   * **The plural is the point.** Cloudflare does not document that the store refuses a duplicate name,
   * and #643 established that it does not — so "the entry named X" is a claim rather than a given. A
   * caller whose correctness depends on there being exactly one checks `length` here and says what it
   * wants done when the store disagrees; {@link findByName} is the answer for a caller that only needs
   * the entry the rest of this manager would act on.
   *
   * **A `deleted` entry is not one** (#643): Cloudflare lists a secret's lifecycle status as `pending`,
   * `active` or `deleted` without saying what each means, and a deleted entry is the one reading that
   * cannot be "there". `pending` is taken as there, since creating over it would duplicate it.
   */
  async entriesNamed(name: string): Promise<CfSecretEntry[]> {
    return (await this.listSecrets()).filter((entry) => entry.name === name && isLive(entry)).sort(byAge);
  }

  /** Whether a secret with the given name currently exists in the store. */
  async exists(name: string): Promise<boolean> {
    return (await this.findByName(name)) !== undefined;
  }

  /** The store this manager targets and the account it lives in. */
  getSecretsStoreInfo(): { storeId: string; accountId: string } {
    return { storeId: this.storeId, accountId: this.accountId };
  }

  /** Create a single secret with the default scopes, and return the id Cloudflare gave it when it says one. */
  private async createSecret(name: string, value: string, comment?: string): Promise<string | undefined> {
    return cloudflareRequest(`create secret ${name}`, async () => {
      const response: unknown = await this.getClient().secretsStore.stores.secrets.create(this.storeId, {
        account_id: this.accountId,
        body: [{ name, value, scopes: [...DEFAULT_SCOPES], ...commentField(comment) }],
      });
      // The SDK hands back a page of what was created. Read defensively: an id is a convenience here, and a
      // response without one leaves `createSecretIfAbsent` answering `created` as it would have before.
      const items = (response as { result?: unknown })?.result ?? response;
      if (!Array.isArray(items)) return undefined;
      for (const created of items as { id?: unknown; name?: unknown }[]) {
        if (typeof created?.id === "string" && created.name === name) return created.id;
      }
      return undefined;
    });
  }

  /**
   * The entry of this name every verb here acts on, or `undefined`. Of several entries of one name, the
   * oldest — which is the one {@link createSecretIfAbsent} leaves standing. See {@link entriesNamed} for
   * why there can be several, and for what counts as being there at all.
   */
  private async findByName(name: string): Promise<CfSecretEntry | undefined> {
    return (await this.entriesNamed(name))[0];
  }
}
