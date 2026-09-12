// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { OrganizationConfig } from "../config/config";
import {
  type EnqueueInvitation,
  INVITATION_ACCEPT_SEGMENT,
  INVITATION_TEMPLATE,
  type InvitationMail,
  invitationAcceptUrl,
  renderInvitationMail,
  sendInvitationMail,
} from "./invitation";

/**
 * The invitation mail: the link it carries, the words it says, and the one value in it that somebody
 * else chose.
 */

/** The config a composed project has, with the defaults the schema supplies. */
const config = OrganizationConfig.parse({ baseUrl: "https://app.example.com" });

/** A name a tenant could genuinely set, and a name that is an attack. */
const HOSTILE = `<img src=x onerror="alert(1)"> & "Acme" 'Ltd'`;

const mail: InvitationMail = {
  to: "ada@example.com",
  organizationName: "Acme",
  inviterName: "Grace",
  acceptUrl: "https://app.example.com/organizations/invitations/abc",
};

describe("invitationAcceptUrl", () => {
  test("is absolute, and puts the token in the path", () => {
    expect(invitationAcceptUrl(config, "abc123")).toBe(
      `https://app.example.com/organizations/${INVITATION_ACCEPT_SEGMENT}/abc123`,
    );
  });

  test("honors a project's own basePath", () => {
    const moved = OrganizationConfig.parse({ baseUrl: "https://app.example.com", basePath: "/teams" });
    expect(invitationAcceptUrl(moved, "abc123")).toBe(`https://app.example.com/teams/invitations/abc123`);
  });

  test("does not double the slash when the origin carries one", () => {
    const trailing = OrganizationConfig.parse({ baseUrl: "https://app.example.com/" });
    expect(invitationAcceptUrl(trailing, "abc123")).toBe("https://app.example.com/organizations/invitations/abc123");
  });

  test("escapes the token into the path segment", () => {
    // Nothing a minted token contains needs this. It is here for the day the token's alphabet changes,
    // because that is the day a link stops being a link.
    expect(invitationAcceptUrl(config, "a/b?c#d")).toBe(
      "https://app.example.com/organizations/invitations/a%2Fb%3Fc%23d",
    );
  });

  test("refuses, by name, when the project declared no origin", () => {
    const originless = OrganizationConfig.parse({});
    let thrown: PithyError | undefined;
    try {
      invitationAcceptUrl(originless, "abc123");
    } catch (error) {
      thrown = error as PithyError;
    }
    expect(thrown?.payload.action).toContain("baseUrl");
    expect(thrown?.payload.detail).toContain("baseUrl");
  });
});

describe("sendInvitationMail", () => {
  test("enqueues the kit's invite template with the three facts", async () => {
    const sent: Parameters<EnqueueInvitation>[0][] = [];
    const enqueue: EnqueueInvitation = async (input) => {
      sent.push(input);
      return { jobId: "job-1", status: "queued" };
    };

    const result = await sendInvitationMail(enqueue, mail);

    expect(result).toEqual({ jobId: "job-1", status: "queued" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.template).toBe(INVITATION_TEMPLATE);
    expect(sent[0]?.to).toBe("ada@example.com");
    expect(sent[0]?.payload).toEqual({
      inviterName: "Grace",
      organizationName: "Acme",
      acceptUrl: mail.acceptUrl,
    });
  });

  test("omits the locale rather than asserting one the recipient never chose", async () => {
    const sent: Parameters<EnqueueInvitation>[0][] = [];
    const enqueue: EnqueueInvitation = async (input) => {
      sent.push(input);
      return { jobId: "job-1", status: "queued" };
    };

    await sendInvitationMail(enqueue, mail, null);
    expect("locale" in (sent[0] ?? {})).toBe(false);

    await sendInvitationMail(enqueue, mail, "fr");
    expect(sent[1]?.locale).toBe("fr");
  });

  test("hands back what the enqueue said, suppression included", async () => {
    const enqueue: EnqueueInvitation = async () => ({ jobId: "job-2", status: "suppressed" });
    // A caller that read only the id would audit a mail that never left.
    expect(await sendInvitationMail(enqueue, mail)).toEqual({ jobId: "job-2", status: "suppressed" });
  });

  test("does not send anything itself", async () => {
    // The seam is the whole delivery path. A module that could send would be a second one, without the
    // send Workflow, the suppression list or the job history.
    let called = 0;
    const enqueue: EnqueueInvitation = async () => {
      called += 1;
      return { jobId: "job-3", status: "queued" };
    };
    await sendInvitationMail(enqueue, mail);
    expect(called).toBe(1);
  });
});

describe("renderInvitationMail", () => {
  test("names the inviter, the organization, and carries the link in both bodies", () => {
    const written = renderInvitationMail(mail);

    expect(written.subject).toBe("Grace invited you to Acme");
    expect(written.text).toContain("Grace invited you to join Acme.");
    expect(written.text).toContain(mail.acceptUrl);
    expect(written.html).toContain("Grace invited you to join Acme.");
    expect(written.html).toContain(`href="${mail.acceptUrl}"`);
  });

  test("puts the link on its own line in the text part", () => {
    // So a terminal client makes it clickable, and so a wrap does not eat half a token.
    const written = renderInvitationMail(mail);
    expect(written.text.split("\n").some((line) => line === `Accept: ${mail.acceptUrl}`)).toBe(true);
  });

  test("escapes an organization name that is markup", () => {
    const written = renderInvitationMail({ ...mail, organizationName: HOSTILE });

    // The name is tenant text on a page somebody else reads. Unescaped, it is markup in a colleague's
    // inbox sent over the adopter's own sending domain.
    expect(written.html).not.toContain("<img");
    // The quote is the half that matters: `onerror=&quot;` is text, `onerror="` is a handler.
    expect(written.html).not.toContain('onerror="');
    expect(written.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Escaped once, not twice: the ampersand pass runs first, so `&lt;` does not arrive as `&amp;lt;`.
    expect(written.html).not.toContain("&amp;lt;");
    expect(written.html).toContain("&amp; &quot;Acme&quot; &#39;Ltd&#39;");
  });

  test("escapes an inviter name that is markup", () => {
    const written = renderInvitationMail({ ...mail, inviterName: HOSTILE });
    expect(written.html).not.toContain("<img");
    expect(written.html).not.toContain('onerror="');
  });

  test("escapes the accept URL into the href, so nothing can close the attribute", () => {
    const written = renderInvitationMail({
      ...mail,
      acceptUrl: `https://app.example.com/x?a=1&b=2" onmouseover="alert(1)`,
    });
    expect(written.html).not.toContain('onmouseover="');
    expect(written.html).toContain("&quot; onmouseover=&quot;alert(1)");
    expect(written.html).toContain("&amp;b=2");
  });

  test("leaves the plain-text part as typed, because it is not markup", () => {
    // Escaping there would show a reader `&lt;` and call it a name.
    const written = renderInvitationMail({ ...mail, organizationName: HOSTILE });
    expect(written.text).toContain(HOSTILE);
    expect(written.subject).toContain(HOSTILE);
  });

  test("says what the kit's invite template says", () => {
    // Two paths, one wording. A project that later composes email does not find its invitations
    // rephrased — the strings here are the `email/invite.*` catalog entries, to the letter.
    const written = renderInvitationMail(mail);
    expect(written.subject).toBe("Grace invited you to Acme");
    expect(written.text.startsWith("Grace invited you to join Acme.")).toBe(true);
    expect(written.html).toContain("Accept invitation");
  });
});
