// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * Zod schemas for the Cloudflare Builds REST API.
 *
 * CF Builds provides CI/CD for Workers — it clones a git repo, runs a build command, and optionally
 * runs a deploy command. As of the SDK version this package targets, the Builds endpoints are not
 * exposed as typed SDK resources, so `buildsManager` reaches them over raw `fetch` (the documented
 * escape hatch) and validates every response through the schemas here. ISO-string dates on the wire
 * are decoded to `Date` via the `JsonDate` codec, so each dated schema round-trips through
 * `.parse()`/`.encode()`.
 */

/** A git-provider repository linked to the Cloudflare account for builds. */
export const CfRepoConnection = z
  .object({
    repo_connection_uuid: z.string().describe("The connection's UUID, used to attach build triggers."),
    repo_id: z.string().describe("The repository's id in the git provider."),
    repo_name: z.string().describe("The repo path relative to the provider account."),
    provider_type: z.string().describe("The git provider (e.g. 'gitlab', 'github')."),
    provider_account_id: z.string().describe("The provider account identifier (e.g. 'group:15366484')."),
    provider_account_name: z.string().describe("The provider account display name."),
    created_on: JsonDate.describe("When the connection was created (ISO-8601 on the wire, Date in JS)."),
    modified_on: JsonDate.describe("When the connection was last modified (ISO-8601 on the wire, Date in JS)."),
    deleted_on: JsonDate.nullish().describe("When the connection was deleted, if it has been."),
  })
  .describe("A git-provider repository connected to Cloudflare Builds.");
export type CfRepoConnection = z.output<typeof CfRepoConnection>;

/** A build trigger linking a Worker script to a repo connection and its build/deploy commands. */
export const CfBuildTrigger = z
  .object({
    trigger_uuid: z.string().describe("The trigger's UUID."),
    external_script_id: z.string().describe("The immutable Worker id (hex UUID) this trigger builds."),
    build_token_uuid: z.string().describe("The build token this trigger authenticates with."),
    build_token_name: z.string().nullish().describe("The build token's display name, if returned."),
    trigger_name: z.string().nullish().describe("The trigger's human-readable name."),
    build_command: z.string().describe("The shell command that builds the Worker."),
    deploy_command: z.string().describe("The shell command CF Builds runs to deploy after a build."),
    root_directory: z.string().describe("The repo subdirectory builds run from."),
    branch_includes: z.array(z.string()).describe("Branch patterns whose pushes auto-fire the trigger."),
    branch_excludes: z.array(z.string()).nullish().describe("Branch patterns excluded from auto-firing."),
    path_includes: z.array(z.string()).nullish().describe("Path patterns whose changes auto-fire the trigger."),
    path_excludes: z.array(z.string()).nullish().describe("Path patterns excluded from auto-firing."),
    build_caching_enabled: z.boolean().nullish().describe("Whether build caching is enabled for the trigger."),
    created_on: JsonDate.describe("When the trigger was created (ISO-8601 on the wire, Date in JS)."),
    modified_on: JsonDate.describe("When the trigger was last modified (ISO-8601 on the wire, Date in JS)."),
    deleted_on: JsonDate.nullish().describe("When the trigger was deleted, if it has been."),
  })
  .describe("A Cloudflare Builds trigger binding a Worker script to a repo and build commands.");
export type CfBuildTrigger = z.output<typeof CfBuildTrigger>;

/** Metadata about the commit a build ran against. */
export const CfBuildTriggerMetadata = z
  .object({
    branch: z.string().describe("The git branch the build ran against."),
    commit_hash: z.string().describe("The git commit SHA the build ran against."),
    build_trigger_source: z.string().nullish().describe("How the build was initiated (push, manual, api, …)."),
  })
  .loose()
  .describe("Commit/branch metadata attached to a build.");
export type CfBuildTriggerMetadata = z.output<typeof CfBuildTriggerMetadata>;

/** A back-reference from a build to the trigger that produced it. */
export const CfBuildTriggerRef = z
  .object({
    trigger_uuid: z.string().describe("The producing trigger's UUID."),
    external_script_id: z.string().describe("The immutable Worker id the trigger targets."),
  })
  .loose()
  .describe("A reference to the trigger that produced a build.");
export type CfBuildTriggerRef = z.output<typeof CfBuildTriggerRef>;

/** A single execution of a build trigger and its lifecycle state. */
export const CfBuild = z
  .object({
    build_uuid: z.string().describe("The build's identifier."),
    status: z.string().describe("The build's lifecycle state (queued, initializing, running, stopped)."),
    build_outcome: z.string().nullish().describe("The final result, present once the build completes."),
    initializing_on: JsonDate.nullish().describe("When the build began initializing (ISO-8601 on the wire)."),
    running_on: JsonDate.nullish().describe("When execution began (ISO-8601 on the wire, Date in JS)."),
    stopped_on: JsonDate.nullish().describe("When the build finished (ISO-8601 on the wire, Date in JS)."),
    created_on: JsonDate.describe("When the build was queued (ISO-8601 on the wire, Date in JS)."),
    modified_on: JsonDate.describe("When the build's status last changed (ISO-8601 on the wire, Date in JS)."),
    build_trigger_metadata: CfBuildTriggerMetadata.nullish().describe("Commit/branch metadata for the build."),
    trigger: CfBuildTriggerRef.nullish().describe("The trigger that produced this build."),
  })
  .describe("A single Cloudflare Builds execution and its lifecycle state.");
export type CfBuild = z.output<typeof CfBuild>;

/** One line of a build's log output. */
export const CfBuildLog = z
  .object({
    line: z.number().describe("The log line number."),
    timestamp: JsonDate.describe("When the line was emitted (ISO-8601 on the wire, Date in JS)."),
    message: z.string().describe("The log message content."),
  })
  .describe("A single line of Cloudflare Builds log output.");
export type CfBuildLog = z.output<typeof CfBuildLog>;

/** An environment variable set on a build trigger. */
export const CfTriggerEnvVar = z
  .object({
    name: z.string().describe("The environment variable's name."),
    value: z.string().describe("The environment variable's value."),
    type: z.enum(["plain_text", "secret_text"]).describe("Whether the value is stored encrypted at rest."),
  })
  .describe("An environment variable set on a Cloudflare Builds trigger.");
export type CfTriggerEnvVar = z.output<typeof CfTriggerEnvVar>;

/** A build token usable by triggers on the account. */
export const CfBuildToken = z
  .object({
    build_token_uuid: z.string().describe("The build token's UUID."),
    build_token_name: z.string().describe("The build token's display name."),
  })
  .describe("A Cloudflare Builds token available on the account.");
export type CfBuildToken = z.output<typeof CfBuildToken>;
