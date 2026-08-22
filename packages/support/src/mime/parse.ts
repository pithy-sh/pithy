// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseAddress } from "@pithy-sh/core/src/address/address";
import PostalMime, { type Address, type Attachment, type Email } from "postal-mime";
import { SupportUnparseableMessageError } from "../error/errors";
import { normalizeDisplayName } from "./address";
import { normalizeMessageId, parseReferences } from "./threading";
import { truncateToBytes } from "./truncate";

/**
 * Inbound MIME, parsed into the shape the rest of the capability works in.
 *
 * `@pithy-sh/email` already depends on `postal-mime` and already parses inbound mail — but only its
 * headers, to classify a bounce. Everything below the headers is untouched there, so multipart
 * bodies, attachments, and the threading chain are parsed here for the first time.
 *
 * **This module does not sanitize.** `html` comes back exactly as it arrived, and the caller runs it
 * through `sanitizeHtml` before anything stores or renders it. Keeping the two apart is what lets
 * this file be unit-tested under node against real messages — `HTMLRewriter` is a Workers global —
 * and it keeps the parse honest: a sanitizer that ran here would quietly make the raw bytes and the
 * parsed form disagree about what arrived.
 */

/** One attachment, decoded, with its declared metadata carried as-declared. */
export interface ParsedAttachment {
  /** The filename the sender declared, already stripped of path separators and control characters. */
  filename: string;
  /** The MIME type the sender declared. Recorded, never honored by a serve path. */
  contentType: string;
  /** The decoded bytes. */
  bytes: Uint8Array;
  /** The `Content-ID`, when the part carried one — what an inline image refers to by `cid:`. */
  contentId?: string;
  /** Whether the part declared `Content-Disposition: inline`. */
  inline: boolean;
}

/** One inbound message, parsed. */
export interface ParsedInboundMessage {
  /** The `Message-ID`, without angle brackets. Absent when the sender omitted one. */
  messageId?: string;
  /** The `In-Reply-To` id, without angle brackets — the direct parent. */
  inReplyTo?: string;
  /** The `References` chain, oldest first. */
  references: string[];
  /** The sender's address, normalized. */
  fromAddress: string;
  /** The sender's display name, if any — untrusted text, already stripped of control characters. */
  fromName?: string;
  /** Every address named in `To`/`Cc`/`Delivered-To`, normalized. Corroborating evidence, never authority. */
  headerRecipients: string[];
  /** The subject, bounded. Empty when the message had none. */
  subject: string;
  /** The plain-text body. Empty when the message carried only HTML — the caller derives text from it. */
  text: string;
  /** The HTML body **exactly as it arrived**, unsanitised. Absent when the message carried none. */
  html?: string;
  /** The decoded attachments, in the order the parts appeared. */
  attachments: ParsedAttachment[];
  /**
   * The `Authentication-Results` verdicts the receiving MTA stamped, lowercased, keyed by method
   * (`dmarc`, `spf`, `dkim`). Empty when the header was absent — which is itself a signal.
   *
   * Read from the **topmost** such header only. A sender may include one of their own, and it will be
   * below the MTA's; reading any but the first is a forged verdict.
   */
  authResults: Record<string, string>;
  /**
   * Which sender-authentication headers were actually present in the received bytes.
   *
   * **A diagnostic, not a signal** — nothing branches on it, and it is deliberately not stored. It
   * exists to settle a question this package cannot answer by reading documentation: whether
   * Cloudflare Email Routing delivers a Worker the headers a sender-authenticity check would need.
   * `Authentication-Results`, `Received`, and `DKIM-Signature` are all reported missing from
   * `message.headers` (cloudflare/workerd#6740), but `message.raw` — which is what this parses — is
   * documented as the raw MIME and is a different surface. Inferring the answer from a GitHub issue
   * is guessing; logging what arrived means the first real delivery answers it.
   *
   * See issue #47, which is where that live verification lives.
   */
  authHeadersSeen: string[];
  /**
   * Whether this looks machine-generated: an out-of-office, a mailing-list post, or a bulk send.
   *
   * Not a reason to drop the message — a vacation responder appended to a real thread is context an
   * operator wants — but a good reason not to pay a model to classify it. Read by the ingest path to
   * skip the classification dispatch, which is the only cost per message that is not fixed.
   */
  autoSubmitted: boolean;
}

/**
 * A verdict at the start of its clause. Anchored: an unanchored scan matched `method=result` inside a
 * *property tag*, and `smtp.mailfrom=` carries an address the sender chose.
 */
