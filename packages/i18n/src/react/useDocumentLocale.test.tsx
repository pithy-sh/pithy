// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useDocumentLocale } from "./useDocumentLocale";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Props {
  readonly enabled: boolean;
  readonly locale: string;
  readonly direction: "ltr" | "rtl";
}

function Probe(props: Props): null {
  useDocumentLocale(props.enabled, props.locale, props.direction);
  return null;
}

let root: Root | null = null;

function render(props: Props): void {
  root ??= createRoot(document.createElement("div"));
  const current = root;
  act(() => current.render(<Probe {...props} />));
}

beforeEach(() => {
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("dir");
});

afterEach(() => {
  const current = root;
  if (current) act(() => current.unmount());
  root = null;
});

describe("useDocumentLocale", () => {
  test("disabled, it leaves the document's lang and dir alone", () => {
    render({ enabled: false, locale: "ar", direction: "rtl" });
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBeNull();
  });

  test("enabled, it writes lang and dir, and rewrites them when the locale changes", () => {
    render({ enabled: true, locale: "fr-CA", direction: "ltr" });
    expect(document.documentElement.lang).toBe("fr-CA");
    expect(document.documentElement.dir).toBe("ltr");
    render({ enabled: true, locale: "ar", direction: "rtl" });
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });
});
