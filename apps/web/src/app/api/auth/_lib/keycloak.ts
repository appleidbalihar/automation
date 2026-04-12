export interface KeycloakConfig {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret?: string;
  adminUsername: string;
  adminPassword: string;
}

export interface KeycloakUserSummary {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
}

function readEnv(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).trim();
}

function optionalSecret(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || normalized === "replace-me" || normalized === "changeme") {
    return undefined;
  }
  return normalized;
}

export function getKeycloakConfig(): KeycloakConfig {
  return {
    baseUrl: readEnv("KEYCLOAK_URL", "https://localhost:8443").replace(/\/+$/, ""),
    realm: readEnv("KEYCLOAK_REALM", "automation-platform"),
    clientId: readEnv("KEYCLOAK_CLIENT_ID", "automation-web"),
    clientSecret: optionalSecret(readEnv("KEYCLOAK_CLIENT_SECRET", "")),
    adminUsername: readEnv("KEYCLOAK_ADMIN_USERNAME", "admin"),
    adminPassword: readEnv("KEYCLOAK_ADMIN_PASSWORD", "admin")
  };
}

export async function getAdminAccessToken(config: KeycloakConfig): Promise<string> {
  const tokenEndpoint = new URL("/realms/master/protocol/openid-connect/token", config.baseUrl);
  const form = new URLSearchParams();
  form.set("grant_type", "password");
  form.set("client_id", "admin-cli");
  form.set("username", config.adminUsername);
  form.set("password", config.adminPassword);
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store"
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error_description ?? payload.error ?? `KEYCLOAK_ADMIN_AUTH_${response.status}`));
  }
  const token = String(payload.access_token ?? "");
  if (!token) {
    throw new Error("KEYCLOAK_ADMIN_TOKEN_MISSING");
  }
  return token;
}

export async function validateUserPassword(config: KeycloakConfig, username: string, password: string): Promise<boolean> {
  const tokenEndpoint = new URL(`/realms/${config.realm}/protocol/openid-connect/token`, config.baseUrl);
  const form = new URLSearchParams();
  form.set("grant_type", "password");
  form.set("client_id", config.clientId);
  form.set("username", username);
  form.set("password", password);
  if (config.clientSecret) {
    form.set("client_secret", config.clientSecret);
  }
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store"
  });
  return response.ok;
}

function adminHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function adminJsonHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

export async function findUserIdByUsername(
  config: KeycloakConfig,
  adminToken: string,
  username: string
): Promise<string | undefined> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users`, config.baseUrl);
  endpoint.searchParams.set("username", username);
  endpoint.searchParams.set("exact", "true");
  const response = await fetch(endpoint, {
    headers: adminHeaders(adminToken),
    cache: "no-store"
  });
  if (!response.ok) return undefined;
  const users = (await response.json()) as Array<{ id?: string }>;
  return users[0]?.id;
}

export async function listRealmRoles(config: KeycloakConfig, adminToken: string): Promise<Array<{ id: string; name: string }>> {
  const endpoint = new URL(`/admin/realms/${config.realm}/roles`, config.baseUrl);
  const response = await fetch(endpoint, {
    headers: adminHeaders(adminToken),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KEYCLOAK_LIST_ROLES_${response.status}`);
  }
  const payload = (await response.json()) as Array<{ id?: string; name?: string }>;
  return payload
    .map((entry) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? "") }))
    .filter((entry) => entry.id.length > 0 && entry.name.length > 0);
}

export async function ensureRealmRole(config: KeycloakConfig, adminToken: string, roleName: string): Promise<{ id: string; name: string }> {
  const roleEndpoint = new URL(`/admin/realms/${config.realm}/roles/${encodeURIComponent(roleName)}`, config.baseUrl);
  let roleResponse = await fetch(roleEndpoint, {
    headers: adminHeaders(adminToken),
    cache: "no-store"
  });
  if (roleResponse.status === 404) {
    const createRoleEndpoint = new URL(`/admin/realms/${config.realm}/roles`, config.baseUrl);
    await fetch(createRoleEndpoint, {
      method: "POST",
      headers: adminJsonHeaders(adminToken),
      body: JSON.stringify({
        name: roleName,
        description: "Auto-created by automation platform"
      }),
      cache: "no-store"
    });
    roleResponse = await fetch(roleEndpoint, {
      headers: adminHeaders(adminToken),
      cache: "no-store"
    });
  }
  if (!roleResponse.ok) {
    throw new Error(`KEYCLOAK_ROLE_LOOKUP_${roleResponse.status}`);
  }
  const payload = (await roleResponse.json()) as { id?: string; name?: string };
  const id = String(payload.id ?? "");
  const name = String(payload.name ?? roleName);
  if (!id) {
    throw new Error("KEYCLOAK_ROLE_ID_MISSING");
  }
  return { id, name };
}

