import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyResult } from "jose";

export type Role = "admin" | "useradmin" | "operator" | "approver" | "viewer";

export interface AuthContext {
  userId: string;
  roles: Role[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const allowedRoles: Role[] = ["admin", "useradmin", "operator", "approver", "viewer"];

function filterAllowedRoles(candidates: string[]): Role[] {
  const unique = new Set<Role>();
  for (const value of candidates) {
    if (allowedRoles.includes(value as Role)) {
      unique.add(value as Role);
      if (value === "operator") {
        unique.add("useradmin");
      }
    }
  }
  return [...unique];
}

function fallbackContext(): AuthContext {
  return { userId: "anonymous", roles: ["viewer"] };
}

function legacyBearerEnabled(): boolean {
  const value = (process.env.AUTH_ALLOW_LEGACY_BEARER ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function parseAuthHeader(authHeader?: string): AuthContext {
  if (!authHeader) {
    return fallbackContext();
  }
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const [userId, ...roleParts] = token.split(":");
  const roles = filterAllowedRoles(roleParts);
  const effectiveRoles = roles.length > 0 ? roles : (["viewer"] as Role[]);
  return { userId: userId || "unknown", roles: effectiveRoles };
}

export function extractRolesFromClaims(
  claims: JWTPayload,
  keycloakClientId: string
): Role[] {
  const fromRealm =
    claims.realm_access &&
    typeof claims.realm_access === "object" &&
    Array.isArray((claims.realm_access as Record<string, unknown>).roles)
      ? ((claims.realm_access as Record<string, unknown>).roles as unknown[])
      : [];

  const resourceAccess = claims.resource_access;
  const fromClient =
    resourceAccess &&
    typeof resourceAccess === "object" &&
    (resourceAccess as Record<string, unknown>)[keycloakClientId] &&
    typeof (resourceAccess as Record<string, unknown>)[keycloakClientId] === "object" &&
    Array.isArray(((resourceAccess as Record<string, unknown>)[keycloakClientId] as Record<string, unknown>).roles)
      ? ((((resourceAccess as Record<string, unknown>)[keycloakClientId] as Record<string, unknown>).roles as unknown[]))
      : [];

  const roleValues = [...fromRealm, ...fromClient].filter((item): item is string => typeof item === "string");
  const filtered = filterAllowedRoles(roleValues);
  return filtered.length > 0 ? filtered : ["viewer"];
}

function isLikelyJwt(token: string): boolean {
  return token.split(".").length === 3;
}

interface KeycloakVerifier {
  issuers: string[];
  audience: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

const verifierCache = new Map<string, KeycloakVerifier>();

function getKeycloakVerifier(): KeycloakVerifier {
  const keycloakUrl = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
  const keycloakPublicUrl = process.env.KEYCLOAK_PUBLIC_URL;
  const keycloakIssuerOverride = process.env.KEYCLOAK_ISSUER;
  const keycloakRealm = process.env.KEYCLOAK_REALM ?? "automation-platform";
  const keycloakClientId = process.env.KEYCLOAK_CLIENT_ID ?? "automation-web";
  const internalIssuer = `${keycloakUrl.replace(/\/+$/, "")}/realms/${keycloakRealm}`;
  const issuers = [internalIssuer];
  if (keycloakPublicUrl) {
    issuers.push(`${keycloakPublicUrl.replace(/\/+$/, "")}/realms/${keycloakRealm}`);
  }
  if (keycloakIssuerOverride) {
    issuers.push(keycloakIssuerOverride.replace(/\/+$/, ""));
  }
  const uniqueIssuers = [...new Set(issuers)];
  const jwksUri = `${internalIssuer}/protocol/openid-connect/certs`;

  const cached = verifierCache.get(jwksUri);
  if (cached) {
    return cached;
  }

  const created: KeycloakVerifier = {
    issuers: uniqueIssuers,
    audience: keycloakClientId,
    jwks: createRemoteJWKSet(new URL(jwksUri))
  };
  verifierCache.set(jwksUri, created);
  return created;
}

async function verifyKeycloakToken(token: string): Promise<JWTVerifyResult<JWTPayload>> {
  const verifier = getKeycloakVerifier();
  return jwtVerify(token, verifier.jwks, {
    issuer: verifier.issuers
  });
}

function tokenMatchesClient(claims: JWTPayload, clientId: string): boolean {
  if (claims.azp === clientId) {
    return true;
  }

  const aud = claims.aud;
  if (typeof aud === "string" && aud === clientId) {
    return true;
  }
  if (Array.isArray(aud) && aud.includes(clientId)) {
    return true;
  }

  const resourceAccess = claims.resource_access;
  if (resourceAccess && typeof resourceAccess === "object") {
    return Boolean((resourceAccess as Record<string, unknown>)[clientId]);
  }

  return false;
}

export async function resolveAuthContext(authHeader?: string): Promise<AuthContext> {
  if (!authHeader) {
    return fallbackContext();
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return fallbackContext();
  }

  if (!isLikelyJwt(token)) {
    if (legacyBearerEnabled()) {
      return parseAuthHeader(authHeader);
    }
    return fallbackContext();
  }

  try {
    const verified = await verifyKeycloakToken(token);
    const claims = verified.payload;
    const keycloakClientId = process.env.KEYCLOAK_CLIENT_ID ?? "automation-web";
    if (!tokenMatchesClient(claims, keycloakClientId)) {
      return fallbackContext();
    }
    const roles = extractRolesFromClaims(claims, keycloakClientId);
    const userId = String(claims.preferred_username ?? claims.sub ?? "unknown");
    return { userId, roles };
  } catch {
    return fallbackContext();
  }
}

export async function authHook(request: FastifyRequest): Promise<void> {
  request.auth = await resolveAuthContext(request.headers.authorization);
}

export function requireAnyRole(roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = request.auth ?? { userId: "anonymous", roles: ["viewer"] };
    const allowed = roles.some((role) => context.roles.includes(role));
    if (!allowed) {
      reply.code(403).send({ error: "FORBIDDEN", requiredRoles: roles });
    }
  };
}
