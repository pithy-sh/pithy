// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SupportUnparseableMessageError } from "../error/errors";
import { senderAuthenticity } from "../inbound/authenticity";
import { MAX_TEXT_BODY, parseAuthResults, parseInbound, safeFilename } from "./parse";

/**
 * Real RFC 5322 bytes, parsed by the real `postal-mime`.
 *
 * Nothing here is mocked. A stubbed parser would let every assertion below pass against a module that
 * never decoded a base64 part or unwrapped an angle bracket, which is the one thing these tests exist
 * to prove it does.
 */

const CRLF = "\r\n";

/** A header block, a blank line, a body — which is also exactly the shape of one MIME part. */
function message(headers: string[], body = ""): string {
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** Wrap parts in their boundary delimiters, closing with the terminal `--boundary--`. */
function multipart(boundary: string, parts: string[]): string {
  return [...parts.flatMap((part) => [`--${boundary}`, part]), `--${boundary}--`, ""].join(CRLF);
}

/** Base64, the way a `Content-Transfer-Encoding: base64` part carries bytes. */
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** An RFC 2047 encoded-word — the only way to put a tab or a newline inside a header value. */
function encodedWord(text: string): string {
  return `=?utf-8?B?${base64(new TextEncoder().encode(text))}?=`;
}

describe("parseInbound, a plain text message", () => {
  const raw = message(
    [
      "From: Ada Lovelace <Ada@Example.COM>",
      "To: support@acme.test",
      "Subject: Card declined",
      "Message-ID: <abc-123@example.com>",
      "Content-Type: text/plain; charset=utf-8",
    ],
    `The payment failed twice.${CRLF}`,
  );

  test("reads the sender, the subject, and the body", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.subject).toBe("Card declined");
    expect(parsed.text).toContain("The payment failed twice.");
    expect(parsed.fromName).toBe("Ada Lovelace");
  });

  test("lowercases the sender, so one customer is one thread rather than two", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.fromAddress).toBe("ada@example.com");
  });

  test("stores the Message-ID without its angle brackets", async () => {
    // Threading is plain equality on this value. One path storing `<a@b>` while another queries `a@b`
    // is a bug that stays invisible until the first reply arrives and starts a second thread.
    const parsed = await parseInbound(raw);
    expect(parsed.messageId).toBe("abc-123@example.com");
  });

  test("carries no HTML and no attachments when the message had none", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.html).toBeUndefined();
    expect(parsed.attachments).toEqual([]);
  });

  test("unwraps the threading chain, oldest first", async () => {
    const parsed = await parseInbound(
      message(
        [
          "From: ada@example.com",
          "Message-ID: <reply@example.com>",
          "In-Reply-To: <second@acme.test>",
          "References: <first@acme.test> <second@acme.test>",
        ],
        "Any news?",
      ),
    );
    expect(parsed.inReplyTo).toBe("second@acme.test");
    expect(parsed.references).toEqual(["first@acme.test", "second@acme.test"]);
  });
});

describe("parseInbound, multipart/alternative", () => {
  const html = '<p onclick="steal()">Hi<script>alert(1)</script><img src=x onerror=go()></p>';
  const raw = message(
    ["From: ada@example.com", "Subject: Both bodies", 'Content-Type: multipart/alternative; boundary="ALT"'],
    multipart("ALT", [
      message(["Content-Type: text/plain; charset=utf-8"], "the plain alternative"),
      message(["Content-Type: text/html; charset=utf-8"], html),
    ]),
  );

  test("extracts the text and the HTML alternative both", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.text).toContain("the plain alternative");
    expect(parsed.html).toContain("Hi");
  });

  test("returns the HTML exactly as it arrived, unsanitised — that is this module's contract", async () => {
    // The caller runs `sanitizeHtml` (a Workers global, `HTMLRewriter`) afterwards. If a sanitiser ever
    // crept in here, the raw bytes and the parsed form would quietly disagree about what was sent, and
    // this file could no longer run under node at all.
    const parsed = await parseInbound(raw);
    expect(parsed.html).toContain("<script>alert(1)</script>");
    expect(parsed.html).toContain('onclick="steal()"');
    expect(parsed.html).toContain("onerror=go()");
  });
});

