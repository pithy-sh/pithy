import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import { Redirect, routeTable } from "../../router";
import { getSession, refusedAccountScreen, resumeTarget } from "../../session";
import "../../pithy-screens.css";

export const path = "/callback";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// `sign-in.tsx` builds the magic link's `callbackURL` from the `path` above, so renaming it moves both
// ends at once. The round trip is the one flow nobody already signed in can test, so it must not be two
// strings that only happen to agree.

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/callback.title": "Signing you in.",
  "auth/callback.body": "One moment.",
} satisfies MessageCatalog;

/**
 * Where this landing goes next.
 *
 * The session cookie is already set by the time anybody lands here — the server did the verifying — so this
 * asks who you are and moves on. Where "away" is comes from the route table, never a literal. A magic link the
 * Worker refused for the account's standing comes back carrying the code as `?error=`, and goes on to the screen
 * for that state. A sign-in an application's authorization sent somebody to resumes it, by a document load,
 * because the authorization endpoint is the Worker's rather than a screen in this app.
 */
async function landing(): Promise<{ to: string; load?: boolean }> {
  const [current, table] = await Promise.all([getSession(), routeTable()]);
  const refused = refusedAccountScreen(new URLSearchParams(window.location.search).get("error"));
  if (refused) return { to: screenPath(table, refused) };
  if (current === null) return { to: screenPath(table, "sign-in") };
  const resume = resumeTarget();
  return resume === null ? { to: "/" } : { to: resume, load: true };
}

export default function Callback() {
  const t = useTranslator(EN);
  const next = useRead("callback", landing).value;

  return (
    <main className="screen">
      <h1>{t.t("auth/callback.title")}</h1>
      <p className="muted">{t.t("auth/callback.body")}</p>
      {next ? <Redirect to={next.to} load={next.load} /> : null}
    </main>
  );
}
