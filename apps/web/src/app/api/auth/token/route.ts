import { NextResponse } from "next/server";

interface TokenRequestBody {
  username?: string;
  password?: string;
}

function requiredEnv(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).trim();
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as TokenRequestBody;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "").trim();

  if (!username || !password) {
    return NextResponse.json({ error: "USERNAME_AND_PASSWORD_REQUIRED" }, { status: 400 });
  }

  const keycloakUrl = requiredEnv("KEYCLOAK_URL", "https://localhost:8443");
  const keycloakRealm = requiredEnv("KEYCLOAK_REALM", "automation-platform");
  const keycloakClientId = requiredEnv("KEYCLOAK_CLIENT_ID", "automation-web");
  const keycloakClientSecretRaw = (process.env.KEYCLOAK_CLIENT_SECRET ?? "").trim();
  const keycloakClientSecret =
    keycloakClientSecretRaw && keycloakClientSecretRaw !== "replace-me" && keycloakClientSecretRaw !== "changeme"
      ? keycloakClientSecretRaw
      : "";

  const form = new URLSearchParams();
  form.set("grant_type", "password");
  form.set("client_id", keycloakClientId);
  form.set("username", username);
  form.set("password", password);
  if (keycloakClientSecret) {
    form.set("client_secret", keycloakClientSecret);
  }

  const tokenEndpoint = new URL(`/realms/${keycloakRealm}/protocol/openid-connect/token`, keycloakUrl);
  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store"
    });

    const raw = await response.text();
    // Keycloak may return HTML (e.g. a login page or error page) when misconfigured
    // or when the realm/endpoint URL is wrong. Guard against JSON.parse throwing.
    let payload: Record<string, unknown> = {};
    if (raw.length > 0) {
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Non-JSON body (e.g. HTML error page from Keycloak proxy)
          payload = {};
        }
      }
      // If Keycloak returned HTML, surface a clear error instead of crashing
      if (!response.ok && Object.keys(payload).length === 0) {
        return NextResponse.json(
          {
            error: "KEYCLOAK_INVALID_RESPONSE",
            details: `Keycloak returned a non-JSON response (HTTP ${response.status}). Check KEYCLOAK_URL and realm configuration.`
          },
          { status: 502 }
        );
      }
    }
    if (!response.ok) {
      return NextResponse.json(
        {
          error: "KEYCLOAK_AUTH_FAILED",
          details: payload.error_description ?? payload.error ?? `HTTP_${response.status}`
        },
        { status: 401 }
      );
    }

    return NextResponse.json({
      accessToken: String(payload.access_token ?? ""),
      refreshToken: String(payload.refresh_token ?? ""),
      expiresIn: Number(payload.expires_in ?? 0),
      tokenType: String(payload.token_type ?? "Bearer")
    });
  } catch (error) {
    const causeMessage =
      error instanceof Error && error.cause && typeof error.cause === "object" && "message" in error.cause
        ? String((error.cause as { message?: unknown }).message ?? "")
        : "";
    return NextResponse.json(
      {
        error: "KEYCLOAK_UNREACHABLE",
        details:
          error instanceof Error
            ? [error.message, causeMessage].filter((part) => part && part.length > 0).join(" | ")
            : "Unknown keycloak connectivity error"
      },
      { status: 502 }
    );
  }
}
