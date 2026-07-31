// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Placeholder payloads — one valid input per template — for previewing a rendered email without real
 * data. `pithy email test` uses these to send a sample of any template through a project's config so a
 * user can see the result and confirm setup. Each satisfies its template's Zod payload schema.
 */
export const samplePayloads: Record<string, unknown> = {
  magicLink: { name: "Sam", url: "https://example.com/signin?token=demo", expiresMinutes: 15 },
  supportReply: {
    subject: "Re: I was charged twice this month",
    body: "Hi Sam,\n\nI have refunded the duplicate charge — it should be back on your card within three working days.\n\nSorry for the trouble.",
    agentName: "Alex",
  },
  otp: { name: "Sam", code: "123456", expiresMinutes: 10 },
  welcome: { name: "Sam", ctaUrl: "https://example.com/start", ctaLabel: "Open your dashboard" },
  securityAlert: {
    name: "Sam",
    event: "New sign-in from Chrome on macOS",
    when: "just now",
    ipAddress: "203.0.113.4",
    actionUrl: "https://example.com/activity",
  },
  invite: { inviterName: "Pat", organizationName: "Acme", acceptUrl: "https://example.com/accept" },
  passwordChanged: { name: "Sam", when: "just now", supportUrl: "https://example.com/support" },
  newsletter: {
    subject: "Sample newsletter",
    intro: "Here's what's new this week.",
    articles: [
      { title: "A first headline", summary: "A one-line summary of the first article.", link: "https://example.com/a" },
      {
        title: "A second headline",
        summary: "A one-line summary of the second article.",
        link: "https://example.com/b",
      },
    ],
    outro: "That's it for this week.",
  },
  leadCapture: { name: "Sam", assetName: "The 2026 Backend Playbook", assetUrl: "https://example.com/download" },
  marketingCampaign: {
    subject: "A sample campaign",
    heading: "Big news",
    body: "The body copy of a marketing campaign.",
    ctaUrl: "https://example.com/go",
    ctaLabel: "See what's new",
  },
};