export async function getUserRealmRoles(config: KeycloakConfig, adminToken: string, userId: string): Promise<Array<{ id: string; name: string }>> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users/${userId}/role-mappings/realm`, config.baseUrl);
  const response = await fetch(endpoint, {
    headers: adminHeaders(adminToken),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KEYCLOAK_USER_ROLES_${response.status}`);
  }
  const payload = (await response.json()) as Array<{ id?: string; name?: string }>;
  return payload
    .map((entry) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? "") }))
    .filter((entry) => entry.id.length > 0 && entry.name.length > 0);
}

export async function replaceUserRealmRoles(
  config: KeycloakConfig,
  adminToken: string,
  userId: string,
  roleNames: string[]
): Promise<void> {
  const desiredNames = [...new Set(roleNames.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  const allRoles = await listRealmRoles(config, adminToken);
  const byName = new Map(allRoles.map((entry) => [entry.name, entry]));
  const desired = desiredNames.map((name) => byName.get(name)).filter((entry): entry is { id: string; name: string } => Boolean(entry));
  const current = await getUserRealmRoles(config, adminToken, userId);

  const currentByName = new Map(current.map((entry) => [entry.name, entry]));
  const desiredSet = new Set(desired.map((entry) => entry.name));
  const toAdd = desired.filter((entry) => !currentByName.has(entry.name));
  const toRemove = current.filter((entry) => !desiredSet.has(entry.name));

  const endpoint = new URL(`/admin/realms/${config.realm}/users/${userId}/role-mappings/realm`, config.baseUrl);
  if (toAdd.length > 0) {
    await fetch(endpoint, {
      method: "POST",
      headers: adminJsonHeaders(adminToken),
      body: JSON.stringify(toAdd),
      cache: "no-store"
    });
  }
  if (toRemove.length > 0) {
    await fetch(endpoint, {
      method: "DELETE",
      headers: adminJsonHeaders(adminToken),
      body: JSON.stringify(toRemove),
      cache: "no-store"
    });
  }
}

export async function listUsers(config: KeycloakConfig, adminToken: string): Promise<KeycloakUserSummary[]> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users`, config.baseUrl);
  endpoint.searchParams.set("max", "200");
  const response = await fetch(endpoint, {
    headers: adminHeaders(adminToken),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KEYCLOAK_LIST_USERS_${response.status}`);
  }
  const payload = (await response.json()) as Array<{
    id?: string;
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    enabled?: boolean;
  }>;
  return payload
    .map((entry) => ({
      id: String(entry.id ?? ""),
      username: String(entry.username ?? ""),
      email: entry.email,
      firstName: entry.firstName,
      lastName: entry.lastName,
      enabled: Boolean(entry.enabled)
    }))
    .filter((entry) => entry.id.length > 0 && entry.username.length > 0);
}

export async function createUser(
  config: KeycloakConfig,
  adminToken: string,
  payload: {
    username: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    enabled?: boolean;
    password: string;
  }
): Promise<string> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users`, config.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: adminJsonHeaders(adminToken),
    body: JSON.stringify({
      username: payload.username,
      email: payload.email || undefined,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      enabled: payload.enabled ?? true,
      emailVerified: Boolean(payload.email),
      credentials: [{ type: "password", value: payload.password, temporary: false }]
    }),
    cache: "no-store"
  });
  if (response.status === 409) {
    throw new Error("USER_ALREADY_EXISTS");
  }
  if (!response.ok) {
    throw new Error(`KEYCLOAK_CREATE_USER_${response.status}`);
  }
  const userId = await findUserIdByUsername(config, adminToken, payload.username);
  if (!userId) {
    throw new Error("KEYCLOAK_CREATED_USER_NOT_FOUND");
  }
  return userId;
}

export async function setUserEnabled(config: KeycloakConfig, adminToken: string, userId: string, enabled: boolean): Promise<void> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users/${userId}`, config.baseUrl);
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: adminJsonHeaders(adminToken),
    body: JSON.stringify({ enabled }),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KEYCLOAK_SET_ENABLED_${response.status}`);
  }
}

export async function resetUserPassword(
  config: KeycloakConfig,
  adminToken: string,
  userId: string,
  newPassword: string,
  temporary = false
): Promise<void> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users/${userId}/reset-password`, config.baseUrl);
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: adminJsonHeaders(adminToken),
    body: JSON.stringify({
      type: "password",
      value: newPassword,
      temporary
    }),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KEYCLOAK_RESET_PASSWORD_${response.status}`);
  }
}

export async function deleteUser(config: KeycloakConfig, adminToken: string, userId: string): Promise<void> {
  const endpoint = new URL(`/admin/realms/${config.realm}/users/${userId}`, config.baseUrl);
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: adminHeaders(adminToken),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KEYCLOAK_DELETE_USER_${response.status}`);
  }
}
