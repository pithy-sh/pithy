// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * RFC 5322 threading — turning `Message-ID`, `In-Reply-To`, and `References` into a conversation.
 *
 * **Threading is done on ids, never on the subject.** Subject matching is what makes two unrelated
 * people who both wrote "Refund" land in one thread, and it is what splits a real conversation the
 * moment somebody's client localizes `Re:` to `Aw:` or `Antw:`. The headers exist precisely so this
 * does not have to be guessed, and every mail client sets them.
 *
 * The chain is tried in the order that goes from most precise to least: `In-Reply-To` names exactly
 * one message, so it is asked first; `References` is the whole ancestry, so it is the fallback for a
 * client that dropped `In-Reply-To` or a reply to a message that reached us out of order. Reading
 * `References` **newest-first** matters — the last entry is the nearest ancestor, and starting at the
 * root would attach a reply to the top of a long thread rather than to the message it answers.
 */

/** The longest `References` chain kept. Bounded because the header is attacker-controlled and unbounded by spec. */
export const MAX_REFERENCES = 50;

/** The longest single message id kept, after unwrapping. Anything longer is not an id a client produced. */
const MAX_ID_LENGTH = 512;

/**
 * Strip the angle brackets from a message id and bound it.
 *
 * Stored without brackets so a lookup is plain equality: the brackets are transport syntax, and one
 * path storing `<a@b>` while another queries `a@b` is a threading bug that only shows up on replies.
 */
export function normalizeMessageId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) return undefined;
  // Whitespace inside means this was a list, not an id — the caller wanted `parseReferences`.
  return /\s/.test(trimmed) ? undefined : trimmed;
}

/**
 * Parse a `References` (or `In-Reply-To`) header into ids, oldest first, deduplicated and bounded.
 *
 * `postal-mime` hands `references` back as the raw header string, so the splitting is ours. Angle
 * brackets are the delimiter when they are present and whitespace is the fallback when they are not,
 * because a malformed header from a hand-rolled sender is a normal input here.
 *
 * **When the chain is over the cap, the OLDEST entries are dropped, not the newest.** That direction
 * is the whole point: `parentCandidates` reads this list from the newest end backwards, because the
 * nearest ancestor is the message a reply actually answers. Capping from the other end would discard
 * exactly the ids the lookup wants first and keep the ones it would reach last — so a long thread
 * would silently stop threading on `References` and fall back to whatever `In-Reply-To` happened to
 * survive. Same rule `buildReferencesHeader` follows on the way out, and RFC 5322 §3.6.4 says to trim
 * this end for the same reason.
 */
export function parseReferences(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  const bracketed = [...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1] ?? "");
  const candidates = bracketed.length > 0 ? bracketed : value.split(/\s+/);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = normalizeMessageId(candidate);
    if (id) seen.add(id);
  }
  const ids = [...seen];
  return ids.length > MAX_REFERENCES ? ids.slice(ids.length - MAX_REFERENCES) : ids;
}

/**
 * The ids to look a parent up by, most precise first.
 *
 * The order is the whole content of this function: `In-Reply-To`, then `References` from the newest
 * entry backwards. A caller resolves the first one it recognizes and stops.
 */
export function parentCandidates(inReplyTo: string | undefined, references: readonly string[]): string[] {
  const ordered = [...(inReplyTo ? [inReplyTo] : []), ...[...references].reverse()];
  return [...new Set(ordered)];
}

/**
 * Build the `References` header value for an outgoing reply.
 *
 * RFC 5322 §3.6.4: a reply's `References` is the parent's `References` followed by the parent's
 * `Message-ID`. Getting this wrong is not cosmetic — it is the difference between the customer
 * seeing one conversation and seeing a new mail every time somebody answers them, which is the
 * single most visible way a support inbox looks broken from the outside. It is also the reason
 * replying belongs in the Worker rather than in a dashboard: only the Worker holds the chain.
 *
 * The result is bracketed and space-separated, ready to be a header value, and bounded from the
 * *front* — RFC 5322 says to drop the oldest entries when a chain has to be trimmed, because the
 * recent ones are what a client threads on.
 */
export function buildReferencesHeader(parentReferences: readonly string[], parentMessageId?: string): string {
  // The parent's id is removed from the inherited chain before being re-appended, so it lands *last*
  // even when it already appeared mid-chain. A plain `Set` would keep its first position instead, and
  // §3.6.4's "parent's id last" property would quietly not hold for the one input where it is easiest
  // to get wrong: a reply to a message that was itself already referenced.
  const inherited = parentReferences.filter((id) => id !== parentMessageId);
  const chain = [...inherited, ...(parentMessageId ? [parentMessageId] : [])];
  const deduped = [...new Set(chain)];
  const trimmed = deduped.length > MAX_REFERENCES ? deduped.slice(deduped.length - MAX_REFERENCES) : deduped;
  return trimmed.map((id) => `<${id}>`).join(" ");
}

/**
 * Mint a `Message-ID` for an outgoing reply.
 *
 * Ours to generate, because a message we send has to be nameable by the customer's own reply — their
 * client will put this value in its `In-Reply-To`, and that is how the answer comes back to the same
 * thread. The domain half is taken from the address it is sent as, so the id is plausible to a
 * receiving spam filter rather than pointing at a domain we do not control.
 */
export function mintMessageId(fromAddress: string, uuid: string): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1) || "localhost";
  return `${uuid}@${domain}`;
}

/**
 * The subject line for a reply — `Re: ` prefixed exactly once.
 *
 * Match `Re:` case-insensitively and allow the bracketed count some clients add (`Re[2]:`), so
 * answering a long thread does not build `Re: Re: Re: Re:`. Non-English prefixes are deliberately
 * left alone: they are unbounded in practice, and a stray `Aw: Re:` is cosmetic, while stripping a
 * word that happened to look like a prefix would change what the customer wrote.
 */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re(\[\d+\])?:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
