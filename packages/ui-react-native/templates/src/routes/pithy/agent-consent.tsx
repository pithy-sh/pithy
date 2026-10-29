import { type ConsentView, decideConsent, readConsent } from "@pithy-sh/auth/src/client/mcp";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import * as Linking from "expo-linking";
import { type ReactNode, useState } from "react";
import { Linking as PageLinking, Pressable, Text, View } from "react-native";
import { authConfig } from "../../pithy-config";
import { onDevice, parseQuery, queryString } from "../../platform";
import { Redirect, routeTable, useSearch } from "../../router";
import { getSession, RESUME_PARAM } from "../../session";
import { type Theme, useTheme } from "../../theme";
import { transport } from "../../transport";

export const path = "/agent-consent";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **An application is asking to act as you, and this is the one place a mistake here is irreversible.** Read this
// before restyling it.
//
// **The application's name is whatever it said it was.** Anybody can register a client and call it "POWERPLAY
// Official Sync"; nothing has checked it. So the name is shown as reported, in ordinary weight, and the emphasis goes
// to the one thing that cannot be spoofed: where the access goes — the redirect address, which the authorization
// server enforces. Making the name the headline is how this screen becomes a phishing page you shipped.
//
// **One decision, and nothing to tick.** Approving lets the application act as you in this app. The list is the
// consequence — what it will then be able to do, per capability, in each capability's own words — and it only ever
// lists what your role allows. Your role stays the ceiling: approving everything still never grants more than it.
//
// **Not signed in?** The authorization server sends people here to sign in too. The screen sends you to sign in
// with the request in the query, and the sign-in resumes it: in this page on the web, and in the system browser on
// a phone, because the authorization request belongs to the Worker's web pages rather than to the app.

/** Where the MCP capability mounts. Change this if `mcp({ path })` does. */
const MCP_PATH = "/mcp";

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/consent.title": "An application wants to act as you.",
  "auth/consent.reported": "It calls itself {name}. That name is its own, and nobody has checked it.",
  "auth/consent.unnamed": "It gave no name.",
  "auth/consent.redirect": "Access will be sent to",
  "auth/consent.redirect_note": "Approve only if you started this from that application.",
  "auth/consent.can_do": "If you approve, it can:",
  "auth/consent.count.one": "{reachable} of {count} operation in {capability}.",
  "auth/consent.count.other": "{reachable} of {count} operations in {capability}.",
  "auth/consent.withheld.one": "{count} more needs a role you do not hold.",
  "auth/consent.withheld.other": "{count} more need a role you do not hold.",
  "auth/consent.nothing": "Your role allows it nothing here yet. It gains what your role gains.",
  "auth/consent.refused_scope": "{scope}: {reason}",
  "auth/consent.not_granted.role": "Requested, and not granted, because your role does not include it.",
  "auth/consent.not_granted.unknown": "Requested, and not granted, because this application has no such permission.",
  "auth/consent.bound":
    "Approving lets this application act as you. It can never do more than your role allows, and it loses anything your role loses.",
  "auth/consent.approve": "Let it act as me",
  "auth/consent.deny": "Don't allow",
  "auth/consent.expired": "This request has expired. Start again from the application.",
  "auth/consent.effect.writes": "changes data",
  "auth/consent.effect.sends": "sends a message",
  "auth/consent.effect.charges": "charges money",
  "auth/consent.effect.deletes": "deletes data",
} satisfies MessageCatalog;

/** The parameters the authorization server signed the request with, which a fresh authorize request signs anew. */
const SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

/** The authorization request again, unsigned, so a sign-in can resume it and the server sign it afresh. */
function authorizeAgain(query: string): string {
  const params = parseQuery(query);
  for (const key of SIGNATURE_PARAMS) delete params[key];
  return `${authConfig.basePath}/oauth2/authorize${queryString(params)}`;
}

/** The MCP routes, over this app's transport. */
function mcpOptions() {
  return { ...transport.auth, basePath: MCP_PATH };
}

/** What arriving here comes to: the request to decide, a request that cannot be read, or a sign-in first. */
type Arrival = { kind: "view"; view: ConsentView } | { kind: "failed" } | { kind: "sign-in"; to: string };

async function arrive(query: string): Promise<Arrival> {
  if ((await getSession()) === null) {
    const resume = queryString({ [RESUME_PARAM]: authorizeAgain(query) });
    return { kind: "sign-in", to: `${screenPath(await routeTable(), "sign-in")}${resume}` };
  }
  const result = await readConsent(query, mcpOptions());
  return result.ok ? { kind: "view", view: result.value } : { kind: "failed" };
}

