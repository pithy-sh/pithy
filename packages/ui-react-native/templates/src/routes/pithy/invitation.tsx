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
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { queryString } from "../../platform";
import { Redirect, routeTable } from "../../router";
import { getSession, RESUME_PARAM } from "../../session";
import { type Theme, useTheme } from "../../theme";
import { transport } from "../../transport";

/**
 * Where an invitation link lands. Change this if `organization({ invitationAcceptPath })` does: the link in every
 * invitation email is that path with the token appended as one segment. On a phone the link reaches this screen
 * when the app answers it as a universal link or an app link.
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
// makes the account you joined the one you act in, and leaves remounting every screen, for the chooser's reason:
// nothing the previous account's data put on a screen may survive the switch.
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
  const [offer, session] = await Promise.all([readInvitation(token, transport.organization), getSession()]);
  if (!offer.ok) return offer.failure.code === INVITATION_INVALID ? { kind: "invalid" } : { kind: "failed" };
  if (session !== null) return { kind: "offer", offer: offer.value, email: session.user.email, signIn: null };
  const signIn = `${screenPath(await routeTable(), "sign-in")}${queryString({ [RESUME_PARAM]: ownPath(token) })}`;
  return { kind: "offer", offer: offer.value, email: null, signIn };
}

/** Accept, unless that already happened, then make the account joined the one in force. */
async function join(token: string, joined: string | null): Promise<Joining> {
  let organizationId = joined;
  if (organizationId === null) {
    const accepted = await acceptInvitation(token, transport.organization);
    if (!accepted.ok) {
      return accepted.failure.code === INVITATION_INVALID ? { kind: "invalid" } : { kind: "failed", joined: null };
    }
    organizationId = accepted.value.organizationId;
  }
  const chosen = await chooseOrganization(organizationId, transport.organization);
  if (chosen.ok) return { kind: "leave", to: DESTINATION, load: true };
  if (organizationRefusal(chosen.failure.code) === "suspended") {
    return { kind: "leave", to: screenPath(await routeTable(), "organization-suspended"), load: false };
  }
  return { kind: "failed", joined: organizationId };
}

export default function Invitation({ params }: ScreenProps<typeof path>): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const token = params.token;
  const arrival = useRead(`invitation:${token}`, () => arrive(token));
  const joining = useAction((_signal: AbortSignal, joined: string | null) => join(token, joined));
  const [signingIn, setSigningIn] = useState(false);

  const answer = arrival.loading ? undefined : arrival.value;
  const result = joining.value;
  const screen = {
    flex: 1,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    backgroundColor: theme.colors.background,
  };

  if (result?.kind === "leave") return <Redirect to={result.to} load={result.load} />;
  if (signingIn && answer?.kind === "offer" && answer.signIn !== null) return <Redirect to={answer.signIn} />;

  if (answer?.kind === "invalid" || result?.kind === "invalid") {
    return (
      <View style={screen}>
        <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
          {t.t("organization/invitation.invalid.title")}
        </Text>
        <Text style={[theme.type.body, { color: theme.colors.muted }]}>
          {t.t("organization/invitation.invalid.body")}
        </Text>
      </View>
    );
  }

  if (result?.kind === "failed") {
    return (
      <View style={screen}>
        <Text style={[theme.type.body, { color: theme.colors.text }]}>
          {t.t("organization/invitation.join_failed")}
        </Text>
        <Button
          theme={theme}
          disabled={joining.pending}
          onPress={() => void joining.run(result.joined)}
          label={t.t("organization/invitation.retry")}
        />
      </View>
    );
  }

  if (answer?.kind === "failed" || (answer === undefined && arrival.failure !== null && !arrival.loading)) {
    return (
      <View style={screen}>
        <Text style={[theme.type.body, { color: theme.colors.text }]}>{t.t("organization/invitation.failed")}</Text>
        <Button theme={theme} onPress={arrival.refresh} label={t.t("organization/invitation.retry")} />
      </View>
    );
  }

  if (answer === undefined) return <View style={screen} />;
  const { offer, email } = answer;
  return (
    <View style={screen}>
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("organization/invitation.title", { organization: offer.organizationName })}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>
        {offer.inviterName === null
          ? t.t("organization/invitation.invited", { role: offer.role })
          : t.t("organization/invitation.invited_by", { inviter: offer.inviterName, role: offer.role })}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>
        {t.t("organization/invitation.expires", {
          date: t.formatDate(new Date(offer.expiresAt), { dateStyle: "long" }),
        })}
      </Text>
      {email === null ? (
        <Button
          theme={theme}
          primary
          onPress={() => setSigningIn(true)}
          label={t.t("organization/invitation.sign_in")}
        />
      ) : (
        <>
          <Text style={[theme.type.body, { color: theme.colors.text }]}>
            {t.t("organization/invitation.as", { email })}
          </Text>
          <Button
            theme={theme}
            primary
            disabled={joining.pending}
            onPress={() => void joining.run(null)}
            label={t.t("organization/invitation.accept")}
          />
        </>
      )}
    </View>
  );
}

/** One button: the accent for the action the screen wants taken, a bordered surface for a retry. */
function Button(props: {
  theme: Theme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}): ReactNode {
  const { theme } = props;
  return (
    <Pressable
      role="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        alignSelf: "flex-start",
        borderWidth: 1,
        borderColor: props.primary ? theme.colors.accent : theme.colors.border,
        borderRadius: theme.radius,
        backgroundColor: props.primary ? theme.colors.accent : theme.colors.surface,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        opacity: props.disabled ? 0.6 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: props.primary ? theme.colors.onAccent : theme.colors.text }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}
