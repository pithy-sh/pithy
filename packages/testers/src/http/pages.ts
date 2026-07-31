// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The three HTML pages a tester sees.
 *
 * Separate from `routes.ts` because they are pure — a string in, a `Response` out, no database and no
 * config — and because that is what makes their contents assertable. The opt-out page in particular is
 * a security surface: it exists so that withdrawing takes a form submission rather than a link
 * following, and a test that proves it renders a form is worth more than a comment saying it should.
 *
 * Distinct from `view.ts`, which shapes the JSON a dashboard receives. Same layer, different audience.
 */

/**
 * Escape a value before it goes into the HTML these routes render.
 *
 * The store URL is developer-supplied and already host-allowlisted, so this is defence in depth rather
 * than the only guard — but it is a URL interpolated into an `href` on a page shown to a stranger, and
 * "already validated elsewhere" is how injection survives a refactor.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;line-height:1.55"><h1 style="font-size:1.4rem;font-weight:600;margin:0 0 .75rem">${title}</h1><p style="margin:0;color:#555">${body}</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/**
 * The page that hands a tester the store's own opt-in link.
 *
 * The two lines of guidance are not padding. Opening the link in the store app rather than a browser,
 * and signing in with a different account than the one invited, are the two failures that produce
 * `App not available` — the single most common way a closed test goes wrong for a tester who did
 * everything they were asked.
 */
export function storePage(url: string, platform: "android" | "ios"): Response {
  const store = platform === "ios" ? "TestFlight" : "Google Play";
  const safeUrl = escapeHtml(url);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join the test</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;line-height:1.55"><h1 style="font-size:1.4rem;font-weight:600;margin:0 0 .75rem">One more step.</h1><p style="margin:0 0 1.5rem;color:#555">Open ${escapeHtml(store)} to join the test and install the app.</p><p style="margin:0 0 1.75rem"><a href="${safeUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600">Join on ${escapeHtml(store)}</a></p><p style="margin:0 0 .5rem;color:#555;font-size:.925rem">Two things worth knowing, because they are what usually goes wrong:</p><ul style="margin:0 0 1.5rem;padding-left:1.15rem;color:#555;font-size:.925rem"><li style="margin-bottom:.4rem">Open it in a browser, not inside the ${escapeHtml(store)} app.</li><li>Sign in with the same address this email reached you at. A different account cannot join.</li></ul><p style="margin:0;color:#888;font-size:.85rem;word-break:break-all">If the button does not work: ${safeUrl}</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/**
 * The page that asks a tester to confirm they meant to withdraw.
 *
 * A form rather than a link, because the whole point is that following it requires an actor who
 * submits forms. A mail client prefetching the URL renders this and changes nothing.
 */
export function confirmOptOutPage(action: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leave the test?</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;line-height:1.55"><h1 style="font-size:1.4rem;font-weight:600;margin:0 0 .75rem">Leave the test?</h1><p style="margin:0 0 1.5rem;color:#555">You will not be contacted about it again. If you meant to do this, confirm below.</p><form method="post" action="${escapeHtml(action)}"><button type="submit" style="background:#111;color:#fff;border:0;padding:13px 26px;border-radius:8px;font-weight:600;font-size:1rem;cursor:pointer">Yes, take me off</button></form><p style="margin:1.5rem 0 0;color:#888;font-size:.85rem">Close this page to stay on the test.</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
