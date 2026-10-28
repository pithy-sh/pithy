// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/** The MCP capability's response bodies. Every route names one in its `describeRoute`. */

/** RFC 9728 protected-resource metadata: where a client finds the authorization server for this endpoint. */
export const ProtectedResourceMetadata = z
  .object({
    resource: z.string().describe("The MCP endpoint's absolute URL. Every token's audience."),
    authorization_servers: z.array(z.string()).describe("The issuer that mints tokens for this resource."),
    scopes_supported: z.array(z.string()).describe("The one scope this server issues, and `offline_access`."),
    bearer_methods_supported: z.array(z.string()).describe("How a token is presented: `header` only."),
    resource_name: z.string().describe("What this resource is, for a client to show."),
  })
  .describe("Protected-resource metadata (RFC 9728) for the app's MCP endpoint.");
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadata>;

/** RFC 8414 authorization-server metadata, relayed from the provider unchanged. */
export const AuthorizationServerMetadata = z
  .record(z.string().describe("A metadata field."), z.unknown().describe("Its value."))
  .describe("Authorization-server metadata (RFC 8414), as the composed provider publishes it.");
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadata>;

/** One JSON-RPC answer. */
export const RpcResponse = z
  .object({
    jsonrpc: z.literal("2.0").describe("Always `2.0`."),
    id: z.union([z.string(), z.number()]).describe("The id of the request this answers."),
    result: z.unknown().optional().describe("The method's result, on success."),
    error: z
      .object({
        code: z.number().int().describe("The JSON-RPC error code."),
        message: z.string().describe("What went wrong, in one sentence."),
      })
      .optional()
      .describe("What went wrong, on failure."),
  })
  .describe("One JSON-RPC 2.0 answer.");
export type RpcResponse = z.infer<typeof RpcResponse>;

/** One operation a capability row lists. */
export const ConsentOperation = z
  .object({
    tool: z.string().describe("The tool's name, `<capability>_<operation>`."),
    summary: z.string().describe("What it does, in the capability's own words."),
    effect: z
      .enum(["writes", "sends", "charges", "deletes"])
      .nullable()
      .describe("What it does beyond reading, or null for a read."),
  })
  .describe("One thing the client will be able to do, as you.");
export type ConsentOperation = z.infer<typeof ConsentOperation>;

/** One capability, as the unit of consent. */
export const ConsentCapability = z
  .object({
    capability: z.string().describe("The capability's name."),
    operations: z
      .array(ConsentOperation)
      .describe("What the client will be able to do in it — only what your role allows."),
    reachable: z.number().int().describe("How many of its operations your role allows."),
    total: z.number().int().describe("How many operations it offers agents in all."),
    effects: z
      .object({
        writes: z.number().int().describe("Operations that change data."),
        sends: z.number().int().describe("Operations that send a message."),
        charges: z.number().int().describe("Operations that charge money."),
        deletes: z.number().int().describe("Operations that delete data."),
      })
      .describe("The reachable operations that do more than read, counted by effect."),
  })
  .describe("One capability the client will be able to act in, and what it can do there.");
export type ConsentCapability = z.infer<typeof ConsentCapability>;

/** One scope the client asked for, and what became of it. */
export const ConsentScope = z
  .object({
    scope: z.string().describe("The scope as the client asked for it."),
    granted: z.boolean().describe("Whether approving grants it."),
    reason: z
      .enum(["role", "unknown"])
      .nullable()
      .describe(
        "Why it is not granted: `role` when the caller's role does not reach it, `unknown` when no such permission exists. Null when it is granted.",
      ),
  })
  .describe("One scope the client requested.");
export type ConsentScope = z.infer<typeof ConsentScope>;

/** Everything the consent screen shows. */
export const ConsentView = z
  .object({
    client: z
      .object({
        id: z
          .string()
          .describe("The client's id: assigned when it registered dynamically, or the URL of its metadata document."),
        verifiedHost: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The host that serves the client's metadata document, which is its id. Proven by fetching the document there, so it may be shown as verified. Null for a dynamically registered client, which nothing has verified.",
          ),
        reportedName: z
          .string()
          .nullable()
          .describe("The name the client gave itself. Self-asserted and never verified — show it as reported."),
        reportedUri: z.string().nullable().describe("The homepage the client gave itself. Also unverified."),
        redirectUri: z
          .string()
          .describe("Where the token goes. Enforced by the authorization server, so it is what identifies the client."),
      })
      .describe("The application asking for access."),
    capabilities: z.array(ConsentCapability).describe("One row per capability you can reach. Nothing is selectable."),
    requested: z.array(ConsentScope).describe("What the client asked for, each with what approving grants."),
  })
  .describe("What the consent screen shows: one decision, and its consequence.");
export type ConsentView = z.infer<typeof ConsentView>;

/** The answer to a consent decision. */
export const ConsentDecision = z
  .object({
    redirect: z.string().describe("Where the browser goes next: the client's redirect, carrying a code or a refusal."),
  })
  .describe("Where to send the browser after the decision.");
export type ConsentDecision = z.infer<typeof ConsentDecision>;

/** One application the caller connected. */
export const ConnectedApplication = z
  .object({
    clientId: z.string().describe("The client's id."),
    verifiedHost: z
      .string()
      .nullable()
      .optional()
      .describe("The host that serves the client's metadata document. Null for a dynamically registered client."),
    reportedName: z.string().nullable().describe("The name the client gave itself. Unverified."),
    redirectUris: z.array(z.string()).describe("Where its tokens go."),
    approvedAt: z.string().describe("When you approved it, ISO-8601."),
  })
  .describe("One application acting as you.");
export type ConnectedApplication = z.infer<typeof ConnectedApplication>;

/** Every application the caller connected. */
export const ConnectedApplications = z
  .object({ applications: z.array(ConnectedApplication).describe("Newest first.") })
  .describe("The applications acting as you, each revocable.");
export type ConnectedApplications = z.infer<typeof ConnectedApplications>;

/** The answer to a revocation. */
export const RevokedApplication = z
  .object({ revoked: z.literal(true).describe("Always true: the client can no longer act as you.") })
  .describe("A revoked connection.");
export type RevokedApplication = z.infer<typeof RevokedApplication>;
