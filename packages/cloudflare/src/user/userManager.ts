import { z } from "zod";
import { cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Out-of-Worker read access to the **user/token** identity behind a CF API token — `GET /user` and
 * `GET /user/tokens/verify`/`/user/tokens/:id`. The audit CLI emitter uses it to attribute a
 * control-plane action (`pithy migrate`, `pithy deploy`, …) to the right actor: a user token
 * (`cfut_*`) resolves to the developer's email, an account token (`cfat_*`) to the token's name.
 *
 * These are *user-scoped* endpoints, so they need a user-bound token — CLAUDE.md prefers
 * account-owned tokens for provisioning, but actor attribution is exactly the case where the token's
 * own identity is the point. Reads only; never mints, never logs a token value.
 */

/** The CF user behind a user token. The SDK omits `email` from its type, but the API returns it. */
export const CfUserIdentity = z
  .object({
    id: z.string().optional().describe("The Cloudflare user id — stable cross-reference for the actor."),
    email: z.string().optional().describe("The Cloudflare user's email — the human actor's identifier."),
  })
  .describe("The identity behind a Cloudflare user (`cfut_*`) API token, from `GET /user`.");
export type CfUserIdentity = z.output<typeof CfUserIdentity>;

/** The result of verifying the calling token: its id and lifecycle status. */
export const CfTokenVerification = z
  .object({
    id: z.string().describe("The token's id — addresses it for a follow-up name lookup."),
    status: z.string().describe("The token's lifecycle status (`active` | `disabled` | `expired`)."),
  })
  .describe("The result of `GET /user/tokens/verify` for the calling Cloudflare API token.");
export type CfTokenVerification = z.output<typeof CfTokenVerification>;

/** Just the token's name, the piece the account-token actor path needs. */
const TokenName = z.object({ name: z.string() });

export class CloudflareUserManager extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare User";
  }

  /** Prove access by reading the user record. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getUser();
      return true;
    } catch {
      return false;
    }
  }

  /** The Cloudflare user behind a user (`cfut_*`) token — `GET /user`. */
  async getUser(): Promise<CfUserIdentity> {
    const raw = await cloudflareRequest("get user", () => this.getClient().user.get());
    return decodeResponse(CfUserIdentity, raw, "user get");
  }

  /** Verify the calling token and read its id + status — `GET /user/tokens/verify`. */
  async verifyToken(): Promise<CfTokenVerification> {
    const raw = await cloudflareRequest("verify token", () => this.getClient().user.tokens.verify());
    return decodeResponse(CfTokenVerification, raw, "token verify");
  }

  /** The name of a token by id, or `null` if it can't be read — `GET /user/tokens/:id`. */
  async getTokenName(tokenId: string): Promise<string | null> {
    const raw = await cloudflareRequest(`get token ${tokenId}`, () => this.getClient().user.tokens.get(tokenId));
    const parsed = TokenName.safeParse(raw);
    return parsed.success ? parsed.data.name : null;
  }
}
