// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ClientDiscovery, oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * The authorization server the MCP capability composes into the auth instance (`docs/AGENT-ACCESS.md` §4).
 *
 * **Composed, not written.** Better Auth's OAuth 2.1 provider turns the instance into an authorization server:
 * dynamic client registration, PKCE, resource-bound JWT access tokens signed by the JWKS the `jwt` plugin already
 * keeps, refresh tokens, and the RFC 8414 metadata a client discovers it by. Beside registration, this module plugs in
 * the Client ID Metadata Document discovery from `@better-auth/cimd` (`./clientMetadata.ts`), so a client may also be
 * known by the URL of a document it publishes. That one extension adds the registration path the MCP specification
 * prefers; everything else this module adds is policy, and every line of that narrows the provider's defaults.
 *
 * **One scope, and it is not a permission.** The consent is informational (§4.3): one decision, *let this client
 * act as you in this application*, so the token carries no permission selection. {@link MCP_SCOPE} is the only
 * scope a client may hold beside `offline_access`, which buys a refresh token and nothing else. The role is the only
 * authority over what a call may do, and the routes enforce it, so there is no scope vocabulary to ask for.
 *
 * **The token binds the resource and the user, and nothing else.** The one resource is this Worker's MCP endpoint,
 * seeded as the provider's only resource and linked to every client at registration, so a token minted for it is a
 * JWT whose `aud` is that URL and cannot be replayed at another. `sub` is the user and `sid` the session they
 * consented in; the MCP endpoint refuses a token whose session has ended.
 *
 * **No client credentials grant.** A token here acts *as somebody*; a machine-to-machine token acts as nobody, which
 * is the control-plane seam's job (§1), not this one's.
 *
 * **The consent screen every time.** The provider skips consent for a client that already holds it; this kit asks
 * again, so a client asking for access again is a new decision the user can see, and an audited one. A client asking
 * to be shown nothing (`prompt=none`) is refused with `consent_required` before the provider runs, because the
 * provider would answer it with a code whenever a consent is on record.
 */

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

/** The plugin id of the kit's consent-every-time hook. */
export const MCP_CONSENT_PLUGIN_ID = "pithy-mcp-consent";

/** What the provider needs to know about this Worker. */
export interface McpProviderSettings {
  /** The MCP endpoint's absolute URL: the one resource, and every token's audience. */
  readonly resource: string;
  /** The scaffolded screen's path, which is both the sign-in and the consent page for this flow. */
  readonly consentPage: string;
  /** How a client whose id is an HTTPS URL is resolved from the metadata document served there. */
  readonly clientDiscovery: ClientDiscovery;
}

/**
 * The `prompt` an authorize request runs with — always including `consent` — or `null` when the client asked for
 * `none`. `none` asks for a grant with no screen, and this server has no such grant to give.
 */
export function consentPrompt(prompt: unknown): string | null {
  const asked = typeof prompt === "string" ? prompt.split(" ").filter((value) => value.length > 0) : [];
  if (asked.includes("none")) return null;
  return [...new Set([...asked.filter((value) => value !== "login"), "consent"])].join(" ");
}

/** Show the consent screen on every authorization, so asking again is a decision rather than a skip. */
function consentEveryTime(): BetterAuthPlugin {
  return {
    id: MCP_CONSENT_PLUGIN_ID,
    hooks: {
      before: [
        {
          // The browser's own authorize request, and only that. The provider calls its authorize endpoint again
          // from inside the consent endpoint once the user has decided, with `consent` already taken out of the
          // prompt — and that call carries the consent request, so it is told apart by the path the request was
          // actually made to. Matching it too would send the user straight back to the screen they just answered.
          matcher: (context) =>
            context.path === "/oauth2/authorize" &&
            context.request !== undefined &&
            new URL(context.request.url).pathname.endsWith("/oauth2/authorize"),
          handler: createAuthMiddleware(async (ctx) => {
            const query = (ctx.query ?? {}) as Record<string, unknown>;
            const prompt = consentPrompt(query.prompt);
            if (prompt === null) {
              // Answered here rather than at the redirect URI: the request has not been checked against the client
              // yet, so its redirect URI is only what the request says.
              throw new APIError("BAD_REQUEST", {
                error: "consent_required",
                error_description: "This application asks for consent every time, so prompt=none is never granted.",
              });
            }
            return { context: { query: { ...query, prompt } } };
          }),
        },
      ],
    },
  };
}

/**
 * The provider plugin and the kit's consent hook, for one Worker's MCP endpoint.
 *
 * Typed as plain `BetterAuthPlugin`s, the way the kit's translator and sign-in gate are. Every reader takes them as
 * that already: the instance's plugin list is the adopter's `BetterAuthPlugin[]` with these appended, and the
 * migration plan reads a `BetterAuthPlugin[]`. So the widening erases nothing a caller sees, and it keeps the
 * provider's inferred type out of the shipped declaration, which would otherwise name `better-call` internals a
 * declaration cannot reach.
 */
export function mcpAuthorizationServer(settings: McpProviderSettings): McpProviderPlugins {
  return [
    oauthProvider({
      loginPage: settings.consentPage,
      consentPage: settings.consentPage,
      scopes: [...MCP_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      // Open registration is what lets a client reach an authorized session from a URL alone (§4.3), which is why
      // nothing a client says about itself at registration is presented as verified on the consent screen.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // A native MCP client registers an `http://127.0.0.1` callback and often omits `application_type`; inferring
      // it admits those without loosening the rules for a web client's redirect.
      clientRegistrationDefaultApplicationType: "infer",
      // A client whose id is its metadata document's URL needs no registration; any other client registers
      // dynamically.
      extensions: [{ clientDiscovery: settings.clientDiscovery }],
      resources: [settings.resource],
      clientRegistrationDefaultResources: [settings.resource],
      schema: Object.fromEntries(
        Object.entries(MCP_MODEL_NAMES).map(([model, modelName]) => [model, { modelName }]),
      ) as never,
    }),
    consentEveryTime(),
  ];
}

/** The plugins {@link mcpAuthorizationServer} composes: the provider, then the consent hook. */
export type McpProviderPlugins = readonly [provider: BetterAuthPlugin, consent: BetterAuthPlugin];
