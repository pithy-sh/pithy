// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  CloudflareInvalidResponseError,
  CloudflareRequestError,
  cloudflareRequest,
  decodeResponse,
  messageOf,
} from "../client/errors";
import { CloudflareManager } from "../client/manager";
import {
  CfBuild,
  CfBuildLog,
  CfBuildToken,
  CfBuildTrigger,
  CfRepoConnection,
  type CfTriggerEnvVar,
} from "./buildsTypes";

/** The Cloudflare REST API v4 base URL. The Builds endpoints live under `/accounts/{id}/builds`. */
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** CF 409 code 12042: "A trigger already exists for this configuration". */
const CONFLICT_TRIGGER_EXISTS = 12042;

/** CF 404 code 12000: "Not found" — returned when a script has no triggers. */
const NOT_FOUND = 12000;

/** The standard `{ result, success, errors, messages }` envelope every CF REST response carries. */
const CfEnvelope = z.object({
  result: z.unknown(),
  success: z.boolean().optional(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string().optional() }).loose()).optional(),
});

/** Arguments for `createRepoConnection`. */
export interface CreateRepoConnectionArgs {
  /** The git provider hosting the repo. */
  providerType: "gitlab" | "github";
  /** The repository's id in the git provider. */
  repoId: string;
  /** The repo path relative to the provider account. */
  repoName: string;
  /** The provider account identifier (e.g. 'group:15366484'). */
  providerAccountId: string;
  /** The provider account display name. */
  providerAccountName: string;
}

/** Arguments for `upsertTrigger`. */
export interface UpsertTriggerArgs {
  /** The immutable Worker id (hex UUID) the trigger builds — not the worker name. */
  scriptName: string;
  /** The repo connection UUID to build from. */
  repoConnectionId: string;
  /** The build token UUID the trigger authenticates with. */
  buildTokenUuid: string;
  /** The trigger's human-readable name. */
  triggerName: string;
  /** Branch patterns whose pushes auto-fire the trigger (must be non-empty). */
  branchIncludes: string[];
  /** Branch patterns excluded from auto-firing. */
  branchExcludes?: string[];
  /** Path patterns whose changes auto-fire the trigger. */
  pathIncludes?: string[];
  /** The shell command that builds the Worker. */
  buildCommand: string;
  /** The shell command CF Builds runs to deploy after a build. */
  deployCommand: string;
  /** The repo subdirectory builds run from. Defaults to '/'. */
  rootDirectory?: string;
  /** Whether build caching is enabled. Defaults to true. */
  buildCachingEnabled?: boolean;
}

/** A subset of trigger fields that can be patched after creation. */
export interface UpdateTriggerArgs {
  /** A branch filter to set on the trigger. */
  branchFilter?: string;
  /** The build command to set. */
  buildCommand?: string;
  /** The deploy command to set. */
  deployCommand?: string;
  /** The root directory to set. */
  rootDirectory?: string;
}

/**
 * Out-of-Worker access to the Cloudflare Builds API: repo connections, build triggers, builds, and
 * trigger env vars. CF Builds is the CI/CD layer for Workers — it clones a git repo, runs a build
 * command, and reports outcomes.
 *
 * As of the SDK version this package targets, the Builds endpoints are NOT exposed as typed SDK
 * resources, so this manager uses the documented escape hatch (`getApiToken()` + raw `fetch`) against
 * explicit `/accounts/{id}/builds/...` paths. Every request goes through `cloudflareRequest` so
 * failures wrap as `cloudflare/request_failed`, and every response is validated with Zod
 * (`cloudflare/invalid_response` on mismatch).
 */
