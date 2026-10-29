import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import {
  type ActableOrganization,
  chooseOrganization,
  listOrganizations,
  organizationRefusal,
} from "@pithy-sh/organization/src/index";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import { useState } from "react";
import { Redirect, routeTable } from "../../router";
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
//     for an invitation, and a picker with an empty list tells them nothing. And somebody whose every
//     account is suspended does not belong nowhere: the list counts those, and they go on to the
//     suspended screen, by role, rather than being told to ask for an invitation.
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

/** What an arrival, or a choice, comes to: the picker, a failure, or somewhere to go. */
type Answer =
  | { kind: "list"; organizations: ActableOrganization[] }
  | { kind: "failed" }
  | { kind: "leave"; to: string; load: boolean };

/**
 * Record the choice, then leave by a document load. See the note above for why it is not an in-app route change.
 *
 * An account suspended since the list was drawn says so, on its own screen, by role. Nothing is in force then, so
 * an in-app navigation carries nothing over. Any other refusal — including the ordinary 404 a caller naming an
 * account they do not belong to gets, which is the same answer as one that does not exist — is a failure.
 */
async function choose(organizationId: string): Promise<Answer> {
  const result = await chooseOrganization(organizationId);
  if (result.ok) return { kind: "leave", to: DESTINATION, load: true };
  if (organizationRefusal(result.failure.code) === "suspended") {
    return { kind: "leave", to: screenPath(await routeTable(), "organization-suspended"), load: false };
  }
  return { kind: "failed" };
}

/** Read the memberships, and decide which of the three arrivals this is. */
async function arrive(): Promise<Answer> {
  const result = await listOrganizations();
  if (!result.ok) return { kind: "failed" };
  const { organizations, acting, suspended } = result.value;
  // Nothing to act in, and something suspended: that is the suspended screen's answer, not "no accounts yet".
  if (organizations.length === 0 && (suspended ?? 0) > 0) {
    return { kind: "leave", to: screenPath(await routeTable(), "organization-suspended"), load: false };
  }
  // Somebody with exactly one account is put into it rather than asked. The write still happens, so `acting` is a
  // row from here on and `chosen` says it was not a decision.
  const only = organizations.length === 1 && acting === null ? organizations[0] : undefined;
  if (only) return choose(only.id);
  return { kind: "list", organizations };
}

export default function ChooseOrganization() {
  const t = useTranslator(EN);
  // Once per arrival, StrictMode included: the one-membership path writes the choice.
  const arrival = useRead("organizations", arrive, { once: true });
  const [chosen, setChosen] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(organizationId: string): Promise<void> {
    setBusy(true);
    const answer = await choose(organizationId);
    setBusy(false);
    setChosen(answer);
  }

  function retry(): void {
    setChosen(null);
    arrival.refresh();
  }

  const answer = chosen ?? (arrival.loading ? null : (arrival.value ?? null));
  if (answer?.kind === "leave") return <Redirect to={answer.to} load={answer.load} />;

  if (answer?.kind === "failed" || (answer === null && arrival.failure !== null && !arrival.loading)) {
    return (
      <main className="screen">
        <div className="stack">
          <p>{t.t("organization/choose.failed")}</p>
          <button type="button" onClick={retry}>
            {t.t("organization/choose.retry")}
          </button>
        </div>
      </main>
    );
  }

  // The read has not answered. Nothing is drawn rather than a spinner: the one-membership path leaves
  // without ever rendering, and a flash of a picker for an account nobody chose is worse than a pause.
  if (answer === null) return <main className="screen" />;
  const organizations = answer.organizations;

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
              <button type="button" className="organization" disabled={busy} onClick={() => void pick(organization.id)}>
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
