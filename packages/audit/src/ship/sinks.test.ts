// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import { AuditSinks, sinksFor, sinkTakes } from "./sinks";

const splunk = {
  profile: "splunk-hec",
  url: "https://splunk.example.com:8088/services/collector/event",
  secret: "splunk-hec-token",
};

describe("AuditSinks", () => {
  test("a sink names its profile, URL and secret; the filter is optional and detail defaults off", () => {
    expect(AuditSinks.parse({ siem: splunk })).toEqual({ siem: { ...splunk, detail: false } });
    expect(AuditSinks.parse({ siem: { ...splunk, actions: ["auth/"], detail: true } }).siem).toEqual({
      ...splunk,
      actions: ["auth/"],
      detail: true,
    });
  });

  test("refuses a profile nobody wrote a format for", () => {
    expect(() => AuditSinks.parse({ siem: { ...splunk, profile: "graylog" } })).toThrow(/profile/);
  });

  test("refuses a sink with no secret name, or a name the secrets store cannot hold", () => {
    const { secret: _, ...unnamed } = splunk;
    expect(() => AuditSinks.parse({ siem: unnamed })).toThrow(/secret/);
    for (const secret of ["", "Has Spaces", "a/b"]) {
      expect(() => AuditSinks.parse({ siem: { ...splunk, secret } }), secret).toThrow(/secret/);
    }
  });

  test("refuses a URL that is not HTTPS", () => {
    for (const url of ["http://splunk.example.com/services/collector", "ftp://x.example.com", "not a url"]) {
      expect(() => AuditSinks.parse({ siem: { ...splunk, url } }), url).toThrow(/url/);
    }
  });

  test("refuses a misspelled key rather than reading it as the default it meant to change", () => {
    expect(() => AuditSinks.parse({ siem: { ...splunk, detial: true } })).toThrow(/detial/);
  });

  test("refuses a sink name that is not kebab-case, and an empty filter", () => {
    expect(() => AuditSinks.parse({ "My SIEM": splunk })).toThrow();
    expect(() => AuditSinks.parse({ siem: { ...splunk, actions: [] } })).toThrow(/actions/);
  });
});

describe("sinksFor", () => {
  test("a sink with no filter takes every action; one with prefixes takes only those", () => {
    const sinks = AuditSinks.parse({
      everything: splunk,
      auth: { ...splunk, actions: ["auth/"] },
      access: { ...splunk, actions: ["controlplane/connection", "organization/"] },
    });
    expect(sinksFor(sinks, "auth/login")).toEqual(["everything", "auth"]);
    expect(sinksFor(sinks, "controlplane/connection_created")).toEqual(["everything", "access"]);
    expect(sinksFor(sinks, "payments/refund")).toEqual(["everything"]);
    expect(sinkTakes({ actions: ["auth/"] }, "author/x")).toBe(false);
  });
});
