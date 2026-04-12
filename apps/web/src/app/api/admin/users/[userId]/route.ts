import { NextResponse } from "next/server";
import { deleteUser, ensureRealmRole, getAdminAccessToken, getKeycloakConfig, replaceUserRealmRoles, setUserEnabled } from "../../../auth/_lib/keycloak";
import { isAdmin, readAuthorizationHeader, resolveIdentityFromAuthorization } from "../../../auth/_lib/session";

const SUPPORTED_ROLES = ["admin", "useradmin", "operator", "approver", "viewer"] as const;

interface UpdateUserBody {
  enabled?: boolean;
  roles?: string[];
}

function sanitizeRoles(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [];
  return [...new Set(values.map((entry) => String(entry).trim()).filter((entry) => SUPPORTED_ROLES.includes(entry as any)))];
}

async function requirePlatformAdmin(request: Request): Promise<NextResponse | null> {
  const identity = await resolveIdentityFromAuthorization(readAuthorizationHeader(request));
  if (!identity) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!isAdmin(identity)) {
    return NextResponse.json({ error: "FORBIDDEN_ADMIN_ONLY" }, { status: 403 });
  }
  return null;
}

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }): Promise<NextResponse> {
  const denied = await requirePlatformAdmin(request);
  if (denied) return denied;
  const params = await context.params;
  const userId = String(params.userId ?? "").trim();
  if (!userId) {
    return NextResponse.json({ error: "USER_ID_REQUIRED" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as UpdateUserBody;
  try {
    const config = getKeycloakConfig();
    const adminToken = await getAdminAccessToken(config);
    if (typeof body.enabled === "boolean") {
      await setUserEnabled(config, adminToken, userId, body.enabled);
    }
    if (body.roles !== undefined) {
      const roleNames = sanitizeRoles(body.roles);
      for (const roleName of roleNames) {
        await ensureRealmRole(config, adminToken, roleName);
      }
      await replaceUserRealmRoles(config, adminToken, userId, roleNames);
    }
    return NextResponse.json({ updated: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "USER_UPDATE_FAILED",
        details: error instanceof Error ? error.message : "Unknown user update failure"
      },
      { status: 502 }
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }): Promise<NextResponse> {
  const denied = await requirePlatformAdmin(request);
  if (denied) return denied;
  const params = await context.params;
  const userId = String(params.userId ?? "").trim();
  if (!userId) {
    return NextResponse.json({ error: "USER_ID_REQUIRED" }, { status: 400 });
  }
  try {
    const config = getKeycloakConfig();
    const adminToken = await getAdminAccessToken(config);
    await deleteUser(config, adminToken, userId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "USER_DELETE_FAILED",
        details: error instanceof Error ? error.message : "Unknown user delete failure"
      },
      { status: 502 }
    );
  }
}
