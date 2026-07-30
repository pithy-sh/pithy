// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { dashboardListUrl, dashboardUrl } from "./dashboard";

/**
 * Every expectation here mirrors a URL checked against a live Cloudflare dashboard. Treat a change
 * to one of these strings as a claim that the console's routing changed — re-verify before editing.
 */
describe("dashboardUrl — id-addressed resources", () => {
  const acct = "acct-123";

  test("worker links to the services view", () => {
    expect(dashboardUrl("worker", acct, "app-leed-staging")).toBe(
      "https://dash.cloudflare.com/acct-123/workers/services/view/app-leed-staging/production",
    );
  });

  test("d1 links to the database's metrics tab", () => {
    expect(dashboardUrl("d1", acct, "20e45c86-9efa-429e-a5b8-184c4f39fa92")).toBe(
      "https://dash.cloudflare.com/acct-123/workers/d1/databases/20e45c86-9efa-429e-a5b8-184c4f39fa92/metrics",
    );
  });

  test("kv links to the namespace's metrics tab", () => {
    expect(dashboardUrl("kv", acct, "60c3350cfdbf41719d554d2a23ca36e5")).toBe(
      "https://dash.cloudflare.com/acct-123/workers/kv/namespaces/60c3350cfdbf41719d554d2a23ca36e5/metrics",
    );
  });

  test("r2 links to the bucket", () => {
    expect(dashboardUrl("r2", acct, "cms-production")).toBe(
      "https://dash.cloudflare.com/acct-123/r2/default/buckets/cms-production",
    );
  });

  test("vectorize links to the index", () => {
    expect(dashboardUrl("vectorize", acct, "dev-site")).toBe(
      "https://dash.cloudflare.com/acct-123/ai/vectorize/dev-site",
    );
  });

  test("workflow links to the workflow's instances", () => {
    expect(dashboardUrl("workflow", acct, "publish-workflow-staging")).toBe(
      "https://dash.cloudflare.com/acct-123/workers/workflows/publish-workflow-staging/instances",
    );
  });

  test("durable_object links by its namespace id — not its class name", () => {
    // The dashboard addresses a DO by the hex namespace id Cloudflare assigns. Callers holding only
    // a class name (everything reading wrangler.jsonc) must not build this link.
    expect(dashboardUrl("durable_object", acct, "694bbd324b624018b979aa648e5fe456")).toBe(
      "https://dash.cloudflare.com/acct-123/workers/durable-objects/view/694bbd324b624018b979aa648e5fe456/overview",
    );
  });

  test("queue links to the queue's metrics tab, by queue id", () => {
    // The dashboard addresses a queue by id; a producer binding declares the queue *name*.
    expect(dashboardUrl("queue", acct, "fcdd1f6b6e2d4c9da1ec3dfe6409126e")).toBe(
      "https://dash.cloudflare.com/acct-123/workers/queues/fcdd1f6b6e2d4c9da1ec3dfe6409126e/metrics",
    );
  });

  test("secret links to the Secrets Store, by store id", () => {
    expect(dashboardUrl("secret", acct, "5e2859b61038475e8230d42939705639")).toBe(
      "https://dash.cloudflare.com/acct-123/secrets-store/5e2859b61038475e8230d42939705639",
    );
  });

  test("turnstile links to the widget, by sitekey", () => {
    expect(dashboardUrl("turnstile", acct, "0x4AAAAAAAUFmjWXn61y2CIO")).toBe(
      "https://dash.cloudflare.com/acct-123/turnstile/widget/0x4AAAAAAAUFmjWXn61y2CIO",
    );
  });

  test("an id-addressed kind with no id has nothing to point at", () => {
    expect(dashboardUrl("d1", acct, "")).toBeNull();
    expect(dashboardUrl("worker", acct, "")).toBeNull();
    expect(dashboardUrl("durable_object", acct, "")).toBeNull();
    expect(dashboardUrl("queue", acct, "")).toBeNull();
  });
});

describe("dashboardUrl — account-level products", () => {
  const acct = "acct-123";

  test("ai, images, stream, and email link to their product pages, ignoring any id", () => {
    expect(dashboardUrl("ai", acct, "")).toBe("https://dash.cloudflare.com/acct-123/ai/workers-ai/usage");
    expect(dashboardUrl("images", acct, "")).toBe("https://dash.cloudflare.com/acct-123/images/hosted");
    expect(dashboardUrl("stream", acct, "")).toBe("https://dash.cloudflare.com/acct-123/stream/videos");
    expect(dashboardUrl("email", acct, "")).toBe("https://dash.cloudflare.com/acct-123/email-service/sending");
    // The id is not part of the route — passing one changes nothing.
    expect(dashboardUrl("ai", acct, "ignored")).toBe("https://dash.cloudflare.com/acct-123/ai/workers-ai/usage");
  });
});

describe("dashboardListUrl — the fallback for ids a project cannot know", () => {
  const acct = "acct-123";

  test("durable objects and queues fall back to their product list", () => {
    // A DO namespace id is assigned when a Worker exporting the class deploys; a queue id when the queue
    // is created. Neither is written back into wrangler.jsonc, so the list is the honest destination.
    expect(dashboardListUrl("durable_object", acct)).toBe(
      "https://dash.cloudflare.com/acct-123/workers/durable-objects",
    );
    expect(dashboardListUrl("queue", acct)).toBe("https://dash.cloudflare.com/acct-123/workers/queues");
  });

  test("a kind whose id IS knowable has no list fallback — it links straight at the resource", () => {
    for (const kind of ["d1", "kv", "r2", "worker", "vectorize", "workflow", "secret", "turnstile"]) {
      expect(dashboardListUrl(kind, acct)).toBeNull();
    }
  });
});

describe("dashboardUrl — kinds with no page", () => {
  test("ratelimit has no dashboard page at all, and service is not a resource", () => {
    // Workers Rate Limiting has no console page. A service binding is RPC to another Worker — its
    // page is that Worker's, reached by resolving the target script name and asking for `worker`.
    expect(dashboardUrl("ratelimit", "acct-123", "whatever")).toBeNull();
    expect(dashboardUrl("service", "acct-123", "collab")).toBeNull();
  });

  test("an unrecognized kind gets no link, never a guess", () => {
    expect(dashboardUrl("nonsense", "acct-123", "whatever")).toBeNull();
  });
});
