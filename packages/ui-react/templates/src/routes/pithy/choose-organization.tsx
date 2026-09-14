import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { type ActableOrganization, chooseOrganization, listOrganizations } from "@pithy-sh/organization/src/index";
import { useCallback, useEffect, useState } from "react";
import "../../pithy-screens.css";

export const path = "/choose-organization";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **Three arrivals, one screen, and getting them wrong is the whole reason this ships rather than being
// left to every adopter.**
//
//   Several memberships — draw the picker. This is the case people picture.
//   Exactly one — go straight through without asking, *and still record the choice*, so what is in force
//     is a row rather than an inference every later request has to make again.
//   None — a different answer entirely. Somebody who belongs nowhere is not choosing; they are waiting
//     for an invitation, and a picker with an empty list tells them nothing.
//
// The middle one is the one that gets written wrong. A screen that renders a one-item list and waits is
// asking somebody to confirm a decision that was never theirs; a screen that redirects without writing
// leaves every subsequent request resolving the same membership over again.
//
// **Leaving is a document load, not a route change.** What is in force decides what every request may
// reach, and an in-app navigation keeps whatever the previous account's data had already populated —
// a roster, a header, a cached list — while the session underneath now answers for somebody else. The
// reload is the cheap way to be sure none of it survives.
const EN = {
  "organization/choose.title": "Choose an account",
  "organization/choose.subtitle": "You belong to more than one.",
  "organization/choose.role": "You are {role} here.",
  "organization/choose.empty.title": "No accounts yet",
  "organization/choose.empty.body": "You are not a member of any account. Ask somebody to invite you.",
  "organization/choose.failed": "We couldn't load your accounts.",
  "organization/choose.retry": "Try again",
} satisfies MessageCatalog;

/**
 * Where to go once something is in force.
 *
 * The app's root, and deliberately not a `ScreenRole`. The roles exist for screens a *guard* sends
 * somebody to — sign-in, paywall, subscription — and nothing guards its way here: the chooser is
 * arrived at, not redirected to. An adopter whose home is elsewhere changes this line, which is the one
 * edit a copied screen is for.
 */
const DESTINATION = "/";

export default function ChooseOrganization() {
  const t = useTranslator(EN);
  const [organizations, setOrganizations] = useState<ActableOrganization[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Record the choice, then leave by a document load. See the note above for why it is not `navigate`. */
  const choose = useCallback(async (organizationId: string) => {
    setBusy(true);
    const result = await chooseOrganization(organizationId);
    if (!result.ok) {
      // Including the ordinary 404 a caller naming an account they do not belong to gets — which is
      // the same answer as one that does not exist, deliberately, so there is nothing to say about
      // which it was.
      setBusy(false);
      setFailed(true);
      return;
    }
    window.location.assign(DESTINATION);
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    const result = await listOrganizations();
    if (!result.ok) {
      setFailed(true);
      return;
    }
    // Somebody with exactly one account is put into it rather than asked. The write still happens, so
    // `acting` is a row from here on and `chosen` says it was not a decision.
    if (result.value.organizations.length === 1 && result.value.acting === null) {
      const only = result.value.organizations[0];
      if (only) {
        await choose(only.id);
        return;
      }
    }
    setOrganizations(result.value.organizations);
  }, [choose]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <main className="screen">
        <div className="stack">
          <p>{t.t("organization/choose.failed")}</p>
          <button type="button" onClick={() => void load()}>
            {t.t("organization/choose.retry")}
          </button>
        </div>
      </main>
    );
  }

  // The load has not answered. Nothing is drawn rather than a spinner: the one-membership path leaves
  // without ever rendering, and a flash of a picker for an account nobody chose is worse than a pause.
  if (organizations === null) return <main className="screen" />;

  if (organizations.length === 0) {
    return (
      <main className="screen">
        <div className="stack">
          <h1>{t.t("organization/choose.empty.title")}</h1>
          <p className="muted">{t.t("organization/choose.empty.body")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="stack">
        <h1>{t.t("organization/choose.title")}</h1>
        <p className="muted">{t.t("organization/choose.subtitle")}</p>
        <ul className="organizations">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <button
                type="button"
                className="organization"
                disabled={busy}
                onClick={() => void choose(organization.id)}
              >
                {/* A raster arrives as a URL on this origin and a vector as its own value; both render
                    the same way, which is why no screen has to know which it was handed. Null draws
                    initials, which is an answer rather than a placeholder. */}
                {organization.mark === null ? (
                  <span className="organization__mark" aria-hidden="true">
                    {organization.name.slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  <img className="organization__mark" src={organization.mark} alt="" />
                )}
                <span className="organization__name">{organization.name}</span>
                <span className="muted">{t.t("organization/choose.role", { role: organization.role })}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
