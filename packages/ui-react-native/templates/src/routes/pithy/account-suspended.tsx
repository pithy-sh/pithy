import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSignOut } from "../../session";
import { useTheme } from "../../theme";

export const path = "/account-suspended";

// Where a suspended account is sent: the sign-in and callback screens route here on `auth/account_suspended`,
// by this role rather than by the path above, so renaming the path moves both.
export const role = "account-suspended";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **The reason is not on this screen, and that is deliberate.** The operator's reason reaches the person in the
// email the suspension sent, and in the `message` of every refusal their app receives. It does not ride in this
// screen's link: a sentence read off a deep link is a sentence anybody can write. So the screen says what
// happened, what it means, and where the details are.

/** This screen's English, baked in: the only catalog that survives being copied into your repository. */
const EN = {
  "auth/suspended.title": "Your account is suspended.",
  "auth/suspended.body": "You cannot sign in or use this app while it is suspended.",
  "auth/suspended.detail": "We emailed the reason to the address on your account.",
  "auth/suspended.contact": "If you think this is a mistake, reply to that email.",
  "auth/suspended.sign_out": "Sign out",
} satisfies MessageCatalog;

export default function AccountSuspended(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("auth/suspended.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.text }]}>{t.t("auth/suspended.body")}</Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("auth/suspended.detail")}</Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("auth/suspended.contact")}</Text>
      {/* A session may still be on this device; ending it is what lets somebody else sign in here. */}
      <Pressable
        role="button"
        disabled={busy}
        aria-disabled={busy}
        onPress={() => {
          if (busy) return;
          setBusy(true);
          void signOut();
        }}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius,
          paddingVertical: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
          alignSelf: "flex-start",
          opacity: busy ? 0.5 : 1,
        }}
      >
        <Text style={[theme.type.button, { color: theme.colors.text }]}>{t.t("auth/suspended.sign_out")}</Text>
      </Pressable>
    </View>
  );
}
