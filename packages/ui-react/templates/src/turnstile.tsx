import { type ReactNode, useEffect, useRef } from "react";
import { turnstileConfig } from "./pithy-config";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "always" | "execute";
      /** The widget is a cross-origin iframe we cannot style, so its palette is an argument, not CSS. */
      theme: "light" | "dark" | "auto";
      /**
       * Its width is an argument too, and this is the half that is easy to miss. `normal` is a fixed
       * 300px box — which is why a widget styled `width: 100%` still sat narrower than the email field
       * beside it. `flexible` fills its container instead, with a 300px floor `pithy-screens.css`
       * keeps the form's column above.
       */
      size: "normal" | "flexible" | "compact";
      callback: (value: string) => void;
      "expired-callback": () => void;
    },
  ) => string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let script: Promise<void> | undefined;

function loadScript(): Promise<void> {
  script ??= new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");
    element.src = SCRIPT_SRC;
    element.async = true;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error("Turnstile failed to load."));
    document.head.appendChild(element);
  });
  return script;
}

/**
 * Where the response token goes on a gated request. The server reads `token.header` when one is
 * configured and `token.field` in the body otherwise — this returns both halves already decided.
 */
export function turnstileRequest(
  body: Record<string, unknown>,
  value: string | null,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  if (!turnstileConfig.enabled || !value) return { body, headers: {} };
  if (turnstileConfig.token.header) return { body, headers: { [turnstileConfig.token.header]: value } };
  return { body: { ...body, [turnstileConfig.token.field]: value }, headers: {} };
}

/** True when a gated form still needs a token before it can submit. */
export function turnstilePending(value: string | null): boolean {
  return turnstileConfig.enabled && !value;
}

/** The widget. Renders nothing at all when the capability is not composed. */
export function Turnstile(props: { onToken: (value: string | null) => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const onToken = props.onToken;

  useEffect(() => {
    if (!turnstileConfig.enabled) return;
    let live = true;
    void loadScript()
      .then(() => {
        if (!live || !host.current || !window.turnstile) return;
        window.turnstile.render(host.current, {
          sitekey: turnstileConfig.sitekey,
          // The action comes from the projection, and writing it out here again would be a bug nothing
          // short of production could see: the server asserts this exact string against the token, and
          // dev and staging run Cloudflare test keys, whose answer carries no action to compare. A
          // drifted copy is silent everywhere until it refuses every sign-in in prod. #377.
          action: turnstileConfig.action,
          appearance: turnstileConfig.mode === "invisible" ? "execute" : "always",
          // `auto` is Turnstile's own name for `prefers-color-scheme`, which is what `pithy-screens.css`
          // answers too. The widget is a cross-origin iframe, so this argument is the only lever — and
          // it resolves the same question from the same source, with nothing to keep in step.
          theme: "auto",
          // Fill the column, so the check matches the field and the button above and below it. The host
          // element supplies the width; see `.auth__check` in pithy-screens.css. Both halves are
          // required — either one alone leaves a ragged edge beside a full-width input.
          size: "flexible",
          callback: (value) => onToken(value),
          "expired-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      live = false;
    };
  }, [onToken]);

  if (!turnstileConfig.enabled) return null;
  return <div ref={host} />;
}
