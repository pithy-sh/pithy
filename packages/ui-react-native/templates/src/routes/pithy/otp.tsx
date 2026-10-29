import { sendOtp, signInWithOtp } from "@pithy-sh/auth/src/client/api";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { authConfig } from "../../pithy-config";
import { routeTable, useGo, useSearch, useSearchParam } from "../../router";
import { adoptSignIn, afterSignIn, refusedAccountScreen } from "../../session";
import { type Theme, useTheme } from "../../theme";
import { transport } from "../../transport";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";

export const path = "/otp";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **The sign-in screen sends people here on a phone with no universal link.** It offers one way in, and there that
// is a code: the Worker hands a magic link only to an https link, since any app can claim a custom scheme. With
// `universalLinkOrigin` set, the sign-in screen mails a link instead and nothing sends anyone here. To send a code
// from your own screen, go here with `go(`/otp?email=${encodeURIComponent(email)}`)`.
//
// **The email is a query parameter, not a path segment.** The address is a prefill, not the thing this screen
// is, and `/otp` with no email is a valid screen that says "your inbox".

/**
 * This screen's English, baked in: the only catalog that survives being copied into your repository.
 *
 * The digit count is a real count, so it goes through `plural`: `otpLength` is configurable, and a locale with more
 * than two plural forms cannot say "digits" correctly from one string.
 */
const EN = {
  "auth/otp.title": "Enter the code.",
  "auth/otp.sent.one": "We sent {count} digit to {email}.",
  "auth/otp.sent.other": "We sent {count} digits to {email}.",
  "auth/otp.inbox": "your inbox",
  "auth/otp.failed": "That code didn't work. Try again, or send a new one.",
  "auth/otp.submit": "Sign in",
  "auth/otp.resend": "Send a new code",
} satisfies MessageCatalog;

function Button(props: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  primary?: boolean;
  theme: Theme;
}): ReactNode {
  const { theme } = props;
  return (
    <Pressable
      role="button"
      disabled={props.disabled}
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

export default function Otp(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const go = useGo();
  const search = useSearch();
  const email = useSearchParam("email") ?? "";
  const length = authConfig.otpLength;
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length }, () => ""));
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<(TextInput | null)[]>([]);
  const onToken = useCallback((value: string | null) => setCaptcha(value), []);

  const code = digits.join("");

  // One digit per box. A whole code arriving in one box, from the keyboard's one-time-code suggestion or a paste,
  // is spread across the row from there.
  function setDigit(index: number, value: string): void {
    const typed = value.replace(/\D/g, "");
    const spread = typed.length > 1 ? typed.slice(0, length - index) : typed.slice(-1);
    setDigits((current) =>
      current.map((existing, position) => {
        if (spread === "") return position === index ? "" : existing;
        const offset = position - index;
        return offset >= 0 && offset < spread.length ? (spread[offset] ?? existing) : existing;
      }),
    );
    const next = index + Math.max(spread.length, 1);
    if (spread !== "" && next < length) inputs.current[next]?.focus();
  }

  // Both calls take the transport's options and name nothing about it: on a phone they go to the Worker's origin
  // with the device's headers, on the web they carry the page's cookie.
  async function verify(): Promise<void> {
    setBusy(true);
    setError(false);
    const result = await signInWithOtp({ email, otp: code }, transport.auth);
    const held = result.ok && (await adoptSignIn(result.value));
    setBusy(false);
    if (held) {
      // A sign-in a screen or an application's authorization sent somebody to resumes it, or goes home.
      const next = await afterSignIn(search);
      if (next !== null) go(next);
      return;
    }
    // A right code for an account that may not act is refused with what happened to it, not as a wrong code, and
    // goes on to the screen for that state, by role.
    const refused = result.ok ? null : refusedAccountScreen(result.failure.code);
    if (refused) return go(screenPath(await routeTable(), refused));
    setError(true);
  }

  async function resend(): Promise<void> {
    // The gate goes on the send route and not on the verify one, which is where `@pithy-sh/auth` stacks the
    // humanity check: a code that was already mailed is not a surface worth challenging.
    await sendOtp({ email, type: "sign-in" }, { ...transport.auth, gate: (body) => turnstileRequest(body, captcha) });
  }

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("auth/otp.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>
        {t.plural("auth/otp.sent", length, { email: email || t.t("auth/otp.inbox") })}
      </Text>

      <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
        {digits.map((digit, index) => (
          <TextInput
            // The inputs are a fixed-length positional row; the position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            key={index}
            ref={(element) => {
              inputs.current[index] = element;
            }}
            value={digit}
            onChangeText={(value) => setDigit(index, value)}
            keyboardType="number-pad"
            inputMode="numeric"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            style={[
              theme.type.title,
              {
                width: 44,
                height: 56,
                textAlign: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: theme.radius,
                backgroundColor: theme.colors.surface,
                color: theme.colors.text,
              },
            ]}
          />
        ))}
      </View>

      {error && <Text style={[theme.type.body, { color: theme.colors.danger }]}>{t.t("auth/otp.failed")}</Text>}

      <View style={{ gap: theme.spacing.sm }}>
        <Button
          label={t.t("auth/otp.submit")}
          primary
          disabled={busy || code.length < length}
          onPress={() => void verify()}
          theme={theme}
        />
        {/* Resending goes back through the gated send route, so the widget belongs here too. */}
        <Turnstile onToken={onToken} />
        <Button
          label={t.t("auth/otp.resend")}
          disabled={busy || turnstilePending(captcha)}
          onPress={() => void resend()}
          theme={theme}
        />
      </View>
    </View>
  );
}
