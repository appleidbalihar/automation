import { NextResponse } from "next/server";
import {
  findUserIdByUsername,
  getAdminAccessToken,
  getKeycloakConfig,
  resetUserPassword,
  validateUserPassword
} from "../../auth/_lib/keycloak";
import { readAuthorizationHeader, resolveIdentityFromAuthorization } from "../../auth/_lib/session";

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const authorization = readAuthorizationHeader(request);
  const identity = await resolveIdentityFromAuthorization(authorization);
  if (!identity) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as ChangePasswordBody;
  const currentPassword = String(body.currentPassword ?? "").trim();
  const newPassword = String(body.newPassword ?? "").trim();
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "CURRENT_AND_NEW_PASSWORD_REQUIRED" }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "WEAK_PASSWORD_MIN_8_CHARS" }, { status: 400 });
  }

  try {
    const config = getKeycloakConfig();
    const currentValid = await validateUserPassword(config, identity.userId, currentPassword);
    if (!currentValid) {
      return NextResponse.json({ error: "CURRENT_PASSWORD_INVALID" }, { status: 401 });
    }
    const adminToken = await getAdminAccessToken(config);
    const userId = await findUserIdByUsername(config, adminToken, identity.userId);
    if (!userId) {
      return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
    }
    await resetUserPassword(config, adminToken, userId, newPassword, false);
    return NextResponse.json({ changed: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "PASSWORD_CHANGE_FAILED",
        details: error instanceof Error ? error.message : "Unknown keycloak password update error"
      },
      { status: 502 }
    );
  }
}
