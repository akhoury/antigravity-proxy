export function isGoogleSandboxEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "sandbox.googleapis.com" || hostname.endsWith(".sandbox.googleapis.com");
  } catch {
    return false;
  }
}

export function getNonSandboxEndpoints(
  configured: string | string[],
  poolName: string
): string[] {
  const candidates = Array.isArray(configured) ? configured : [configured];
  const endpoints = candidates.filter((endpoint): endpoint is string => {
    if (typeof endpoint !== "string" || endpoint.length === 0) return false;

    try {
      new URL(endpoint);
    } catch {
      return false;
    }

    return !isGoogleSandboxEndpoint(endpoint);
  });

  if (endpoints.length === 0) {
    throw new Error("[Config] No non-sandbox endpoints are configured for the " + poolName + " pool.");
  }

  return endpoints;
}

export function assertNonSandboxEndpoint(endpoint: string): void {
  if (isGoogleSandboxEndpoint(endpoint)) {
    throw new Error("[Safety] Refusing to contact sandbox Google endpoint: " + new URL(endpoint).hostname);
  }
}