export class CloudflareBuildsManager extends CloudflareManager {
  /**
   * Issue a raw CF REST call and unwrap the `{ result, success, errors }` envelope. A failure —
   * either a non-2xx status **or** a 200 carrying `success: false` — throws `cloudflare/request_failed`
   * with the structured CF error codes pinned to the front of `detail` (so idempotency checks read a
   * stable marker, never a substring a verbose body could push past truncation). An unparseable body
   * throws `cloudflare/invalid_response`.
   */
  private async call(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.getApiToken()}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();

    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new CloudflareInvalidResponseError({
          message: "A Cloudflare Builds response was not valid JSON.",
          detail: `${method} ${path}: ${messageOf(error)}`,
        });
      }
    }

    const envelope = CfEnvelope.safeParse(parsed);
    // CF signals failure two ways: a non-2xx status, or a 200 body with `success: false`.
    const apiReportedFailure = envelope.success && envelope.data.success === false;
    if (!response.ok || apiReportedFailure) {
      const codes = envelope.success
        ? (envelope.data.errors ?? []).map((e) => e.code).filter((c): c is number => c !== undefined)
        : [];
      const marker = codes.length > 0 ? `[cf-codes:${codes.join(",")}] ` : "";
      throw new CloudflareRequestError({
        message: `Cloudflare Builds returned ${response.status}.`,
        detail: `${marker}${method} ${path} → ${response.status}: ${text}`.slice(0, 2000),
      });
    }

    return envelope.success ? envelope.data.result : parsed;
  }

  /**
   * Register a git repository with CF Builds. `PUT /builds/repos/connections` is CF's documented
   * upsert — calling with the same repo id returns the existing connection.
   */
  async createRepoConnection(args: CreateRepoConnectionArgs): Promise<CfRepoConnection> {
    return cloudflareRequest("create repo connection", async () => {
      const result = await this.call("PUT", `/accounts/${this.getAccountId()}/builds/repos/connections`, {
        provider_type: args.providerType,
        repo_id: args.repoId,
        repo_name: args.repoName,
        provider_account_id: args.providerAccountId,
        provider_account_name: args.providerAccountName,
      });
      return this.validate(CfRepoConnection, result, "repo connection");
    });
  }

  /**
   * Upsert a build trigger linking a Worker script to a repo. Tries `POST /builds/triggers`; on the
   * 409 "trigger already exists" conflict, falls back to listing the script's triggers and returning
   * the matching one. Idempotent.
   */
  async upsertTrigger(args: UpsertTriggerArgs): Promise<CfBuildTrigger> {
    return cloudflareRequest("upsert trigger", async () => {
      try {
        const result = await this.call("POST", `/accounts/${this.getAccountId()}/builds/triggers`, {
          external_script_id: args.scriptName,
          repo_connection_uuid: args.repoConnectionId,
          build_token_uuid: args.buildTokenUuid,
          trigger_name: args.triggerName,
          branch_includes: args.branchIncludes,
          branch_excludes: args.branchExcludes ?? [],
          path_includes: args.pathIncludes ?? ["*"],
          build_command: args.buildCommand,
          deploy_command: args.deployCommand,
          root_directory: args.rootDirectory ?? "/",
          build_caching_enabled: args.buildCachingEnabled ?? true,
        });
        return this.validate(CfBuildTrigger, result, "build trigger");
      } catch (error) {
        if (hasErrorCode(error, CONFLICT_TRIGGER_EXISTS)) {
          const existing = await this.listTriggersByScript(args.scriptName);
          const match =
            existing.find((t) => t.trigger_name === args.triggerName) ??
            existing.find((t) => JSON.stringify(t.branch_includes) === JSON.stringify(args.branchIncludes));
          if (match) return match;
        }
        throw error;
      }
    });
  }

  /** List the build tokens available on the account. */
  async listBuildTokens(): Promise<CfBuildToken[]> {
    return cloudflareRequest("list build tokens", async () => {
      const result = await this.call("GET", `/accounts/${this.getAccountId()}/builds/tokens`);
      return this.validate(z.array(CfBuildToken), Array.isArray(result) ? result : [], "build tokens");
    });
  }

  /** Patch an existing build trigger's configuration. */
  async updateTrigger(triggerId: string, args: UpdateTriggerArgs): Promise<CfBuildTrigger> {
    return cloudflareRequest("update trigger", async () => {
      const body: Record<string, string> = {};
      if (args.branchFilter !== undefined) body.branch_filter = args.branchFilter;
      if (args.buildCommand !== undefined) body.build_command = args.buildCommand;
      if (args.deployCommand !== undefined) body.deploy_command = args.deployCommand;
      if (args.rootDirectory !== undefined) body.root_directory = args.rootDirectory;
      const result = await this.call("PUT", `/accounts/${this.getAccountId()}/builds/triggers/${triggerId}`, body);
      return this.validate(CfBuildTrigger, result, "build trigger");
    });
  }

  /** Delete a build trigger. */
  async deleteTrigger(triggerId: string): Promise<void> {
    await cloudflareRequest("delete trigger", () =>
      this.call("DELETE", `/accounts/${this.getAccountId()}/builds/triggers/${triggerId}`),
    );
  }

  /** Manually start a build for a trigger at a specific branch + commit. */
  async triggerManualBuild(triggerId: string, branch: string, commitHash: string): Promise<CfBuild> {
    return cloudflareRequest("trigger manual build", async () => {
      const result = await this.call("POST", `/accounts/${this.getAccountId()}/builds/triggers/${triggerId}/builds`, {
        branch,
        commit_hash: commitHash,
      });
      return this.validate(CfBuild, result, "build");
    });
  }

  /** Get a build's current status and metadata by id. */
  async getBuild(buildId: string): Promise<CfBuild> {
    return cloudflareRequest("get build", async () => {
      const result = await this.call("GET", `/accounts/${this.getAccountId()}/builds/${buildId}`);
      return this.validate(CfBuild, result, "build");
    });
  }

  /** Cancel a running build. */
  async cancelBuild(buildId: string): Promise<void> {
    await cloudflareRequest("cancel build", () =>
      this.call("POST", `/accounts/${this.getAccountId()}/builds/${buildId}/cancel`),
    );
  }

  /** Get the log output for a build. */
  async getBuildLogs(buildId: string): Promise<CfBuildLog[]> {
    return cloudflareRequest("get build logs", async () => {
      const result = await this.call("GET", `/accounts/${this.getAccountId()}/builds/${buildId}/logs`);
      return this.validate(z.array(CfBuildLog), result, "build logs");
    });
  }

  /** List all builds for a Worker script. */
  async listBuildsByScript(scriptName: string): Promise<CfBuild[]> {
    return cloudflareRequest("list builds by script", async () => {
      const result = await this.call(
        "GET",
        `/accounts/${this.getAccountId()}/builds?script_name=${encodeURIComponent(scriptName)}`,
      );
      return this.validate(z.array(CfBuild), result, "builds");
    });
  }

  /**
   * List the build triggers for a Worker script. `externalScriptId` must be the immutable Worker id
   * (hex UUID), resolved via `CloudflareWorkersManager.getWorkerInternalId`. Returns an empty array
   * when the script has no triggers (CF 404 code 12000).
   */
  async listTriggersByScript(externalScriptId: string): Promise<CfBuildTrigger[]> {
    return cloudflareRequest("list triggers by script", async () => {
      try {
        const result = await this.call(
          "GET",
          `/accounts/${this.getAccountId()}/builds/workers/${encodeURIComponent(externalScriptId)}/triggers`,
        );
        return this.validate(z.array(CfBuildTrigger), result, "build triggers");
      } catch (error) {
        if (hasErrorCode(error, NOT_FOUND)) return [];
        throw error;
      }
    });
  }

  /**
   * Bulk-upsert environment variables on a build trigger. The wire body is a map keyed by variable
   * name (`{ NAME: { is_secret, value }, ... }`), not an array.
   */
  async upsertTriggerEnvVars(triggerId: string, envVars: CfTriggerEnvVar[]): Promise<void> {
    await cloudflareRequest("upsert trigger env vars", () => {
      const body: Record<string, { is_secret: boolean; value: string }> = {};
      for (const variable of envVars) {
        body[variable.name] = { is_secret: variable.type === "secret_text", value: variable.value };
      }
      return this.call(
        "PATCH",
        `/accounts/${this.getAccountId()}/builds/triggers/${triggerId}/environment_variables`,
        body,
      );
    });
  }

  getServiceType(): string {
    return "Cloudflare Builds";
  }

  /** Prove access by listing build triggers. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.call("GET", `/accounts/${this.getAccountId()}/builds/triggers`);
      return true;
    } catch {
      return false;
    }
  }

  /** Validate a raw CF result against a Zod schema, throwing `cloudflare/invalid_response` on mismatch. */
  private validate<T extends z.ZodType>(schema: T, raw: unknown, label: string): z.output<T> {
    return decodeResponse(schema, raw, `Builds ${label}`);
  }
}

/**
 * Whether a thrown `CloudflareRequestError` carries the given CF error code. Reads the `[cf-codes:…]`
 * marker `call()` pins to the front of `detail` (stable across the 2000-char truncation); falls back
 * to a substring scan for errors raised without the structured marker.
 */
function hasErrorCode(error: unknown, code: number): boolean {
  if (!(error instanceof CloudflareRequestError)) return false;
  const detail = error.payload.detail ?? "";
  const marker = detail.match(/^\[cf-codes:([\d,]+)\]/);
  if (marker?.[1]) return marker[1].split(",").includes(String(code));
  return detail.includes(`"code":${code}`) || detail.includes(`"code": ${code}`);
}
