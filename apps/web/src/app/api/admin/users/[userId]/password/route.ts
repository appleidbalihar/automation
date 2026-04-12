import { NextResponse } from "next/server";
import { getAdminAccessToken, getKeycloakConfig, resetUserPassword } from "../../../../auth/_lib/keycloak";
import { isAdmin, readAuthorizationHeader, resolveIdentityFromAuthorization } from "../../../../auth/_lib/session";

interface ResetPasswordBody {
  password?: string;
  temporary?: boolean;
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

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }): Promise<NextResponse> {
  const denied = await requirePlatformAdmin(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as ResetPasswordBody;
  const params = await context.params;
  const userId = String(params.userId ?? "").trim();
  const password = String(body.password ?? "").trim();
  if (!userId || !password) {
    return NextResponse.json({ error: "USER_ID_AND_PASSWORD_REQUIRED" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "WEAK_PASSWORD_MIN_8_CHARS" }, { status: 400 });
  }
  try {
    const config = getKeycloakConfig();
    const adminToken = await getAdminAccessToken(config);
    await resetUserPassword(config, adminToken, userId, password, Boolean(body.temporary));
    return NextResponse.json({ reset: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "PASSWORD_RESET_FAILED",
        details: error instanceof Error ? error.message : "Unknown password reset failure"
      },
      { status: 502 }
    );
  }
}
