// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** The one OAuth scope this server issues. A constant, not a vocabulary. */
export const MCP_SCOPE = "mcp";

/** The scopes a client may request: {@link MCP_SCOPE}, and `offline_access` for a refresh token. */
export const MCP_SCOPES = [MCP_SCOPE, "offline_access"] as const;

/**
 * The provider's tables, under this capability's prefix. Better Auth names a plugin's tables after its models;
 * every table this kit provides is `pithy_<capability>_<table>`, so each one is renamed here, once.
 */
export const MCP_MODEL_NAMES = {
  oauthClient: "pithyMcpClients",
  oauthResource: "pithyMcpResources",
  oauthClientResource: "pithyMcpClientResources",
  oauthRefreshToken: "pithyMcpRefreshTokens",
  oauthAccessToken: "pithyMcpAccessTokens",
  oauthConsent: "pithyMcpConsents",
  oauthClientAssertion: "pithyMcpClientAssertions",
} as const;
