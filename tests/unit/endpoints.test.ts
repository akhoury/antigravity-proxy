import { describe, expect, test } from "bun:test";
import {
  assertNonSandboxEndpoint,
  getNonSandboxEndpoints,
  isGoogleSandboxEndpoint
} from "../../src/utils/endpoints";

describe("Google endpoint safety", () => {
  test("recognizes every sandbox.googleapis.com subdomain", () => {
    expect(isGoogleSandboxEndpoint(
      "https://staging-cloudaicompanion.sandbox.googleapis.com/v1internal:generate"
    )).toBe(true);
    expect(isGoogleSandboxEndpoint(
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent"
    )).toBe(true);
    expect(isGoogleSandboxEndpoint(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"
    )).toBe(false);
  });

  test("removes sandbox endpoints from mixed runtime configuration", () => {
    const endpoints = getNonSandboxEndpoints([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent"
    ], "agent");

    expect(endpoints).toEqual([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"
    ]);
  });

  test("fails closed when only sandbox endpoints are configured", () => {
    expect(() => getNonSandboxEndpoints([
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent"
    ], "agent")).toThrow("No non-sandbox endpoints");

    expect(() => assertNonSandboxEndpoint(
      "https://staging-cloudaicompanion.sandbox.googleapis.com/v1internal:generate"
    )).toThrow("Refusing to contact sandbox Google endpoint");
  });
});
