import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSignOut } from "../../session";
import { useTheme } from "../../theme";

export const path = "/account-deleted";

// Where a deleted account is sent: the sign-in and callback screens route here on `auth/account_deleted`,
// by this role rather than by the path above, so renaming the path moves both.
export const role = "account-deleted";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **The purge date is in the email, not here.** The deletion mailed it to the address on the account, and a date
// read off this screen's link would be one anybody could write. So the screen says what is true for every deleted
// account: it cannot sign in, it can still come back for a while, and the email says until when.

/** This screen's English, baked in: the only catalog that survives being copied into your repository. */
const EN = {
  "auth/deleted.title": "Your account is deleted.",
  "auth/deleted.body": "You cannot sign in. Its data is erased when the deletion window closes.",
  "auth/deleted.detail": "Until then it can be restored. We emailed the date to the address on your account.",
  "auth/deleted.contact": "To restore it, reply to that email before then.",
  "auth/deleted.sign_out": "Sign out",
} satisfies MessageCatalog;

export default function AccountDeleted(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("auth/deleted.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.text }]}>{t.t("auth/deleted.body")}</Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("auth/deleted.detail")}</Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("auth/deleted.contact")}</Text>
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
        <Text style={[theme.type.button, { color: theme.colors.text }]}>{t.t("auth/deleted.sign_out")}</Text>
      </Pressable>
    </View>
  );
}
