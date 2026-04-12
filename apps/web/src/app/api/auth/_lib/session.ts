export interface SessionIdentity {
  userId: string;
  roles: string[];
}

export function readAuthorizationHeader(request: Request): string {
  return request.headers.get("authorization")?.trim() ?? "";
}

function internalGatewayBase(): string {
  return (process.env.WEB_INTERNAL_API_BASE_URL ?? "https://api-gateway:4000").trim().replace(/\/+$/, "");
}

export async function resolveIdentityFromAuthorization(authorization: string): Promise<SessionIdentity | null> {
  if (!authorization) {
    return null;
  }
  const endpoint = new URL("/auth/me", internalGatewayBase());
  const response = await fetch(endpoint, {
    headers: { authorization },
    cache: "no-store"
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as SessionIdentity | null;
  if (!payload?.userId || !Array.isArray(payload.roles)) {
    return null;
  }
  return payload;
}

export function isAdmin(identity: SessionIdentity): boolean {
  return identity.roles.includes("admin");
}
