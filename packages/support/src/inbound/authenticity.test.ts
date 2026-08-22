// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { parseAuthResults } from "../mime/parse";
import { domainsAlign, senderAuthenticity } from "./authenticity";

/**
 * Whether a `From:` header may be believed.
 *
 * This is the gate on the customer link, so the failure it exists to prevent is specific: an attacker
 * mails the support inbox as `victim@gmail.com`, the link resolves that address to a real account,
 * and the console renders the attacker's thread decorated with the victim's name, entitlements, and
 * purchase history — which an operator then acts on. Every test below is about not doing that.
 */

const FROM = "ada@example.com";

/** The verdicts, as `parseAuthResults` would produce them from a real header. */
function results(header: string): Record<string, string> {
  return parseAuthResults(header);
}

describe("parseAuthResults", () => {
  test("reads each method's verdict out of a real Cloudflare header", () => {
    expect(results("mx.cloudflare.net; spf=pass smtp.mailfrom=a@b.com; dkim=pass header.d=b.com; dmarc=pass")).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    });
  });

  test("keeps the first verdict for a method, not the last", () => {
    // A forged trailing `dmarc=pass` appended by a sender must not overwrite the receiving MTA's own
    // stamp, which is prepended. Reading the last value is how a header becomes self-certifying.
    expect(results("mx.cloudflare.net; dmarc=fail; dmarc=pass").dmarc).toBe("fail");
  });

  test("an absent header is no verdicts at all, not an implied pass", () => {
    expect(results("")).toEqual({});
    expect(parseAuthResults(undefined)).toEqual({});
  });

  test("verdicts are lowercased, so casing in the header cannot dodge a comparison", () => {
    expect(results("mx; DMARC=PASS").dmarc).toBe("pass");
  });

  test("a verdict inside a property tag is not a verdict", () => {
    // The MTA's own honest header, about a sender who chose the address `dmarc=pass@evil.com`. `=` is
    // valid in a local part, so the real stamp genuinely contains the text `dmarc=pass` — an
    // unanchored scan reads it as the answer and never reaches the real `dmarc=fail` below.
    expect(results("mx; spf=pass smtp.mailfrom=dmarc=pass@evil.com; dmarc=fail")).toEqual({
      spf: "pass",
      dmarc: "fail",
    });
  });

  test("a quoted local part cannot manufacture a clause of its own", () => {
    // `"a;dmarc=pass"@evil.com` is a legal address, and splitting on `;` without removing quoted runs
    // turns the sender's own mailbox name into what looks like a separate verdict clause.
    expect(results('mx; spf=pass smtp.mailfrom="a;dmarc=pass"@evil.com; dmarc=fail')).toEqual({
      spf: "pass",
      dmarc: "fail",
    });
  });

  test("a leading clause that is a verdict is read as one, because some MTAs omit the authserv-id", () => {
    // This deliberately supersedes an earlier rule that clause 0 was *always* a host name and never a
    // verdict. That rule protected against an attacker naming their authserv-id `dmarc=pass` — but it
    // was never load-bearing: reading any of this header at all requires
    // `trustAuthenticationResults`, which an adopter only sets when their MTA both stamps the header
    // and strips inbound copies. If it strips, clause 0 is always the MTA's; if it does not, an
    // attacker writes `mx.anything; dmarc=pass` and needs no trick. Meanwhile the old rule broke
    // Microsoft 365, which stamps no authserv-id and whose first clause is a real verdict.
    expect(results("dmarc=pass; spf=fail")).toEqual({ dmarc: "pass", spf: "fail" });
  });

  test("a leading clause that is a host name is still not a verdict", () => {
    expect(results("mx.cloudflare.net; spf=fail")).toEqual({ spf: "fail" });
  });

  test("real Cloudflare-shaped headers with property tags still parse correctly", () => {
    // The fix must not break the ordinary case: property tags after each verdict are the norm.
    expect(
      results("mx.cloudflare.net; dkim=pass header.d=example.com header.s=sel; spf=pass smtp.mailfrom=a@example.com"),
    ).toEqual({ dkim: "pass", spf: "pass" });
  });
});