describe("parseInbound, attachments", () => {
  const receipt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x41]);
  const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const raw = message(
    ["From: ada@example.com", "Subject: Receipt", 'Content-Type: multipart/mixed; boundary="MIX"'],
    multipart("MIX", [
      message(["Content-Type: text/plain"], "See attached."),
      message(
        [
          "Content-Type: application/pdf",
          "Content-Transfer-Encoding: base64",
          'Content-Disposition: attachment; filename="../../etc/receipt.pdf"',
        ],
        base64(receipt),
      ),
      message(
        [
          "Content-Type: image/png",
          "Content-Transfer-Encoding: base64",
          "Content-ID: <logo@acme.test>",
          'Content-Disposition: inline; filename="logo.png"',
        ],
        base64(logo),
      ),
    ]),
  );

  test("decodes a base64 part back to the bytes the sender encoded", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.attachments[0]?.bytes).toEqual(receipt);
  });

  test("measures the attachment from the decoded bytes, not from the base64 that carried them", async () => {
    // The stored `size` and the guard's byte bound both read `bytes.byteLength`. Measuring the encoded
    // text instead would overstate every attachment by a third and refuse ones that fit.
    const parsed = await parseInbound(raw);
    expect(parsed.attachments[0]?.bytes.byteLength).toBe(receipt.byteLength);
    expect(base64(receipt).length).toBeGreaterThan(receipt.byteLength);
  });

  test("keeps the declared content type as declared", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.attachments.map((attachment) => attachment.contentType)).toEqual(["application/pdf", "image/png"]);
  });

  test("strips the path out of a declared filename", async () => {
    // A dashboard puts this in a `Content-Disposition`, so `../../etc/receipt.pdf` must not survive
    // the parse with its separators intact.
    const parsed = await parseInbound(raw);
    expect(parsed.attachments[0]?.filename).toBe(".._.._etc_receipt.pdf");
  });

  test("marks an inline part inline and unwraps its Content-ID, which is what a cid: reference matches", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.attachments[1]?.inline).toBe(true);
    expect(parsed.attachments[1]?.contentId).toBe("logo@acme.test");
    expect(parsed.attachments[1]?.bytes).toEqual(logo);
  });

  test("a plain attachment is neither inline nor carrying a Content-ID", async () => {
    const parsed = await parseInbound(raw);
    expect(parsed.attachments[0]?.inline).toBe(false);
    expect(parsed.attachments[0]?.contentId).toBeUndefined();
  });

  test("a part that declares an empty type and no filename still lands as a named, typed attachment", async () => {
    // Both fields are stored and one of them is rendered, so neither may come out blank because a
    // sender left the header empty.
    const parsed = await parseInbound(
      message(
        ["From: ada@example.com", 'Content-Type: multipart/mixed; boundary="MIX"'],
        multipart("MIX", [
          message(["Content-Type: text/plain"], "body"),
          message(["Content-Type: ", "Content-Disposition: attachment", "Content-Transfer-Encoding: base64"], "eHk="),
        ]),
      ),
    );
    expect(parsed.attachments[0]?.contentType).toBe("application/octet-stream");
    expect(parsed.attachments[0]?.filename).toBe("attachment");
    expect(parsed.attachments[0]?.bytes).toEqual(new TextEncoder().encode("xy"));
  });
});

