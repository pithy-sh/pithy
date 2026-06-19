import { z } from "zod";
import { CloudflareRequestError, cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Out-of-Worker sends through the Cloudflare Email Service REST API — the control-plane counterpart to
 * the in-Worker `send_email` binding. Used by the CLI's `pithy email test` to render and deliver one
 * template through a project's configuration without deploying. Inside a Worker, always prefer the
 * binding (no token, principle-1 aligned). The send endpoint is not in the typed SDK, so this falls
 * back to the documented raw-`fetch` escape hatch (`getApiToken()`), still inside this client.
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

/** The REST send envelope. Local (not exported) so it needs no `.describe()` for the schema meta-test. */
const SendEnvelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z
    .object({
      message_id: z.string().optional(),
      delivered: z.array(z.string()).default([]),
      queued: z.array(z.string()).default([]),
      permanent_bounces: z.array(z.string()).default([]),
    })
    .nullable(),
});

export class CloudflareEmailSendManager extends CloudflareManager {
  getServiceType(): string {
    return "Email Sending";
  }

  /** Prove reach by reading the account's sending limits; never throws (returns false on any failure). */
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

  /** Send one message through the Email Sending REST API. Throws `cloudflare/request_failed` on any API error. */
  async send(message: EmailSendInput): Promise<EmailSendResult> {
    return cloudflareRequest("Email Service send", async () => {
      const body: Record<string, unknown> = {
        to: message.to,
        from: { address: message.from.email, name: message.from.name },
        subject: message.subject,
        html: message.html,
        text: message.text,
      };
      if (message.replyTo) body.reply_to = message.replyTo;

      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.getAccountId()}/email/sending/send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.getApiToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const envelope = decodeResponse(SendEnvelope, await response.json(), "Email Service send");
      if (!envelope.success) {
        const detail = envelope.errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${response.status}`;
        throw new CloudflareRequestError({
          message: "The email could not be sent.",
          detail: `Email Service send failed — ${detail}`,
        });
      }
      return {
        messageId: envelope.result?.message_id,
        delivered: envelope.result?.delivered ?? [],
        queued: envelope.result?.queued ?? [],
        permanentBounces: envelope.result?.permanent_bounces ?? [],
      };
    });
  }
}