/**
 * Leave for a page in this tab, on the web. React Native Web's own `Linking.openURL` takes the target as a second
 * argument that React Native's types leave out; `expo-linking` passes only the address, which React Native Web
 * opens in a new tab. Called on the object, because the method reads its own state.
 */
const pageLinking: { openURL(url: string, target?: string): Promise<unknown> } = PageLinking;

/**
 * Leave for the application's own address, with a code or a refusal. It is not this app: on the web the page loads
 * it in place, and on a phone the system opens whatever answers it.
 */
async function leaveFor(redirect: string): Promise<void> {
  if (onDevice()) await Linking.openURL(redirect);
  else await pageLinking.openURL(redirect, "_self");
}

function Screen(props: { theme: Theme; children?: ReactNode }): ReactNode {
  const { theme } = props;
  return (
    <View
      role="main"
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      {props.children}
    </View>
  );
}

function Button(props: {
  theme: Theme;
  label: string;
  primary?: boolean;
  disabled: boolean;
  onPress: () => void;
}): ReactNode {
  const { theme } = props;
  return (
    <Pressable
      role="button"
      disabled={props.disabled}
      aria-disabled={props.disabled}
      onPress={props.onPress}
      style={{
        borderWidth: 1,
        borderColor: props.primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: props.primary ? theme.colors.accent : "transparent",
        borderRadius: theme.radius,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        alignItems: "center",
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: props.primary ? theme.colors.onAccent : theme.colors.text }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export default function Consent(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const query = useSearch().replace(/^\?/, "");
  const arrival = useRead(`consent:${query}`, () => arrive(query)).value;
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);

  async function decide(accept: boolean): Promise<void> {
    setBusy(true);
    const result = await decideConsent(query, accept, mcpOptions());
    if (!result.ok) {
      setBusy(false);
      setRefused(true);
      return;
    }
    await leaveFor(result.value.redirect);
  }

  const body = [theme.type.body, { color: theme.colors.text }];
  const muted = [theme.type.body, { color: theme.colors.muted }];

  if (arrival?.kind === "sign-in") return <Redirect to={arrival.to} />;
  if (refused || arrival?.kind === "failed") {
    return (
      <Screen theme={theme}>
        <Text style={body}>{t.t("auth/consent.expired")}</Text>
      </Screen>
    );
  }
  if (arrival === undefined) return <Screen theme={theme} />;
  const view = arrival.view;

  return (
    <Screen theme={theme}>
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("auth/consent.title")}
      </Text>
      <Text style={muted}>
        {view.client.reportedName === null
          ? t.t("auth/consent.unnamed")
          : t.t("auth/consent.reported", { name: view.client.reportedName })}
      </Text>
      <Text style={body}>
        {t.t("auth/consent.redirect")} <Text style={{ fontWeight: "700" }}>{view.client.redirectUri}</Text>
      </Text>
      <Text style={muted}>{t.t("auth/consent.redirect_note")}</Text>

      {view.capabilities.length === 0 ? (
        <Text style={body}>{t.t("auth/consent.nothing")}</Text>
      ) : (
        <>
          <Text style={body}>{t.t("auth/consent.can_do")}</Text>
          {view.capabilities.map((row) => (
            <View key={row.capability} style={{ gap: theme.spacing.xs }}>
              <Text role="heading" style={[theme.type.button, { color: theme.colors.text }]}>
                {row.capability}
              </Text>
              <View role="list" style={{ gap: theme.spacing.xs }}>
                {row.operations.map((operation) => (
                  <View role="listitem" key={operation.tool}>
                    <Text style={body}>
                      {operation.summary}
                      {operation.effect === null ? null : (
                        <Text style={{ color: theme.colors.muted }}>
                          {" — "}
                          {t.t(`auth/consent.effect.${operation.effect}`)}
                        </Text>
                      )}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={muted}>
                {t.plural("auth/consent.count", row.total, {
                  reachable: String(row.reachable),
                  capability: row.capability,
                })}
                {row.total > row.reachable ? ` ${t.plural("auth/consent.withheld", row.total - row.reachable)}` : null}
              </Text>
            </View>
          ))}
        </>
      )}

      {view.requested
        .filter((scope) => !scope.granted)
        .map((scope) => (
          <Text key={scope.scope} style={muted}>
            {t.t("auth/consent.refused_scope", {
              scope: scope.scope,
              reason: t.t(`auth/consent.not_granted.${scope.reason ?? "unknown"}`),
            })}
          </Text>
        ))}

      <Text style={muted}>{t.t("auth/consent.bound")}</Text>
      <Button
        theme={theme}
        primary
        label={t.t("auth/consent.approve")}
        disabled={busy}
        onPress={() => void decide(true)}
      />
      <Button theme={theme} label={t.t("auth/consent.deny")} disabled={busy} onPress={() => void decide(false)} />
    </Screen>
  );
}
