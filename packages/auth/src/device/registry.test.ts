import { describe, expect, test } from "vitest";
import { DEVICE_HEADERS, parseDeviceMeta } from "./registry";

describe("parseDeviceMeta", () => {
  test("returns undefined for a device-less request (no device id header)", () => {
    expect(parseDeviceMeta(new Headers())).toBeUndefined();
    expect(parseDeviceMeta(new Headers({ [DEVICE_HEADERS.platform]: "ios" }))).toBeUndefined();
  });

  test("parses a full mobile device", () => {
    const headers = new Headers({
      [DEVICE_HEADERS.id]: "dev-1",
      [DEVICE_HEADERS.platform]: "ios",
      [DEVICE_HEADERS.name]: "Ada's iPhone",
      [DEVICE_HEADERS.model]: "iPhone16,1",
      [DEVICE_HEADERS.osVersion]: "18.2",
      [DEVICE_HEADERS.appVersion]: "1.4.0",
      [DEVICE_HEADERS.pushToken]: "apns-token",
    });
    expect(parseDeviceMeta(headers)).toEqual({
      id: "dev-1",
      platform: "ios",
      name: "Ada's iPhone",
      model: "iPhone16,1",
      osVersion: "18.2",
      appVersion: "1.4.0",
      pushToken: "apns-token",
    });
  });

  test("nulls a missing or unrecognized platform (so a sparse re-login can't clobber it), and nulls absent fields", () => {
    const headers = new Headers({ [DEVICE_HEADERS.id]: "dev-2", [DEVICE_HEADERS.platform]: "toaster" });
    expect(parseDeviceMeta(headers)).toEqual({
      id: "dev-2",
      platform: null,
      name: null,
      model: null,
      osVersion: null,
      appVersion: null,
      pushToken: null,
    });
  });

  test("treats blank header values as absent", () => {
    const headers = new Headers({ [DEVICE_HEADERS.id]: "  ", [DEVICE_HEADERS.platform]: "android" });
    expect(parseDeviceMeta(headers)).toBeUndefined();
  });
});