describe("parseInbound, headerRecipients", () => {
  test("collects To, Cc, and Delivered-To, normalized and deduped", async () => {
    // The same inbox reached through three headers in three casings is one recipient. Deduping after
    // normalization is what keeps the inbox-matching evidence from counting it three times.
    const parsed = await parseInbound(
      message(
        [
          "From: ada@example.com",
          "To: Support <Support@Acme.test>",
          "Cc: Ops <OPS@acme.test>, support@acme.test",
          "Delivered-To: SUPPORT@ACME.TEST",
        ],
        "Hello",
      ),
    );
    expect(parsed.headerRecipients).toEqual(["support@acme.test", "ops@acme.test"]);
  });

  test("flattens a group recipient to its members, contributing nothing when it has none", async () => {
    const parsed = await parseInbound(
      message(["From: ada@example.com", "To: undisclosed-recipients: ;", "Cc: ops@acme.test"], "Hello"),
    );
    expect(parsed.headerRecipients).toEqual(["ops@acme.test"]);
  });

  test("drops a recipient that is not recognizably an address", async () => {
    const parsed = await parseInbound(message(["From: ada@example.com", "To: Nobody, ops@acme.test"], "Hello"));
    expect(parsed.headerRecipients).toEqual(["ops@acme.test"]);
  });
});

describe("parseInbound, a message with no usable sender", () => {
  test("refuses a message with no From header", async () => {
    // No sender means no thread key, no account link, and nothing to reply to. A stored row like that
    // could never be acted on, so the refusal belongs here rather than three tables later.
    const raw = message(["To: support@acme.test", "Subject: Anonymous"], "Hello");
    await expect(parseInbound(raw)).rejects.toThrow(SupportUnparseableMessageError);
    const error = await parseInbound(raw).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SupportUnparseableMessageError);
    expect((error as SupportUnparseableMessageError).payload.code).toBe("support/unparseable_message");
  });

  test("refuses a From that is a display name and nothing else", async () => {
    const error = await parseInbound(message(["From: Nobody", "Subject: Hi"], "Hello")).catch(
      (cause: unknown) => cause,
    );
    expect((error as SupportUnparseableMessageError).payload.code).toBe("support/unparseable_message");
  });

  test("keeps the sender's own text out of the public message, which the error channel would reflect", async () => {
    const error = await parseInbound(message(["Subject: reflect-me-please"], "Hello")).catch((cause: unknown) => cause);
    expect((error as SupportUnparseableMessageError).payload.message).not.toContain("reflect-me-please");
  });
});

describe("parseInbound, autoSubmitted", () => {
  // Each of these is a machine talking. The flag is what lets ingest skip the classification dispatch,
  // which is the only per-message cost that is not fixed.
  test.each([
    ["Auto-Submitted: auto-replied", "an out-of-office"],
    ["Auto-Submitted: auto-generated", "a generated notice"],
    ["Precedence: bulk", "a bulk send"],
    ["List-Id: <announce.acme.test>", "a mailing-list post"],
    ["List-Unsubscribe: <mailto:leave@acme.test>", "a list with only an unsubscribe header"],
    ["X-Autoreply: yes", "a vacation responder"],
  ])("%s marks the message as machine-generated — %s", async (header) => {
    const parsed = await parseInbound(message(["From: ada@example.com", "Subject: Out of office", header], "Away."));
    expect(parsed.autoSubmitted).toBe(true);
  });

  test("a person writing in is not flagged", async () => {
    const parsed = await parseInbound(
      message(["From: ada@example.com", "Subject: Card declined", "Auto-Submitted: no"], "Please help."),
    );
    expect(parsed.autoSubmitted).toBe(false);
  });
});

describe("parseInbound, bounds", () => {
  test("collapses runs of whitespace in a subject to single spaces and trims the ends", async () => {
    const parsed = await parseInbound(
      message(["From: ada@example.com", `Subject: ${encodedWord("  Card \t\r\n  declined  ")}`], "Hello"),
    );
    expect(parsed.subject).toBe("Card declined");
  });

  test("a message with no subject parses to an empty one rather than an absent one", async () => {
    const parsed = await parseInbound(message(["From: ada@example.com"], "Hello"));
    expect(parsed.subject).toBe("");
  });

  test("bounds the subject at 500 characters, so a header is not a storage lever", async () => {
    const parsed = await parseInbound(message(["From: ada@example.com", `Subject: ${"x".repeat(4000)}`], "Hello"));
    expect(parsed.subject).toHaveLength(500);
  });

  test("bounds the text body at MAX_TEXT_BODY", async () => {
    // Truncation, not refusal: a padded body is still a real support request, and the attachment path
    // is where anything genuinely larger belongs.
    const body = "a".repeat(MAX_TEXT_BODY + 50_000);
    const parsed = await parseInbound(message(["From: ada@example.com", "Content-Type: text/plain"], body));
    expect(parsed.text).toHaveLength(MAX_TEXT_BODY);
    expect(parsed.text.startsWith("aaaa")).toBe(true);
  });

  test("a body under the bound is left whole", async () => {
    const parsed = await parseInbound(message(["From: ada@example.com", "Content-Type: text/plain"], "short enough"));
    expect(parsed.text.trim()).toBe("short enough");
  });
});

