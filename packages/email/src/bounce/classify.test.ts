// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { classifyInbound } from "./classify";

const HARD_DSN = `Reporting-MTA: dns; mx.pithy.sh
Original-Message-ID: <send-abc@pithy.sh>

Final-Recipient: rfc822;nobody@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 user unknown`;

const SOFT_DSN = `Final-Recipient: rfc822;busy@example.com
Action: failed
Status: 4.2.2
Diagnostic-Code: smtp; 452 mailbox full`;

const ARF = `Feedback-Type: abuse
User-Agent: SomeMailer/1.0
Original-Rcpt-To: angry@example.com
Original-Message-ID: <send-xyz@pithy.sh>`;

describe("classifyInbound", () => {
  test("a 5.x DSN is a hard bounce with the recipient, code, and original id", () => {
    const c = classifyInbound({ contentType: "multipart/report; report-type=delivery-status", raw: HARD_DSN });
    expect(c).toEqual({
      type: "hard",
      recipient: "nobody@example.com",
      code: "5.1.1",
      originalMessageId: "send-abc@pithy.sh",
    });
  });

  test("a 4.x DSN is a soft bounce (transient, not suppressed)", () => {
    const c = classifyInbound({ raw: SOFT_DSN });
    expect(c.type).toBe("soft");
    expect(c.recipient).toBe("busy@example.com");
  });

  test("a feedback report is a complaint", () => {
    const c = classifyInbound({ contentType: "multipart/report; report-type=feedback-report", raw: ARF });
    expect(c.type).toBe("complaint");
    expect(c.recipient).toBe("angry@example.com");
    expect(c.originalMessageId).toBe("send-xyz@pithy.sh");
  });

  test("a vacation auto-reply is a no-op", () => {
    const c = classifyInbound({ autoSubmitted: "auto-replied", raw: "Subject: Out of office\n\nI am away." });
    expect(c.type).toBe("auto_reply");
  });

  test("an ordinary human reply is ignored", () => {
    const c = classifyInbound({ autoSubmitted: "no", raw: "Subject: Re: hi\n\nThanks!" });
    expect(c.type).toBe("ignore");
  });
});
