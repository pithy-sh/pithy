import { type ReactNode, useEffect, useRef } from "react";
import { turnstileConfig } from "./pithy-config";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The action the server asserts for a login challenge. It must be exactly this string. */
const ACTION = "login";

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "always" | "execute";
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
          action: ACTION,
          appearance: turnstileConfig.mode === "invisible" ? "execute" : "always",
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
