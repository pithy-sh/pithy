import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSession, useSignOut } from "../../session";
import { useTheme } from "../../theme";

// Your screen. Pithy wrote this file once and never will again: everything under src/routes/app/ is yours. Add a
// screen by dropping a file in beside it with its own `path` export.
export const path = "/";

// Signed-out visitors are sent to the sign-in screen. Delete this line to make the screen public.
export const session = "required";

/** This screen's English, baked in. Keyed under `app/` because the screen is yours rather than a capability's. */
const EN = {
  "app/home.title": "You're in.",
  "app/home.signed_in_as": "Signed in as {email}.",
  "app/home.someone": "someone",
  "app/home.sign_out": "Sign out",
} satisfies MessageCatalog;

export default function Home(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const { session: current } = useSession();
  const signOut = useSignOut();

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("app/home.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>
        {t.t("app/home.signed_in_as", { email: current?.user.email ?? t.t("app/home.someone") })}
      </Text>
      <Pressable
        role="button"
        onPress={() => void signOut()}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius,
          paddingVertical: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
          alignSelf: "flex-start",
        }}
      >
        <Text style={[theme.type.button, { color: theme.colors.text }]}>{t.t("app/home.sign_out")}</Text>
      </Pressable>
    </View>
  );
}
