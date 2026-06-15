import type {
  CustomHostnameCreateResponse,
  CustomHostnameDeleteResponse,
  CustomHostnameGetResponse,
  CustomHostnameListResponse,
} from "cloudflare/resources/custom-hostnames/custom-hostnames";
import { CloudflareNotConfiguredError, cloudflareRequest } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";

/**
 * Config for the Custom Hostnames manager: the shared client config plus the zone the hostnames
 * live under. Custom hostnames are a zone-scoped resource — the REST API addresses them by
 * `zone_id`, so the zone is required configuration here.
 */
export interface CustomHostnamesManagerConfig extends CloudflareManagerConfig {
  /** The zone id custom hostnames are created and managed under (the CF zone serving the apex). */
  zoneId: string;
}

/** Options for creating a custom hostname. */
export interface CreateCustomHostnameOptions {
  /**
   * The minimum TLS version the issued certificate negotiates. Defaults to `1.2`. Custom hostnames
   * use HTTP DCV with a DV certificate.
   */
  minTlsVersion?: "1.0" | "1.1" | "1.2" | "1.3";
}

/**
 * Out-of-Worker Custom Hostnames access over the REST API: create, look up, and remove custom
 * hostnames on a zone from a CLI/CI/provisioning context. Custom hostnames let a zone serve domains
 * it does not own DNS for — a customer CNAMEs their domain to a fallback origin on the zone, and CF
 * issues a certificate via HTTP domain-control validation. Addressed by zone id.
 */
export class CloudflareCustomHostnamesManager extends CloudflareManager {
  private readonly zoneId: string;

  constructor(config: CustomHostnamesManagerConfig) {
    super(config);
    if (!config.zoneId) {
      throw new CloudflareNotConfiguredError({ detail: "Missing zoneId for Custom Hostnames REST access." });
    }
    this.zoneId = config.zoneId;
  }

  /**
   * Create a custom hostname with HTTP DCV and a DV certificate. Idempotent: if a custom hostname
   * already exists for this hostname, the existing record is returned instead of creating a duplicate.
   */
  async addCustomHostname(
    hostname: string,
    options?: CreateCustomHostnameOptions,
  ): Promise<CustomHostnameCreateResponse | CustomHostnameListResponse> {
    const existing = await this.getCustomHostname(hostname);
    if (existing) return existing;

    return cloudflareRequest(`add custom hostname '${hostname}'`, () =>
      this.getClient().customHostnames.create({
        zone_id: this.zoneId,
        hostname,
        ssl: {
          method: "http",
          type: "dv",
          settings: { min_tls_version: options?.minTlsVersion ?? "1.2" },
        },
      }),
    );
  }

  /** Look up a custom hostname by its fully qualified name. Returns null when none matches. */
  async getCustomHostname(hostname: string): Promise<CustomHostnameListResponse | null> {
    return cloudflareRequest(`get custom hostname '${hostname}'`, async () => {
      for await (const candidate of this.getClient().customHostnames.list({ zone_id: this.zoneId, hostname })) {
        if (candidate.hostname === hostname) return candidate;
      }
      return null;
    });
  }

  /** Fetch a custom hostname by its id. */
  async getCustomHostnameById(customHostnameId: string): Promise<CustomHostnameGetResponse> {
    return cloudflareRequest(`get custom hostname by id '${customHostnameId}'`, () =>
      this.getClient().customHostnames.get(customHostnameId, { zone_id: this.zoneId }),
    );
  }

  /** List every custom hostname on the zone. */
  async listCustomHostnames(): Promise<CustomHostnameListResponse[]> {
    return cloudflareRequest("list custom hostnames", async () => {
      const hostnames: CustomHostnameListResponse[] = [];
      for await (const candidate of this.getClient().customHostnames.list({ zone_id: this.zoneId })) {
        hostnames.push(candidate);
      }
      return hostnames;
    });
  }

  /** Remove a custom hostname by its id. */
  async removeCustomHostname(customHostnameId: string): Promise<CustomHostnameDeleteResponse> {
    return cloudflareRequest(`remove custom hostname '${customHostnameId}'`, () =>
      this.getClient().customHostnames.delete(customHostnameId, { zone_id: this.zoneId }),
    );
  }

  /** The zone this manager targets and the account it lives in. */
  getCustomHostnamesInfo(): { zoneId: string; accountId: string } {
    return { zoneId: this.zoneId, accountId: this.accountId };
  }

  getServiceType(): string {
    return "Cloudflare Custom Hostnames";
  }

  /** Prove access by listing custom hostnames on the zone. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      for await (const _candidate of this.getClient().customHostnames.list({ zone_id: this.zoneId, per_page: 1 })) {
        break;
      }
      return true;
    } catch {
      return false;
    }
  }
}