const VERDICT = /^\s*(dmarc|spf|dkim|iprev)\s*=\s*([a-z]+)/i;

/**
 * The headers whose presence decides whether in-Worker sender authentication is possible at all.
 * Reported, never trusted — see {@link ParsedInboundMessage.authHeadersSeen}.
 */
const AUTH_HEADERS = ["authentication-results", "dkim-signature", "arc-authentication-results", "received"];

/** The longest subject stored. Long enough for any real one; short enough not to be a storage lever. */
const MAX_SUBJECT = 500;

/** The longest text body stored, **in bytes**. A support request needing more than this has a file attached. */
export const MAX_TEXT_BODY = 256 * 1024;

/** Pull the first usable address out of whatever `postal-mime` produced for a header. */
function addressesOf(value: Address | Address[] | undefined): string[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const found: string[] = [];
  for (const entry of list) {
    // A group address (`Undisclosed recipients: ;`) carries its members rather than an address of
    // its own, so both forms flatten to the same list before anything is normalized.
    const members = entry.group !== undefined ? entry.group : entry.address !== undefined ? [entry] : [];
    for (const member of members) {
      const normalized = parseAddress(member.address);
      if (normalized) found.push(normalized);
    }
  }
  return found;
}

/**
 * Make a declared filename safe to store and display.
 *
 * Path separators go first — a name is never part of a storage key here, but a dashboard that offers
 * a download should not be handed `../../etc/passwd` to put in a `Content-Disposition`. Control
 * characters and bidirectional overrides go with them: a filename carrying a right-to-left override
 * renders as something other than what it is, which is the oldest attachment trick there is.
 */
export function safeFilename(value: string | null | undefined): string {
  const cleaned = (value ?? "")
    // biome-ignore-start lint/suspicious/noControlCharactersInRegex: stripping control
    // characters is the entire purpose — a bidi override renders a filename or a display name as
    // something other than what it is, which is the oldest trick in inbound mail.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    // biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above
    .replace(/[/\\]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "attachment";
}

/**
 * Parse `Authentication-Results` into `method → verdict`.
 *
 * Cloudflare stamps this before a message reaches a Worker, so it is the one trustworthy statement
 * about the sender available here — everything else in the message is the sender's own claim. The
 * format is `mta.example.com; spf=pass smtp.mailfrom=a@b; dkim=pass header.d=b; dmarc=pass`, and
 * only the method/verdict pairs are read; the property tags after each are informational.
 */
/**
 * The authserv-id out of an `Authentication-Results` first clause: the host name, with the optional
 * version token and any CFWS comments removed, lowercased.
 */
function authservIdOf(clause: string | undefined): string {
  return (clause ?? "")
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .replace(/\s+\d+$/, "")
    .trim()
    .toLowerCase();
}

export function parseAuthResults(value: string | undefined, expectedAuthservId?: string): Record<string, string> {
  if (typeof value !== "string") return {};

  // Quoted strings go first. A local part may legally be quoted and may then contain `;` and `=` —
  // `"a;dmarc=pass"@evil.com` is a valid address — so a sender who chooses their own envelope address
  // can otherwise manufacture what looks like a whole extra verdict clause inside the header the MTA
  // stamped about them. Blanking quoted runs removes that alphabet entirely.
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, '""');

  // RFC 8601: `authserv-id; method=result properties; method=result properties`. The authserv-id is
  // the first field and every verdict lives at the *start* of a subsequent `;`-delimited clause.
  const clauses = unquoted.split(";");

  // Microsoft 365 stamps this header with **no authserv-id at all**, so its first clause is already a
  // verdict. Skipping clause 0 unconditionally dropped that verdict — and, with `authservId`
  // configured, compared a verdict against a hostname, failed, and returned nothing at all: the
  // customer link silently off for every message behind Exchange Online. That is exactly the failure
  // this function's own comment says a safety check must not have.
  const leadingIsVerdict = VERDICT.test(clauses[0] ?? "");

  if (expectedAuthservId !== undefined && !leadingIsVerdict) {
    // Normalized before comparing, because RFC 8601 lets the authserv-id clause carry more than the
    // id: an optional version token (`mx.example.com 1;`) and CFWS comments
    // (`mx.example.com (amavisd-new);`) are both legal and both common. An exact match against the
    // whole clause therefore fails for an adopter who configured the value correctly by reading it off
    // a delivered message — and it fails *closed*, silently turning off the customer link for every
    // message with nothing but an info log to show for it. A safety check that disables the feature it
    // guards, when configured as documented, is worse than no check.
    if (authservIdOf(clauses[0]) !== authservIdOf(expectedAuthservId)) return {};
  }

  const results: Record<string, string> = {};
  // Clause 0 is read only when it *is* a verdict. Otherwise it is a host name, and an attacker who
  // could get it read would only have to call themselves `dmarc=pass` to authenticate themselves.
  for (const clause of leadingIsVerdict ? clauses : clauses.slice(1)) {
    // **Anchored.** The old scan searched the whole string, so it matched a `method=result` pair
    // appearing inside a *property tag* — and `smtp.mailfrom=` carries an address the sender chose.
    // `MAIL FROM: <dmarc=pass@evil.com>` made the MTA's own honest header read as a DMARC pass.
    // A verdict is only a verdict when it opens its clause.
    const match = VERDICT.exec(clause);
    const method = match?.[1]?.toLowerCase();
    const verdict = match?.[2]?.toLowerCase();
    // First clause wins for a method: a second one is a forgery appended after the real answer.
    if (method && verdict && !(method in results)) results[method] = verdict;
  }
  return results;
}

