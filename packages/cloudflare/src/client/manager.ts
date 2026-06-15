import { Cloudflare } from "cloudflare";
import type { Account } from "cloudflare/resources/accounts/accounts";
import { CloudflareNotConfiguredError, cloudflareRequest } from "./errors";

/**
 * Configuration every manager shares. This is the whole surface: a scoped CF API token and the
 * account it targets. The CMS managers also accepted Worker bindings (dual REST/binding mode);
 * `@pithy-sh/cloudflare` is the *out-of-Worker* client (CLI, CI, provisioning), so it is REST-only
 * — inside a Worker you use the binding directly (CLAUDE.md §Cloudflare access). One token, one
 * account, no env coupling.
 */
export interface CloudflareManagerConfig {
  /** A scoped, least-privilege CF API token (from `CF_API_TOKEN`, minted per environment). */
  apiToken: string;
  /** The Cloudflare account id all operations target (`CLOUDFLARE_ACCOUNT_ID`). */
  accountId: string;
}

/**
 * Base for every Cloudflare resource manager. Holds the configured SDK client and account id, and
 * carries the account-level operations shared across resources. Subclasses add one resource's REST
 * operations and declare what they are (`getServiceType`) and how to prove access
 * (`validateServiceAccess`).
 */
export abstract class CloudflareManager {
  private readonly client: Cloudflare;

  private readonly apiToken: string;

  protected readonly accountId: string;

  constructor(config: CloudflareManagerConfig) {
    if (!config.apiToken) {
      throw new CloudflareNotConfiguredError({ detail: "Missing apiToken in CloudflareManagerConfig." });
    }
    if (!config.accountId) {
      throw new CloudflareNotConfiguredError({ detail: "Missing accountId in CloudflareManagerConfig." });
    }
    this.client = new Cloudflare({ apiToken: config.apiToken });
    this.apiToken = config.apiToken;
    this.accountId = config.accountId;
  }

  /** The configured SDK client. Subclasses route typed calls through this. */
  protected getClient(): Cloudflare {
    return this.client;
  }

  /**
   * The raw API token, for subclasses that fall back to direct `fetch()` for endpoints the typed
   * SDK does not cover (e.g. Workers Builds, event subscriptions). The documented escape hatch.
   */
  protected getApiToken(): string {
    return this.apiToken;
  }

  /** The account id all operations target. */
  protected getAccountId(): string {
    return this.accountId;
  }

  /** Fetch the full account record. Wraps SDK failures as `cloudflare/request_failed`. */
  async getAccountInfo(): Promise<Account> {
    return cloudflareRequest("get account info", () => this.getClient().accounts.get({ account_id: this.accountId }));
  }

  /** Whether the credentials work, proved by a lightweight account read. Never throws. */
  async validateCredentials(): Promise<boolean> {
    try {
      await this.getAccountInfo();
      return true;
    } catch {
      return false;
    }
  }

  /** A human label for the resource this manager owns (e.g. "KV Storage"). */
  abstract getServiceType(): string;

  /** Prove this manager can reach its specific resource. Never throws; returns false on failure. */
  abstract validateServiceAccess(): Promise<boolean>;
}