describe("safeFilename", () => {
  test("turns path separators into underscores", () => {
    expect(safeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeFilename("..\\..\\windows\\system32")).toBe(".._.._windows_system32");
  });

  test("strips control characters and bidirectional overrides", () => {
    // A right-to-left override makes `invoice\u202egpj.exe` render as `invoiceexe.jpg` in a file
    // listing. Stripping it is what keeps the displayed name and the stored name the same string.
    expect(safeFilename("invoice\u202egpj.exe")).toBe("invoicegpj.exe");
    expect(safeFilename("repo\u0007rt.pdf")).toBe("report.pdf");
    expect(safeFilename("wrap\u2066pe\u2069d.png")).toBe("wrapped.png");
  });

  test("falls back to attachment when nothing usable is left", () => {
    expect(safeFilename("")).toBe("attachment");
    expect(safeFilename("   ")).toBe("attachment");
    expect(safeFilename("\u202e\u0000")).toBe("attachment");
    expect(safeFilename(null)).toBe("attachment");
    expect(safeFilename(undefined)).toBe("attachment");
  });

  test("bounds a filename at 200 characters", () => {
    expect(safeFilename(`${"n".repeat(500)}.pdf`)).toHaveLength(200);
  });

  test("leaves an ordinary name alone", () => {
    expect(safeFilename("Receipt 2026-01.pdf")).toBe("Receipt 2026-01.pdf");
  });
});