/** Whether a header set marks the message as machine-generated. */
function isAutoSubmitted(headers: Map<string, string>): boolean {
  const autoSubmitted = headers.get("auto-submitted")?.toLowerCase() ?? "";
  if (autoSubmitted.startsWith("auto-")) return true;
  const precedence = headers.get("precedence")?.toLowerCase() ?? "";
  if (["bulk", "list", "junk", "auto_reply"].includes(precedence)) return true;
  return headers.has("list-id") || headers.has("list-unsubscribe") || headers.has("x-autoreply");
}

/** Decode `postal-mime`'s attachment content into bytes, whatever form it handed back. */
function attachmentBytes(attachment: Attachment): Uint8Array {
  const content = attachment.content;
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

/** Parse a raw MIME message. Throws `support/unparseable_message` when there is no usable sender. */
export async function parseInbound(
  raw: string | ArrayBuffer | Uint8Array,
  options: { expectedAuthservId?: string } = {},
): Promise<ParsedInboundMessage> {
  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch (cause) {
    throw new SupportUnparseableMessageError({ detail: "postal-mime could not parse the message" }, { cause });
  }

  // **First occurrence wins, and this is a security boundary rather than a style choice.**
  //
  // `postal-mime` returns headers in document order, and a receiving MTA *prepends* its trace headers
  // — `Authentication-Results` above all — while a sender's own copy of that header stays wherever
  // they put it, which is below. A `Map.set` loop keeps the last occurrence, so last-wins hands the
  // attacker's forged `dmarc=pass` to the authenticity check instead of Cloudflare's real verdict,
  // and inverts the entire anti-spoofing control into a bypass.
  //
  // Trace headers are prepended as a class, so first-wins is the correct rule for every header read
  // through this map, not only for the one that made it obvious.
  const headers = new Map<string, string>();
  for (const header of email.headers) {
    const key = header.key.toLowerCase();
    if (!headers.has(key)) headers.set(key, header.value);
  }

  const fromAddress = addressesOf(email.from)[0];
  if (!fromAddress) {
    // No sender means no thread key, no user link, and nothing to reply to. Refusing here is better
    // than storing a row that can never be acted on.
    throw new SupportUnparseableMessageError({ detail: "the message carried no parseable From address" });
  }

  const from = Array.isArray(email.from) ? email.from[0] : email.from;
  const inReplyTo = normalizeMessageId(email.inReplyTo);

  return {
    messageId: normalizeMessageId(email.messageId),
    inReplyTo,
    references: parseReferences(email.references),
    fromAddress,
    fromName: normalizeDisplayName(from?.name),
    headerRecipients: [
      ...new Set([
        ...addressesOf(email.to),
        ...addressesOf(email.cc),
        ...(parseAddress(email.deliveredTo) ? [parseAddress(email.deliveredTo) as string] : []),
      ]),
    ],
    subject: (email.subject ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT),
    text: truncateToBytes(email.text ?? "", MAX_TEXT_BODY),
    html: email.html,
    attachments: email.attachments.map((attachment) => ({
      filename: safeFilename(attachment.filename),
      contentType: attachment.mimeType || "application/octet-stream",
      bytes: attachmentBytes(attachment),
      contentId: attachment.contentId?.replace(/^<|>$/g, "") || undefined,
      inline: attachment.disposition === "inline",
    })),
    authResults: parseAuthResults(headers.get("authentication-results"), options.expectedAuthservId),
    authHeadersSeen: AUTH_HEADERS.filter((name) => headers.has(name)),
    autoSubmitted: isAutoSubmitted(headers),
  };
}
