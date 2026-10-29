import {
  type ConnectedApplication,
  listConnectedApplications,
  revokeConnectedApplication,
} from "@pithy-sh/auth/src/client/mcp";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Theme, useTheme } from "../../theme";
import { transport } from "../../transport";

export const path = "/connected-applications";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **Revoking is the only narrowing a person has.** Consent is one decision with nothing to deselect, so "I do not
// want it doing that" has exactly one answer, and it must be reachable without asking an administrator. Link to
// this screen from your account settings. A revoked application's next call is refused.
//
// Each application is shown by the name it gave itself — unverified, as on the consent screen — and by where its
// access goes, which is what identifies it.

/** Where the MCP capability mounts. Change this if `mcp({ path })` does. */
const MCP_PATH = "/mcp";

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/connected.title": "Applications acting as you",
  "auth/connected.empty": "None. Nothing is acting as you.",
  "auth/connected.unnamed": "An application with no name",
  "auth/connected.approved": "Approved {date}. Access goes to {redirect}.",
  "auth/connected.revoke": "Revoke",
  "auth/connected.failed": "We couldn't load your applications.",
  "auth/connected.retry": "Try again",
} satisfies MessageCatalog;

/** The MCP routes, over this app's transport. */
function mcpOptions() {
  return { ...transport.auth, basePath: MCP_PATH };
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

function Button(props: { theme: Theme; label: string; disabled?: boolean; onPress: () => void }): ReactNode {
  const { theme } = props;
  const disabled = props.disabled ?? false;
  return (
    <Pressable
      role="button"
      disabled={disabled}
      aria-disabled={disabled}
      onPress={props.onPress}
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        alignSelf: "flex-start",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: theme.colors.text }]}>{props.label}</Text>
    </Pressable>
  );
}

export default function ConnectedApplications(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const listed = useRead("connected-applications", () => listConnectedApplications(mcpOptions()));
  const [revokeFailed, setRevokeFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const applications: readonly ConnectedApplication[] | null = listed.value?.ok ? listed.value.value : null;

  async function revoke(clientId: string): Promise<void> {
    setBusy(clientId);
    const result = await revokeConnectedApplication(clientId, mcpOptions());
    setBusy(null);
    if (!result.ok) return setRevokeFailed(true);
    listed.refresh();
  }

  function retry(): void {
    setRevokeFailed(false);
    listed.refresh();
  }

  if (revokeFailed || (listed.value?.ok === false && !listed.loading)) {
    return (
      <Screen theme={theme}>
        <Text style={[theme.type.body, { color: theme.colors.text }]}>{t.t("auth/connected.failed")}</Text>
        <Button theme={theme} label={t.t("auth/connected.retry")} onPress={retry} />
      </Screen>
    );
  }
  if (applications === null) return <Screen theme={theme} />;

  return (
    <Screen theme={theme}>
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("auth/connected.title")}
      </Text>
      {applications.length === 0 ? (
        <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("auth/connected.empty")}</Text>
      ) : null}
      <View role="list" style={{ gap: theme.spacing.md }}>
        {applications.map((application) => (
          <View
            role="listitem"
            key={application.clientId}
            style={{
              gap: theme.spacing.xs,
              padding: theme.spacing.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: theme.radius,
              backgroundColor: theme.colors.surface,
            }}
          >
            <Text style={[theme.type.body, { color: theme.colors.text }]}>
              {application.reportedName ?? t.t("auth/connected.unnamed")}
            </Text>
            <Text style={[theme.type.caption, { color: theme.colors.muted }]}>
              {t.t("auth/connected.approved", {
                date: t.formatDate(new Date(application.approvedAt)),
                redirect: application.redirectUris.join(", "),
              })}
            </Text>
            <Button
              theme={theme}
              label={t.t("auth/connected.revoke")}
              disabled={busy === application.clientId}
              onPress={() => void revoke(application.clientId)}
            />
          </View>
        ))}
      </View>
    </Screen>
  );
}