describe("Authentication-Results, when a sender forges one of their own", () => {
  /**
   * The bypass this suite exists for.
   *
   * A receiving MTA **prepends** its trace headers, so its verdict is the topmost one and a sender's
   * own copy is always below it. `postal-mime` returns headers in document order, so a header map
   * built with a plain `Map.set` loop keeps the *last* occurrence — the attacker's — and the whole
   * anti-spoofing control inverts into a bypass with no prerequisites at all.
   *
   * The earlier unit test only covered two verdicts inside one header *string*, which passes happily
   * while this fails. Only a real message carrying two separate headers catches it.
   */
  const forged = [
    "Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=evil@attacker.test; dmarc=fail",
    "From: Ada Lovelace <ada@victim.test>",
    "To: support@help.example.com",
    "Subject: I lost my 2FA device",
    "Message-ID: <forged@attacker.test>",
    "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=ada@victim.test; dkim=pass; dmarc=pass",
  ];

  test("the MTA's verdict wins, not the sender's forgery below it", async () => {
    const parsed = await parseInbound(message(forged, "Please reset my account."));
    expect(parsed.authResults).toEqual({ spf: "fail", dmarc: "fail" });
  });

  test("the forged pass does not survive into an authenticated sender", async () => {
    const parsed = await parseInbound(message(forged, "Please reset my account."));
    expect(
      senderAuthenticity({
        authResults: parsed.authResults,
        fromAddress: parsed.fromAddress,
        envelopeFrom: "evil@attacker.test",
        // Trust granted, so the assertion is about the parse rather than about the gate above it.
        trusted: true,
      }),
    ).toEqual({ authenticated: false, method: "none" });
  });

  test("a genuine single stamp still authenticates, so the fix is not vacuous", async () => {
    const parsed = await parseInbound(
      message(
        [
          "Authentication-Results: mx.cloudflare.net; dmarc=pass",
          "From: Ada Lovelace <ada@victim.test>",
          "To: support@help.example.com",
          "Subject: Hello",
          "Message-ID: <genuine@victim.test>",
        ],
        "Hello.",
      ),
    );
    expect(parsed.authResults.dmarc).toBe("pass");
  });

  test("every header read through the map is first-wins, not only the one that exposed it", async () => {
    // `Auto-Submitted` is read from the same map. A forged second copy must not override the first
    // either — the rule is about how trace headers are written, not about one field.
    const parsed = await parseInbound(
      message(
        [
          "Auto-Submitted: auto-replied",
          "From: bot@example.com",
          "To: support@help.example.com",
          "Subject: Out of office",
          "Auto-Submitted: no",
        ],
        "Away until Monday.",
      ),
    );
    expect(parsed.autoSubmitted).toBe(true);
  });

  test("a second From below the first does not become the sender", async () => {
    // **The half of first-wins the header map never covered.** `fromAddress`, `subject` and the
    // recipient lists do not come from that map — they come from `postal-mime`'s own single-value
    // resolution, and through 2.7.x that resolution was *last*-wins. So a sender could append a
    // second `From:` at the bottom of their own headers and the address this capability recorded as
    // the sender was theirs to choose, while every verdict above it was stamped against the topmost
    // one. What was authenticated and what was stored disagreed, by construction.
    //
    // `postal-mime` 3.0.0 resolves duplicated single-value headers first-wins, which is the same rule
    // the map already applied, so the two halves finally agree. Planted here rather than asserted in
    // prose: under 2.7.6 this test reads `mallory@attacker.test` and fails.
    const parsed = await parseInbound(
      message(
        [
          "Authentication-Results: mx.cloudflare.net; dmarc=pass",
          "From: Ada Lovelace <ada@victim.test>",
          "To: support@help.example.com",
          "Subject: I lost my 2FA device",
          "From: Mallory <mallory@attacker.test>",
          "Subject: forged subject",
        ],
        "Please reset my account.",
      ),
    );
    expect(parsed.fromAddress).toBe("ada@victim.test");
    expect(parsed.fromName).toBe("Ada Lovelace");
    expect(parsed.subject).toBe("I lost my 2FA device");
  });

  test("an authserv-id that does not match the configured one is discarded entirely", async () => {
    // Defence in depth for the residual case: the MTA stamped nothing, so the forgery is topmost.
    const parsed = await parseInbound(
      message(
        [
          "Authentication-Results: attacker-chosen-host; dmarc=pass",
          "From: Ada Lovelace <ada@victim.test>",
          "To: support@help.example.com",
          "Subject: Hello",
        ],
        "Hello.",
      ),
      { expectedAuthservId: "mx.cloudflare.net" },
    );
    expect(parsed.authResults).toEqual({});
  });

  test("an authserv-id carrying the optional version token still matches", async () => {
    // RFC 8601 permits `authserv-id [CFWS] version`, and an exact string compare fails on it — closed,
    // so an adopter who configured the value correctly by reading a delivered message silently loses
    // the customer link on every message thereafter.
    const parsed = await parseInbound(
      message(
        ["Authentication-Results: mx.example.com 1; dmarc=pass", "From: a@b.test", "To: s@h.test", "Subject: Hi"],
        "Hi.",
      ),
      { expectedAuthservId: "mx.example.com" },
    );
    expect(parsed.authResults.dmarc).toBe("pass");
  });

  test("an authserv-id carrying a CFWS comment still matches", async () => {
    const parsed = await parseInbound(
      message(
        [
          "Authentication-Results: mx.example.com (amavisd-new); dmarc=pass",
          "From: a@b.test",
          "To: s@h.test",
          "Subject: Hi",
        ],
        "Hi.",
      ),
      { expectedAuthservId: "mx.example.com" },
    );
    expect(parsed.authResults.dmarc).toBe("pass");
  });

  test("a genuinely different authserv-id is still refused", async () => {
    // The normalization must not be so eager that it stops telling hosts apart.
    const parsed = await parseInbound(
      message(
        ["Authentication-Results: evil.example.net 1; dmarc=pass", "From: a@b.test", "To: s@h.test", "Subject: Hi"],
        "Hi.",
      ),
      { expectedAuthservId: "mx.example.com" },
    );
    expect(parsed.authResults).toEqual({});
  });

  test("a matching authserv-id is still read, case-insensitively", async () => {
    const parsed = await parseInbound(
      message(
        [
          "Authentication-Results: MX.Cloudflare.NET; dmarc=pass",
          "From: Ada Lovelace <ada@victim.test>",
          "To: support@help.example.com",
          "Subject: Hello",
        ],
        "Hello.",
      ),
      { expectedAuthservId: "mx.cloudflare.net" },
    );
    expect(parsed.authResults.dmarc).toBe("pass");
  });
});

