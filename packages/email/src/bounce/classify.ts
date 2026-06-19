import type { BounceType } from "../data/enums";

/**
 * Classify an inbound message as a bounce, complaint, auto-reply, or something to ignore. With the
 * modern Email Service, hard bounces are auto-suppressed at the platform and surfaced synchronously on
 * send; this handles delivery-status notifications (DSNs) and feedback-loop complaints (ARF) that are
 * *routed back* to the worker, plus vacation auto-replies (a deliberate no-op).
 *
 * The classifier is pure and works on the already-parsed pieces of the message — its headers and the
 * raw body text — so it is unit-testable without the Workers runtime. Identification is best-effort:
 * the failed recipient comes from the DSN's `Final-Recipient`, and the originating job is matched later
 * by the original `Message-ID` against the stored send `messageId` (no custom VERP return path, which
 * the simple send binding cannot set).
 */

/** What an inbound message turned out to be. `ignore` and `auto_reply` produce no side effects. */
export interface InboundClassification {
  /** The classification — `ignore` for anything that isn't a recognized bounce/complaint/auto-reply. */
  type: BounceType | "ignore";
  /** The affected recipient address, when the message identifies one. */
  recipient?: string;
  /** The SMTP/DSN status or diagnostic code, for the row and the event detail. */
  code?: string;
  /** The original message's `Message-ID`, used to match the job that bounced. */
  originalMessageId?: string;
}

/** Read a header-style field (`Name: value`) from a block of text, case-insensitively. */
function field(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(text);
  return match?.[1]?.trim();
}

/** Extract the address from an RFC822 recipient line like `rfc822;user@example.com` or `<user@x>`. */
function extractAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const afterSemicolon = value.includes(";") ? value.slice(value.indexOf(";") + 1) : value;
  const angle = /<([^>]+)>/.exec(afterSemicolon);
  const addr = (angle?.[1] ?? afterSemicolon).trim();
  return addr.includes("@") ? addr : undefined;
}

/** The original message id — the explicit DSN field, else the last `Message-ID` (the embedded original). */
function originalMessageId(raw: string): string | undefined {
  const explicit = field(raw, "Original-Message-ID");
  if (explicit) return explicit.replace(/^<|>$/g, "");
  const ids = [...raw.matchAll(/^Message-ID:\s*<([^>]+)>/gim)].map((m) => m[1]);
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

/** The inbound message's parsed pieces the classifier needs. */
export interface InboundMessage {
  /** The top-level `Content-Type` header value (carries `report-type` for DSN/ARF). */
  contentType?: string;
  /** The `Auto-Submitted` header value, if present. */
  autoSubmitted?: string;
  /** Whether any auto-responder header (`X-Autoreply`, `X-Autorespond`) is present. */
  autoReplyHeader?: boolean;
  /** The raw message body text — DSN/ARF fields are line-structured within it. */
  raw: string;
}

/** Classify an inbound message. */
export function classifyInbound(message: InboundMessage): InboundClassification {
  const contentType = (message.contentType ?? "").toLowerCase();
  const raw = message.raw;

  // A delivery-status notification (DSN): a hard or soft bounce.
  if (contentType.includes("report-type=delivery-status") || /^Action:\s*failed/im.test(raw)) {
    const status = field(raw, "Status");
    const diagnostic = field(raw, "Diagnostic-Code");
    const recipient = extractAddress(field(raw, "Final-Recipient") ?? field(raw, "Original-Recipient"));
    const soft = status?.startsWith("4") ?? false;
    return {
      type: soft ? "soft" : "hard",
      recipient,
      code: status ?? diagnostic,
      originalMessageId: originalMessageId(raw),
    };
  }

  // A feedback-loop complaint (ARF): the recipient reported the message as spam.
  if (contentType.includes("report-type=feedback-report") || /^Feedback-Type:/im.test(raw)) {
    const recipient = extractAddress(field(raw, "Original-Rcpt-To") ?? field(raw, "Removal-Recipient"));
    return {
      type: "complaint",
      recipient,
      code: field(raw, "Feedback-Type") ?? "complaint",
      originalMessageId: originalMessageId(raw),
    };
  }

  // A vacation/auto-responder reply: explicitly a no-op so it never suppresses a real recipient.
  const autoSubmitted = (message.autoSubmitted ?? "").toLowerCase();
  if (message.autoReplyHeader || (autoSubmitted && autoSubmitted !== "no")) {
    return { type: "auto_reply" };
  }

  return { type: "ignore" };
}
