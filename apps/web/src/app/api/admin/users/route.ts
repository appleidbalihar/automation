import { NextResponse } from "next/server";
import {
  createUser,
  ensureRealmRole,
  getAdminAccessToken,
  getKeycloakConfig,
  getUserRealmRoles,
  listUsers,
  replaceUserRealmRoles
} from "../../auth/_lib/keycloak";
import { isAdmin, readAuthorizationHeader, resolveIdentityFromAuthorization } from "../../auth/_lib/session";

const SUPPORTED_ROLES = ["admin", "useradmin", "operator", "approver", "viewer"] as const;

interface CreateUserBody {
  username?: string;
  password?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  roles?: string[];
  enabled?: boolean;
}

function sanitizeRoles(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [];
  return [...new Set(values.map((entry) => String(entry).trim()).filter((entry) => SUPPORTED_ROLES.includes(entry as any)))];
}

async function requirePlatformAdmin(request: Request): Promise<NextResponse | null> {
  const authorization = readAuthorizationHeader(request);
  const identity = await resolveIdentityFromAuthorization(authorization);
  if (!identity) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!isAdmin(identity)) {
    return NextResponse.json({ error: "FORBIDDEN_ADMIN_ONLY" }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requirePlatformAdmin(request);
  if (denied) return denied;
  try {
    const config = getKeycloakConfig();
    const adminToken = await getAdminAccessToken(config);
    const users = await listUsers(config, adminToken);
    const withRoles = await Promise.all(
      users.map(async (user) => ({
        ...user,
        roles: (await getUserRealmRoles(config, adminToken, user.id)).map((entry) => entry.name).sort()
      }))
    );
    return NextResponse.json({ users: withRoles });
  } catch (error) {
    return NextResponse.json(
      {
        error: "USER_LIST_FAILED",
        details: error instanceof Error ? error.message : "Unknown user list failure"
      },
      { status: 502 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requirePlatformAdmin(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as CreateUserBody;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "").trim();
  if (!username || !password) {
    return NextResponse.json({ error: "USERNAME_AND_PASSWORD_REQUIRED" }, { status: 400 });
  }

  const roles = sanitizeRoles(body.roles);
  const requestedRoles = roles.length > 0 ? roles : ["useradmin"];

  try {
    const config = getKeycloakConfig();
    const adminToken = await getAdminAccessToken(config);
    for (const roleName of requestedRoles) {
      await ensureRealmRole(config, adminToken, roleName);
    }
    const userId = await createUser(config, adminToken, {
      username,
      password,
      email: String(body.email ?? "").trim() || undefined,
      firstName: String(body.firstName ?? "").trim() || undefined,
      lastName: String(body.lastName ?? "").trim() || undefined,
      enabled: body.enabled !== false
    });
    await replaceUserRealmRoles(config, adminToken, userId, requestedRoles);
    const assignedRoles = await getUserRealmRoles(config, adminToken, userId);
    return NextResponse.json({
      created: true,
      user: {
        id: userId,
        username,
        email: String(body.email ?? "").trim() || undefined,
        firstName: String(body.firstName ?? "").trim() || undefined,
        lastName: String(body.lastName ?? "").trim() || undefined,
        enabled: body.enabled !== false,
        roles: assignedRoles.map((entry) => entry.name).sort()
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown user create failure";
    const status = message === "USER_ALREADY_EXISTS" ? 409 : 502;
    return NextResponse.json({ error: "USER_CREATE_FAILED", details: message }, { status });
  }
}
