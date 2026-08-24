import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useEffect, useState } from "react";

// Your screen. Pithy wrote this file once and never will again — everything under src/routes/app/ is
// yours. Add a screen by dropping a file in beside it with its own `path` export.
export const path = "/";

/** What the health route answers. Every Pithy worker serves it. */
interface Health {
  status: string;
}

function isHealth(value: unknown): value is Health {
  return typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "string";
}

/**
 * This screen's English, baked in. Yours, like the rest of the file.
 *
 * The three statuses are keys rather than the strings themselves, because two of them are this screen's
 * own words and not the worker's: `checking` is what it says before the answer arrives, and `unknown`
 * and `unreachable` are what it says when there is no answer to render. What the worker actually
 * returns — `ok` — is its value and is shown verbatim.
 */
const EN = {
  "app/home.bare.title": "It runs.",
  "app/home.bare.body": "The worker says: {status}.",
  "app/home.bare.checking": "checking",
  "app/home.bare.unknown": "unknown",
  "app/home.bare.unreachable": "unreachable",
} satisfies MessageCatalog;

/**
 * What the health check came back with: the worker's own word, or one of this screen's two faults.
 *
 * A union rather than a rendered string, because only one of the three is translatable. `ok` is the
 * worker's value and is shown verbatim in every language; `unknown` and `unreachable` are this
 * screen's own words and come from the catalog. Storing the *rendered* sentence would mean the effect
 * had to hold a translator, which is what made it re-run on every language change.
 */
type Said = { reported: string } | { fault: "unknown" | "unreachable" } | null;

/** The word to show: the worker's own, or this screen's for a fault, or its word for still waiting. */
function said(t: Translator, health: Said): string {
  if (health === null) return t.t("app/home.bare.checking");
  return "reported" in health ? health.reported : t.t(`app/home.bare.${health.fault}`);
}

export default function Home() {
  const t = useTranslator(EN);
  const [status, setStatus] = useState<Said>(null);

  useEffect(() => {
    let live = true;
    // Same origin. The SPA and the worker are one deploy on one origin, so paths are relative and
    // there is no CORS config and no API origin variable — in dev or in production.
    //
    // **No cookie mode, and that is the whole of the request's security story.** The health route is
    // public: it reads nothing about you, so there is no session to send it, and this is the one screen
    // a project with no auth composed still gets. Every request that *does* carry a session goes through
    // `@pithy-sh/auth/src/client/api` instead — which is not importable from here, and does not need to
    // be, because a request with no ambient credential on it is not the rule that primitive exists to
    // own (#370).
    //
    // **`HEALTH_PATH`, not a string.** The worker mounts this route from that same constant. A copy
    // here would go stale the day it moves and render "The worker says: unknown." — a 200, no error,
    // nothing in a log (#400). It is yours to change; changing it to a literal is the way to lose that.
    fetch(HEALTH_PATH)
      .then((response) => response.json())
      .then((body: unknown) => {
        if (live) setStatus(isHealth(body) ? { reported: body.status } : { fault: "unknown" });
      })
      .catch(() => {
        if (live) setStatus({ fault: "unreachable" });
      });
    return () => {
      live = false;
    };
    // **No dependencies, because this asks the worker once per mount and the words are not part of
    // asking.** `t` was listed here, on the reasoning that it is stable for the life of the screen. It
    // is not: `useTranslator` memoizes on the provider value, and the provider mounts once the locale's
    // catalog has loaded — so `t` changes identity on that transition and the health check fired twice
    // on every mount, and again on every language change. The raw state is stored and translated at
    // render instead, which is where a language change belongs anyway.
  }, []);

  return (
    <main className="screen">
      <h1>{t.t("app/home.bare.title")}</h1>
      <p className="muted">{t.t("app/home.bare.body", { status: said(t, status) })}</p>
    </main>
  );
}
