import { type AuthFailure, isGateRefusal, sendOtp, signInWithOtp } from "@pithy-sh/auth/src/client/api";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import { useCallback, useRef, useState } from "react";
import { authConfig } from "../../pithy-config";
import { navigate, Redirect, routeTable, usePath, useSearch, useSearchParam } from "../../router";
import {
  heldOtpAddress,
  holdOtpAddress,
  refusedAccountScreen,
  releaseOtpAddress,
  resumeAfterSignIn,
  resumeQuery,
} from "../../session";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";
import "../../pithy-screens.css";

export const path = "/otp";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **Nothing sends anyone here by default.** The sign-in screen offers one way in — the magic link —
// because two passwordless paths on one screen is two things to explain, two surfaces to rate-limit,
// and two inboxes' worth of mail for one intent. This screen stays because the server route behind it
// does: if you would rather have a code, send one from your own screen, hand this screen the address and go
// here: `holdOtpAddress(email); navigate("/otp")`.
//
// **The address is never in the URL.** A path or a query string is written to every access log, proxy and
// referrer between the browser and the worker, so `holdOtpAddress` keeps it in memory and in this tab's session
// storage. A reload keeps it. A new tab, a bookmark or a link somebody else opens has none, and goes back to
// sign-in, since a code cannot be checked without the address it was sent to. An older link carrying `?email=` is
// read once, held, and dropped from the address bar.

/**
 * This screen's English, baked in — the only catalog that survives being copied into your repository.
 *
 * The digit count is a real count, so it goes through `plural` rather than being concatenated onto a
 * noun: `otpLength` is configurable, and a locale with more than two plural forms has no way to say
 * "digits" correctly from a single string.
 */
const EN = {
  "auth/otp.title": "Enter the code.",
  "auth/otp.sent.one": "We sent {count} digit to {email}.",
  "auth/otp.sent.other": "We sent {count} digits to {email}.",
  "auth/otp.inbox": "your inbox",
  "auth/otp.failed": "That code didn't work. Try again, or send a new one.",
  "auth/otp.gate_refused": "The check before sending didn't pass, so no new code was sent. Try again.",
  "auth/otp.submit": "Sign in",
  "auth/otp.resend": "Send a new code",
} satisfies MessageCatalog;

export default function Otp() {
  const t = useTranslator(EN);
  const path = usePath();
  const search = useSearch();
  const carried = useSearchParam("email");
  const [email] = useState(() => {
    if (carried) holdOtpAddress(carried);
    return carried || heldOtpAddress() || "";
  });
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: authConfig.otpLength }, () => ""));
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [gateRefusal, setGateRefusal] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const onToken = useCallback((value: string | null) => setCaptcha(value), []);

  const code = digits.join("");

  function setDigit(index: number, value: string): void {
    const digit = value.replace(/\D/g, "").slice(-1);
    setDigits((current) => current.map((existing, position) => (position === index ? digit : existing)));
    if (digit && index + 1 < authConfig.otpLength) inputs.current[index + 1]?.focus();
  }

  // Where the auth routes are. Both calls below name an intent and nothing about transport: the
  // base-path join, the cookie mode and the failure directions belong to `@pithy-sh/auth`, which can
  // still fix them after this file is yours.
  const client = { basePath: authConfig.basePath };

  async function verify(): Promise<void> {
    setBusy(true);
    setError(false);
    const result = await signInWithOtp({ email, otp: code }, client);
    setBusy(false);
    if (result.ok) {
      releaseOtpAddress();
      // A sign-in an application's authorization sent somebody to resumes it.
      if (resumeAfterSignIn()) return;
      return navigate("/");
    }
    // A right code for an account that may not act is refused with what happened to it, not as a wrong code.
    // Telling that person "that code didn't work" sends them back for a code that was never the problem, so
    // the refusal goes on to the screen for that state, by role, the way the callback and sign-in screens do.
    const refused = refusedAccountScreen(result.failure.code);
    if (refused) return navigate(screenPath(await routeTable(), refused));
    setError(true);
  }

  async function resend(): Promise<void> {
    // The gate goes on the send route and not on the verify one, which is where `@pithy-sh/auth`
    // stacks the humanity check: a code that was already mailed is not a surface worth challenging.
    const result = await sendOtp(
      { email, type: "sign-in" },
      { ...client, gate: (body) => turnstileRequest(body, captcha) },
    );
    // The gate's refusal is shown with its code. Any other answer is not, so no answer tells a registered address
    // from another.
    setGateRefusal(!result.ok && isGateRefusal(result.failure) ? result.failure : null);
  }

  if (carried !== null) {
    const rest = new URLSearchParams(search);
    rest.delete("email");
    const query = rest.toString();
    return <Redirect to={`${path}${query ? `?${query}` : ""}`} replace />;
  }
  if (!email) {
    const resume = resumeQuery(search);
    return <Redirect screen="sign-in" replace {...(resume ? { search: resume.slice(1) } : {})} />;
  }

  return (
    <main className="screen">
      <h1>{t.t("auth/otp.title")}</h1>
      <p className="muted">
        {t.plural("auth/otp.sent", authConfig.otpLength, { email: email || t.t("auth/otp.inbox") })}
      </p>

      <div className="otp">
        {digits.map((digit, index) => (
          <input
            // The inputs are a fixed-length positional row; the position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            key={index}
            ref={(element) => {
              inputs.current[index] = element;
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={1}
            value={digit}
            onChange={(event) => setDigit(index, event.target.value)}
          />
        ))}
      </div>

      {error && <p className="muted">{t.t("auth/otp.failed")}</p>}

      <div className="stack">
        <button type="button" disabled={busy || code.length < authConfig.otpLength} onClick={() => void verify()}>
          {t.t("auth/otp.submit")}
        </button>
        {/* Resending goes back through the gated send route, so the widget belongs here too. */}
        <Turnstile onToken={onToken} />
        <button
          type="button"
          className="secondary"
          disabled={busy || turnstilePending(captcha)}
          onClick={() => void resend()}
        >
          {t.t("auth/otp.resend")}
        </button>
        {gateRefusal && (
          <div className="auth__failed" data-testid="gate-refusal" role="alert">
            <p>{t.maybe(gateRefusal.code) ?? t.t("auth/otp.gate_refused")}</p>
            <p className="muted">
              <code>{gateRefusal.code}</code>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
