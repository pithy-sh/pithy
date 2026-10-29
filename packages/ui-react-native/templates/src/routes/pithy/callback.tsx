import { HANDOFF_CODE_PARAM } from "@pithy-sh/auth/src/client/handoff";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { onDevice, queryString, searchParam } from "../../platform";
import { Redirect, routeTable, useSearch } from "../../router";
import { afterSignIn, completeHandoff, getSession, refusedAccountScreen } from "../../session";
import { useTheme } from "../../theme";

export const path = "/callback";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// `sign-in.tsx` builds every link that returns here from the `path` above, so renaming it moves both ends at
// once. The round trip is the one flow nobody already signed in can test, so it must not be two strings that only
// happen to agree.

/** This screen's English, baked in: the only catalog that survives being copied into your repository. */
const EN = {
  "auth/callback.title": "Signing you in.",
  "auth/callback.body": "One moment.",
} satisfies MessageCatalog;

/**
 * Where this landing goes next, or `null` when the app is leaving for the Worker's own page.
 *
 * On the web the Worker set the session cookie before anybody lands here, so this asks who you are and moves on.
 * On a phone the deep link carries a one-time code instead, which is traded for the session with the verifier
 * the sign-in left in the secure store; a code this device never asked for trades for nothing. Either way a
 * refusal for the account's standing arrives as `?error=` and goes on to the screen for that state, a provider's
 * refusal goes on to the sign-in screen that says who refused, and a sign-in a screen or an application's
 * authorization sent somebody to resumes it.
 */
async function landing(search: string): Promise<{ to: string } | null> {
  const table = await routeTable();
  const error = searchParam(search, "error");
  const refused = refusedAccountScreen(error);
  if (refused) return { to: screenPath(table, refused) };
  const provider = searchParam(search, "provider");
  if (error !== null && provider !== null) {
    return { to: `${screenPath(table, "sign-in")}${queryString({ provider, error })}` };
  }
  const code = onDevice() ? searchParam(search, HANDOFF_CODE_PARAM) : null;
  if (code !== null) {
    const traded = await completeHandoff(code);
    const refusedTrade = traded.ok ? null : refusedAccountScreen(traded.code);
    if (refusedTrade) return { to: screenPath(table, refusedTrade) };
  }
  if ((await getSession()) === null) return { to: screenPath(table, "sign-in") };
  const next = await afterSignIn(search);
  return next === null ? null : { to: next };
}

export default function Callback(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const search = useSearch();
  const next = useRead("callback", () => landing(search), { once: true }).value;

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("auth/callback.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("auth/callback.body")}</Text>
      {next ? <Redirect to={next.to} replace /> : null}
    </View>
  );
}