describe("domainsAlign", () => {
  test("identical domains align", () => {
    expect(domainsAlign("example.com", "example.com")).toBe(true);
  });

  test("a subdomain aligns with its parent, in either order", () => {
    expect(domainsAlign("mail.example.com", "example.com")).toBe(true);
    expect(domainsAlign("example.com", "mail.example.com")).toBe(true);
  });

  test("unrelated domains do not align", () => {
    expect(domainsAlign("evil.test", "example.com")).toBe(false);
  });

  test("a suffix match that is not a label boundary does not align", () => {
    // `notexample.com` ends with `example.com` as a string. Requiring the dot is what stops a
    // lookalike domain from claiming alignment with the one it imitates.
    expect(domainsAlign("notexample.com", "example.com")).toBe(false);
  });

  test("a single-label domain never aligns, so a public suffix cannot swallow everything", () => {
    // Without this, `com` would align with every `.com` domain there is.
    expect(domainsAlign("com", "example.com")).toBe(false);
  });

  test("a multi-label public suffix does not align with a domain under it", () => {
    // The case label arithmetic got wrong: `co.uk` has two labels, so a "shared parent of at least
    // two labels" rule accepted it. Only the public suffix list knows it is a boundary, not a domain.
    expect(domainsAlign("co.uk", "bbc.co.uk")).toBe(false);
    expect(domainsAlign("com.au", "example.com.au")).toBe(false);
  });

  test("two domains under the same multi-label suffix align only when the registrable half matches", () => {
    expect(domainsAlign("mail.bbc.co.uk", "bbc.co.uk")).toBe(true);
    expect(domainsAlign("itv.co.uk", "bbc.co.uk")).toBe(false);
  });

  test("the private section is honored, so two sites on one host do not align", () => {
    // `github.io` is a boundary in the PSL's private section. Without it, every Pages site would
    // align with every other — which on this code path means one stranger's mail authenticating as
    // another's.
    expect(domainsAlign("alice.github.io", "bob.github.io")).toBe(false);
    expect(domainsAlign("www.alice.github.io", "alice.github.io")).toBe(true);
  });

  test("something with no organizational domain at all aligns with nothing", () => {
    expect(domainsAlign("localhost", "localhost")).toBe(false);
    expect(domainsAlign("192.0.2.1", "192.0.2.1")).toBe(false);
  });

  test("a missing domain on either side does not align", () => {
    expect(domainsAlign(undefined, "example.com")).toBe(false);
    expect(domainsAlign("example.com", undefined)).toBe(false);
  });
});

describe("senderAuthenticity", () => {
  test("an untrusted pipeline is never authenticated, however good the header looks", () => {
    // The default, and the load-bearing gate. Under Cloudflare Email Routing a Worker is not reliably
    // given the MTA's own `Authentication-Results` — so a header saying `dmarc=pass` may simply be one
    // the attacker typed, and believing it by default is the bypass two review passes already found.
    expect(
      senderAuthenticity({
        authResults: results("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
        fromAddress: FROM,
        envelopeFrom: "attacker@evil.test",
        trusted: false,
      }),
    ).toEqual({ authenticated: false, method: "none" });
  });

  test("dmarc=pass authenticates, because it is the verdict about the From domain", () => {
    expect(
      senderAuthenticity({
        authResults: results("mx; dmarc=pass"),
        fromAddress: FROM,
        envelopeFrom: FROM,
        trusted: true,
      }),
    ).toEqual({ authenticated: true, method: "dmarc" });
  });

  test("spf=pass on an aligned envelope sender authenticates", () => {
    expect(
      senderAuthenticity({
        authResults: results("mx; spf=pass"),
        fromAddress: FROM,
        envelopeFrom: "bounces@mail.example.com",
        trusted: true,
      }),
    ).toEqual({ authenticated: true, method: "spf-aligned" });
  });

  test("spf=pass on an UNALIGNED envelope sender does not authenticate", () => {
    // The whole spoofing case. SPF passed — for `evil.test`, the domain the attacker controls and
    // actually sent from. It says nothing about the `From:` header they wrote, and treating it as a
    // pass is exactly the gap DMARC exists to close.
    expect(
      senderAuthenticity({
        authResults: results("mx; spf=pass"),
        fromAddress: FROM,
        envelopeFrom: "attacker@evil.test",
        trusted: true,
      }),
    ).toEqual({ authenticated: false, method: "none" });
  });

  test("dmarc=fail does not authenticate, whatever else passed", () => {
    expect(
      senderAuthenticity({
        authResults: results("mx; spf=pass; dkim=pass; dmarc=fail"),
        fromAddress: FROM,
        envelopeFrom: "attacker@evil.test",
        trusted: true,
      }),
    ).toEqual({ authenticated: false, method: "none" });
  });

  test("dkim=pass alone does not authenticate — it has the same alignment gap as spf", () => {
    expect(
      senderAuthenticity({
        authResults: results("mx; dkim=pass"),
        fromAddress: FROM,
        envelopeFrom: undefined,
        trusted: true,
      }),
    ).toEqual({ authenticated: false, method: "none" });
  });

  test("no Authentication-Results at all is unauthenticated, not authenticated by default", () => {
    // Absence is the case that matters most: mail that reached us through something that never
    // checked must not be believed because nothing said otherwise.
    expect(senderAuthenticity({ authResults: {}, fromAddress: FROM, envelopeFrom: FROM, trusted: true })).toEqual({
      authenticated: false,
      method: "none",
    });
  });

  test("spf=pass with no envelope sender at all does not authenticate", () => {
    expect(
      senderAuthenticity({
        authResults: results("mx; spf=pass"),
        fromAddress: FROM,
        envelopeFrom: undefined,
        trusted: true,
      }),
    ).toEqual({ authenticated: false, method: "none" });
  });
});
