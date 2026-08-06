import { describe, expect, test } from "bun:test";
import { parseGoogleError } from "../../src/utils/errors";

describe("Unit Tests: parseGoogleError", () => {
  test("classifies INVALID_ARGUMENT responses", () => {
    const result = parseGoogleError(JSON.stringify({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT"
      }
    }));

    expect(result.reason).toBe("invalid_argument");
    expect(result.status).toBe(400);
    expect(result.message).toBe("Request contains an invalid argument.");
  });

  test("classifies staging SERVICE_DISABLED responses", () => {
    const result = parseGoogleError(JSON.stringify({
      error: {
        code: 403,
        message: "Gemini for Google Cloud API (Staging) is disabled.",
        status: "PERMISSION_DENIED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          domain: "googleapis.com"
        }]
      }
    }));

    expect(result.reason).toBe("service_disabled");
    expect(result.status).toBe(403);
    expect(result.isChallengeRequired).toBe(false);
  });
});