describe("which authentication headers actually arrived", () => {
  /**
   * A diagnostic, so the tests are about it being *accurate* rather than about anything branching on
   * it. The value it produces in production is the one fact this package cannot look up: whether
   * Cloudflare Email Routing gives a Worker anything to verify a sender against. See issue #47.
   */
  test("reports the headers that were present, and only those", async () => {
    const parsed = await parseInbound(
      message(
        [
          "Authentication-Results: mx.cloudflare.net; dmarc=pass",
          "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; b=AAAA",
          "From: a@b.test",
          "To: s@h.test",
          "Subject: Hi",
        ],
        "Hi.",
      ),
    );
    expect(parsed.authHeadersSeen).toEqual(["authentication-results", "dkim-signature"]);
  });

  test("an empty list is the answer that matters — nothing to verify against", async () => {
    // If a real Cloudflare delivery produces this, in-Worker sender authentication is impossible and
    // the honest-match design is the end of the road rather than a stepping stone.
    const parsed = await parseInbound(message(["From: a@b.test", "To: s@h.test", "Subject: Hi"], "Hi."));
    expect(parsed.authHeadersSeen).toEqual([]);
  });

  test("it observes rather than decides — a DKIM signature alone authenticates nothing", async () => {
    const parsed = await parseInbound(
      message(
        [
          "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; b=AAAA",
          "From: a@b.test",
          "To: s@h.test",
          "Subject: Hi",
        ],
        "Hi.",
      ),
    );
    expect(parsed.authHeadersSeen).toContain("dkim-signature");
    // Present is not verified. Nothing here parses or checks the signature yet.
    expect(parsed.authResults).toEqual({});
  });
});

describe("headers stamped without an authserv-id", () => {
  /**
   * Microsoft 365 writes `Authentication-Results` with no authserv-id, so its first `;`-clause is
   * already a verdict. Skipping clause 0 unconditionally dropped it — and with `authservId`
   * configured, compared a verdict against a hostname and returned nothing at all, silently switching
   * the customer link off for every adopter behind Exchange Online.
   */
  const outlook =
    "spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=contoso.com; dkim=pass header.d=contoso.com; dmarc=pass action=none";

  test("the leading verdict is read rather than mistaken for a host name", async () => {
    expect(parseAuthResults(outlook)).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  test("a configured authservId does not wipe a header that has none", async () => {
    // Failing closed here means the feature the adopter just configured turns itself off.
    expect(parseAuthResults(outlook, "mx.cloudflare.net")).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  test("a host name in clause 0 is still never read as a verdict", async () => {
    // The protection this replaced: an attacker who could get clause 0 read would only need to call
    // themselves `dmarc=pass`.
    expect(parseAuthResults("mx.cloudflare.net; spf=fail")).toEqual({ spf: "fail" });
    expect(parseAuthResults("dmarc=pass; spf=fail")).toEqual({ dmarc: "pass", spf: "fail" });
  });

  test("a normal Cloudflare header is unaffected", async () => {
    expect(parseAuthResults("mx.cloudflare.net; dkim=pass header.d=x.com; dmarc=pass")).toEqual({
      dkim: "pass",
      dmarc: "pass",
    });
  });
});
