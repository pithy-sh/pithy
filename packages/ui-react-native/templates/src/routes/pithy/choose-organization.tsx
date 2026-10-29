import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { type ActableOrganization, chooseOrganization, listOrganizations } from "@pithy-sh/organization/src/client/api";
import { organizationRefusal } from "@pithy-sh/organization/src/client/lifecycle";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import { type ReactNode, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { onDevice } from "../../platform";
import { Redirect, routeTable } from "../../router";
import { type Theme, useTheme } from "../../theme";
import { transport, type WorkerImage } from "../../transport";

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
// **Leaving remounts every screen, not only this one.** What is in force decides what every request may
// reach, and a plain route change keeps whatever the previous account's data had already populated — a
// roster, a header, a cached list — while the session underneath now answers for somebody else. On the web
// that is a document load; in the app the router's `load` does the same, and nothing a screen held survives.
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

/** One account the picker draws, with its mark ready for `<Image>`, or `null` for its initial. */
interface Choice {
  readonly organization: ActableOrganization;
  readonly mark: WorkerImage | null;
}

/** What an arrival, or a choice, comes to: the picker, a failure, or somewhere to go. */
type Answer = { kind: "list"; choices: Choice[] } | { kind: "failed" } | { kind: "leave"; to: string; load: boolean };

/**
 * How to draw an organization's mark, or `null` for its initial.
 *
 * A raster is a path on the Worker, which `<Image>` fetches itself, so the transport hands it the origin and, on a
 * phone, the credential. A vector arrives as its own `data:` value: the web draws it, and React Native's `<Image>`
 * cannot, so a phone shows the initial.
 */
export async function markSource(mark: string | null): Promise<WorkerImage | null> {
  if (mark === null) return null;
  if (mark.startsWith("data:")) return onDevice() && mark.startsWith("data:image/svg+xml") ? null : { uri: mark };
  return transport.image(mark);
}

/**
 * Record the choice, then leave, remounting every screen. See the note above for why.
 *
 * An account suspended since the list was drawn says so, on its own screen, by role. Nothing is in force then, so
 * a plain navigation carries nothing over. Any other refusal — including the ordinary 404 a caller naming an
 * account they do not belong to gets, which is the same answer as one that does not exist — is a failure.
 */
async function choose(organizationId: string): Promise<Answer> {
  const result = await chooseOrganization(organizationId, transport.organization);
  if (result.ok) return { kind: "leave", to: DESTINATION, load: true };
  if (organizationRefusal(result.failure.code) === "suspended") {
    return { kind: "leave", to: screenPath(await routeTable(), "organization-suspended"), load: false };
  }
  return { kind: "failed" };
}

/** Read the memberships, and decide which of the three arrivals this is. */
async function arrive(): Promise<Answer> {
  const result = await listOrganizations(transport.organization);
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
  const choices = await Promise.all(
    organizations.map(async (organization) => ({ organization, mark: await markSource(organization.mark) })),
  );
  return { kind: "list", choices };
}

export default function ChooseOrganization(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
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

  const screen = {
    flex: 1,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    backgroundColor: theme.colors.background,
  };
  const answer = chosen ?? (arrival.loading ? null : (arrival.value ?? null));
  if (answer?.kind === "leave") return <Redirect to={answer.to} load={answer.load} />;

  if (answer?.kind === "failed" || (answer === null && arrival.failure !== null && !arrival.loading)) {
    return (
      <View style={screen}>
        <Text style={[theme.type.body, { color: theme.colors.text }]}>{t.t("organization/choose.failed")}</Text>
        <Pressable role="button" onPress={retry} style={buttonStyle(theme)}>
          <Text style={[theme.type.button, { color: theme.colors.text }]}>{t.t("organization/choose.retry")}</Text>
        </Pressable>
      </View>
    );
  }

  // The read has not answered. Nothing is drawn rather than a spinner: the one-membership path leaves
  // without ever rendering, and a flash of a picker for an account nobody chose is worse than a pause.
  if (answer === null) return <View style={screen} />;

  if (answer.choices.length === 0) {
    return (
      <View style={screen}>
        <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
          {t.t("organization/choose.empty.title")}
        </Text>
        <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("organization/choose.empty.body")}</Text>
      </View>
    );
  }

  return (
    <View style={screen}>
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("organization/choose.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("organization/choose.subtitle")}</Text>
      <View role="list" style={{ gap: theme.spacing.sm }}>
        {answer.choices.map(({ organization, mark }) => (
          <View role="listitem" key={organization.id}>
            <Pressable
              role="button"
              disabled={busy}
              onPress={() => void pick(organization.id)}
              style={[
                buttonStyle(theme),
                { flexDirection: "row", alignItems: "center", gap: theme.spacing.md, opacity: busy ? 0.6 : 1 },
              ]}
            >
              <Mark name={organization.name} source={mark} theme={theme} />
              <View style={{ flexShrink: 1, gap: theme.spacing.xs }}>
                <Text style={[theme.type.button, { color: theme.colors.text }]}>{organization.name}</Text>
                <Text style={[theme.type.caption, { color: theme.colors.muted }]}>
                  {t.t("organization/choose.role", { role: organization.role })}
                </Text>
              </View>
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
}

const MARK_SIZE = 40;

/** The mark, or the name's initial when there is none to draw. The initial is an answer, not a placeholder. */
function Mark(props: { name: string; source: WorkerImage | null; theme: Theme }): ReactNode {
  const { theme } = props;
  const frame = { width: MARK_SIZE, height: MARK_SIZE, borderRadius: theme.radius };
  if (props.source !== null) {
    return <Image source={props.source} accessibilityIgnoresInvertColors alt="" style={frame} />;
  }
  return (
    <View
      aria-hidden
      style={[frame, { alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.border }]}
    >
      <Text style={[theme.type.button, { color: theme.colors.text }]}>{props.name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function buttonStyle(theme: Theme) {
  return {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius,
    backgroundColor: theme.colors.surface,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  } as const;
}
