import { NextResponse } from "next/server";

interface RegisterRequestBody {
  username?: string;
  password?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

function requiredEnv(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).trim();
}

async function getAdminToken(keycloakUrl: string, adminUsername: string, adminPassword: string): Promise<string> {
  const tokenEndpoint = new URL("/realms/master/protocol/openid-connect/token", keycloakUrl);
  const form = new URLSearchParams();
  form.set("grant_type", "password");
  form.set("client_id", "admin-cli");
  form.set("username", adminUsername);
  form.set("password", adminPassword);
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store"
  });
  const raw = await response.text();
  const payload = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(String(payload.error_description ?? payload.error ?? `ADMIN_TOKEN_HTTP_${response.status}`));
  }
  const token = String(payload.access_token ?? "");
  if (!token) {
    throw new Error("ADMIN_TOKEN_MISSING");
  }
  return token;
}

async function ensureRealmRoleAssigned(
  keycloakUrl: string,
  realm: string,
  adminToken: string,
  userId: string,
  roleName: string
): Promise<void> {
  const roleEndpoint = new URL(`/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}`, keycloakUrl);
  const roleResponse = await fetch(roleEndpoint, {
    headers: { authorization: `Bearer ${adminToken}` },
    cache: "no-store"
  });
  if (roleResponse.status === 404) {
    const createRoleEndpoint = new URL(`/admin/realms/${realm}/roles`, keycloakUrl);
    await fetch(createRoleEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: roleName,
        description: "Auto-created by registration flow"
      })
    });
  } else if (!roleResponse.ok) {
    return;
  }

  const refreshedRoleResponse = await fetch(roleEndpoint, {
    headers: { authorization: `Bearer ${adminToken}` },
    cache: "no-store"
  });
  if (!refreshedRoleResponse.ok) return;

  const rolePayload = (await refreshedRoleResponse.json()) as Record<string, unknown>;
  const roleMappingEndpoint = new URL(`/admin/realms/${realm}/users/${userId}/role-mappings/realm`, keycloakUrl);
  await fetch(roleMappingEndpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify([
      {
        id: rolePayload.id,
        name: rolePayload.name
      }
    ])
  });
}

async function findUserIdByUsername(keycloakUrl: string, realm: string, adminToken: string, username: string): Promise<string | undefined> {
  const lookupEndpoint = new URL(`/admin/realms/${realm}/users`, keycloakUrl);
  lookupEndpoint.searchParams.set("username", username);
  lookupEndpoint.searchParams.set("exact", "true");
  const lookupResponse = await fetch(lookupEndpoint, {
    headers: { authorization: `Bearer ${adminToken}` },
    cache: "no-store"
  });
  if (!lookupResponse.ok) return undefined;
  const users = (await lookupResponse.json()) as Array<{ id?: string }>;
  return users[0]?.id;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as RegisterRequestBody;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "").trim();
  const email = String(body.email ?? "").trim();
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();

  if (!username || !password) {
    return NextResponse.json({ error: "USERNAME_AND_PASSWORD_REQUIRED" }, { status: 400 });
  }

  const keycloakUrl = requiredEnv("KEYCLOAK_URL", "https://localhost:8443");
  const realm = requiredEnv("KEYCLOAK_REALM", "automation-platform");
  const adminUsername = requiredEnv("KEYCLOAK_ADMIN_USERNAME", "admin");
  const adminPassword = requiredEnv("KEYCLOAK_ADMIN_PASSWORD", "admin");
  const registrationRole = requiredEnv("KEYCLOAK_REGISTER_DEFAULT_ROLE", "useradmin");

  try {
    const adminToken = await getAdminToken(keycloakUrl, adminUsername, adminPassword);
    const createEndpoint = new URL(`/admin/realms/${realm}/users`, keycloakUrl);
    const createResponse = await fetch(createEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username,
        enabled: true,
        email: email || undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        emailVerified: Boolean(email),
        credentials: [
          {
            type: "password",
            value: password,
            temporary: false
          }
        ]
      })
    });

    if (createResponse.status === 409) {
      return NextResponse.json({ error: "USER_ALREADY_EXISTS" }, { status: 409 });
    }
    if (!createResponse.ok) {
      const raw = await createResponse.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        payload = { raw };
      }
      return NextResponse.json(
        {
          error: "KEYCLOAK_USER_CREATE_FAILED",
          details: payload.errorMessage ?? payload.error ?? `HTTP_${createResponse.status}`
        },
        { status: 502 }
      );
    }

    const userId = await findUserIdByUsername(keycloakUrl, realm, adminToken, username);
    if (userId) {
      await ensureRealmRoleAssigned(keycloakUrl, realm, adminToken, userId, registrationRole);
    }

    return NextResponse.json({
      created: true,
      username
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "KEYCLOAK_REGISTRATION_FAILED",
        details: error instanceof Error ? error.message : "Unknown registration failure"
      },
      { status: 502 }
    );
  }
}
