import { cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Out-of-Worker sends through the Cloudflare Email Service REST API — the control-plane counterpart to
 * the in-Worker `send_email` binding. Used by the CLI's `pithy email test` to render and deliver one
 * template through a project's configuration without deploying. Inside a Worker, always prefer the
 * binding (no token, principle-1 aligned).
 */

/** A message to send over REST. `from` mirrors the binding's `{ email, name }`; the wire uses `address`. */
export interface EmailSendInput {
  to: string | string[];
  from: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/** What the send returned: the assigned message id and any synchronous delivery breakdown. */
export interface EmailSendResult {
  messageId?: string;
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
}

export class CloudflareEmailSendManager extends CloudflareManager {
  getServiceType(): string {
    return "Email Sending";
  }

  /**
   * Prove reach by reading the account's sending limits; never throws (returns false on any failure).
   * `/email/sending/limits` has no typed SDK method — only `send` and `subdomains` do — so this stays
   * on the documented raw-`fetch` escape hatch. Probing `subdomains.list` instead would change what
   * the check proves: a token scoped to send but not to read subdomains would start reporting false.
   */
  async validateServiceAccess(): Promise<boolean> {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.getAccountId()}/email/sending/limits`,
        { headers: { Authorization: `Bearer ${this.getApiToken()}` } },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send one message through the Email Sending API. Throws `cloudflare/request_failed` on any API
   * error — the SDK unwraps the envelope and raises on `success: false`, so a resolved call is a send.
   *
   * `from` is sent as the object form only when a display name exists; the SDK's object form requires
   * `name`, and the bare-string form is the wire's own representation of "address, no display name".
   */
  async send(message: EmailSendInput): Promise<EmailSendResult> {
    return cloudflareRequest("Email Service send", async () => {
      const result = await this.getClient().emailSending.send({
        account_id: this.getAccountId(),
        to: message.to,
        from: message.from.name ? { address: message.from.email, name: message.from.name } : message.from.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      });
      return {
        messageId: result.message_id,
        delivered: result.delivered,
        queued: result.queued,
        permanentBounces: result.permanent_bounces,
      };
    });
  }
}
