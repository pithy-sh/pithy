// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createElement, type ReactNode } from "react";
import { singleton } from "./singleton";

/** The props the kit hands a WebView, as far as a test needs to drive one. */
export interface WebViewStubProps {
  source?: { uri?: string; html?: string };
  originWhitelist?: string[];
  onShouldStartLoadWithRequest?: (request: { url: string; isTopFrame?: boolean }) => boolean;
  onMessage?: (event: { nativeEvent: { url: string; data: string } }) => void;
  onError?: (event: { nativeEvent: { url?: string; description?: string } }) => void;
  onHttpError?: (event: { nativeEvent: { url?: string; statusCode: number } }) => void;
  testID?: string;
  [prop: string]: unknown;
}

/**
 * `react-native-webview`: a page the test plays. Every mounted WebView's props are kept, newest last, so a test
 * posts a message as the page would, or asks whether a navigation would be let through.
 */
export const webViews = singleton("webViews", () => ({
  mounted: [] as WebViewStubProps[],
  last(): WebViewStubProps {
    const props = this.mounted.at(-1);
    if (!props) throw new Error("No WebView has been rendered.");
    return props;
  },
  reset(): void {
    this.mounted = [];
  },
}));

export function WebView(props: WebViewStubProps): ReactNode {
  webViews.mounted.push(props);
  return createElement("div", { "data-testid": props.testID ?? "webview", "data-uri": props.source?.uri ?? "" });
}

export default WebView;
