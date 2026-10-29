import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import {
  acceptInvitation,
  chooseOrganization,
  type InvitationOffer,
  readInvitation,
} from "@pithy-sh/organization/src/client/api";
import { organizationRefusal } from "@pithy-sh/organization/src/client/lifecycle";
import { useAction } from "@pithy-sh/ui-core/src/action";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { type ScreenProps, screenPath } from "@pithy-sh/ui-core/src/routes";
import { useState } from "react";
import { Redirect, routeTable } from "../../router";
import { getSession, RESUME_PARAM } from "../../session";
import "../../pithy-screens.css";

/**
 * Where an invitation link lands. Change this if `organization({ invitationAcceptPath })` does: the link in every
 * invitation email is that path with the token appended as one segment.
 */
export const path = "/invitations/:token";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **Anybody holding the link sees the offer; only the invited address can take it.** Reading an offer is public, so
// a stranger sees what they were invited to before being asked to sign in, and comes back here once they have.
// Accepting is checked by the server against the signed-in address, so a forwarded link does nothing for whoever it
// was forwarded to.
//
// **One refusal, one sentence.** An unknown link, a spent one, a withdrawn one, an expired one and one sent to a
// different address all come back as the same code, on purpose: telling them apart tells whoever holds the link the
// same thing. The screen says all of it at once rather than guessing which.
//
// **Joining does not change the account in force.** The server writes the membership and stops. This screen then
// makes the account you joined the one you act in, and leaves by a document load for the chooser's reason: nothing
// the previous account's data put on the page may survive the switch.
const EN = {
  "organization/invitation.title": "Join {organization}",
  "organization/invitation.invited_by": "{inviter} invited you as {role}.",
  "organization/invitation.invited": "You're invited as {role}.",
  "organization/invitation.expires": "The invitation expires on {date}.",
  "organization/invitation.as": "You'll join as {email}.",
  "organization/invitation.accept": "Join",
  "organization/invitation.sign_in": "Sign in to accept",
  "organization/invitation.invalid.title": "This invitation can't be used.",
  "organization/invitation.invalid.body":
    "It has expired, been used or withdrawn, or was sent to a different address. Ask whoever invited you for a new one.",
  "organization/invitation.failed": "We couldn't load this invitation.",
  "organization/invitation.join_failed": "We couldn't finish joining.",
  "organization/invitation.retry": "Try again",
} satisfies MessageCatalog;

/** Where to go once the account you joined is in force. The chooser's destination, for the chooser's reason. */
const DESTINATION = "/";

/** What arriving with a link comes to: the offer, a link that can no longer be used, or a read that failed. */
type Arrival =
  | { kind: "offer"; offer: InvitationOffer; email: string | null; signIn: string | null }
  | { kind: "invalid" }
  | { kind: "failed" };

/**
 * What pressing "Join" comes to. `joined` on a failure is the account already joined, so trying again records the
 * choice rather than spending an invitation that is already spent.
 */
type Joining =
  | { kind: "leave"; to: string; load: boolean }
  | { kind: "invalid" }
  | { kind: "failed"; joined: string | null };

const INVITATION_INVALID = "organization/invitation_invalid";

/** This screen's own address for `token`, which is where a sign-in comes back to. */
function ownPath(token: string): string {
  return path.replace(":token", encodeURIComponent(token));
}

async function arrive(token: string): Promise<Arrival> {
  const [offer, session] = await Promise.all([readInvitation(token), getSession()]);
  if (!offer.ok) return offer.failure.code === INVITATION_INVALID ? { kind: "invalid" } : { kind: "failed" };
  if (session !== null) return { kind: "offer", offer: offer.value, email: session.user.email, signIn: null };
  const resume = new URLSearchParams({ [RESUME_PARAM]: ownPath(token) });
  const signIn = `${screenPath(await routeTable(), "sign-in")}?${resume}`;
  return { kind: "offer", offer: offer.value, email: null, signIn };
}

/** Accept, unless that already happened, then make the account joined the one in force. */
async function join(token: string, joined: string | null): Promise<Joining> {
  let organizationId = joined;
  if (organizationId === null) {
    const accepted = await acceptInvitation(token);
    if (!accepted.ok) {
      return accepted.failure.code === INVITATION_INVALID ? { kind: "invalid" } : { kind: "failed", joined: null };
    }
    organizationId = accepted.value.organizationId;
  }
  const chosen = await chooseOrganization(organizationId);
  if (chosen.ok) return { kind: "leave", to: DESTINATION, load: true };
  if (organizationRefusal(chosen.failure.code) === "suspended") {
    return { kind: "leave", to: screenPath(await routeTable(), "organization-suspended"), load: false };
  }
  return { kind: "failed", joined: organizationId };
}

export default function Invitation({ params }: ScreenProps<typeof path>) {
  const t = useTranslator(EN);
  const token = params.token;
  const arrival = useRead(`invitation:${token}`, () => arrive(token));
  const joining = useAction((_signal: AbortSignal, joined: string | null) => join(token, joined));
  const [signingIn, setSigningIn] = useState(false);

  const answer = arrival.loading ? undefined : arrival.value;
  const result = joining.value;

  if (result?.kind === "leave") return <Redirect to={result.to} load={result.load} />;
  if (signingIn && answer?.kind === "offer" && answer.signIn !== null) return <Redirect to={answer.signIn} />;

  if (answer?.kind === "invalid" || result?.kind === "invalid") {
    return (
      <main className="screen">
        <div className="stack">
          <h1>{t.t("organization/invitation.invalid.title")}</h1>
          <p className="muted">{t.t("organization/invitation.invalid.body")}</p>
        </div>
      </main>
    );
  }

  if (result?.kind === "failed") {
    return (
      <main className="screen">
        <div className="stack">
          <p>{t.t("organization/invitation.join_failed")}</p>
          <button type="button" disabled={joining.pending} onClick={() => void joining.run(result.joined)}>
            {t.t("organization/invitation.retry")}
          </button>
        </div>
      </main>
    );
  }

  if (answer?.kind === "failed" || (answer === undefined && arrival.failure !== null && !arrival.loading)) {
    return (
      <main className="screen">
        <div className="stack">
          <p>{t.t("organization/invitation.failed")}</p>
          <button type="button" onClick={arrival.refresh}>
            {t.t("organization/invitation.retry")}
          </button>
        </div>
      </main>
    );
  }

  if (answer === undefined) return <main className="screen" />;
  const { offer, email } = answer;
  return (
    <main className="screen">
      <div className="stack">
        <h1>{t.t("organization/invitation.title", { organization: offer.organizationName })}</h1>
        <p className="muted">
          {offer.inviterName === null
            ? t.t("organization/invitation.invited", { role: offer.role })
            : t.t("organization/invitation.invited_by", { inviter: offer.inviterName, role: offer.role })}
        </p>
        <p className="muted">
          {t.t("organization/invitation.expires", {
            date: t.formatDate(new Date(offer.expiresAt), { dateStyle: "long" }),
          })}
        </p>
        {email === null ? (
          <button type="button" onClick={() => setSigningIn(true)}>
            {t.t("organization/invitation.sign_in")}
          </button>
        ) : (
          <>
            <p>{t.t("organization/invitation.as", { email })}</p>
            <button type="button" disabled={joining.pending} onClick={() => void joining.run(null)}>
              {t.t("organization/invitation.accept")}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
