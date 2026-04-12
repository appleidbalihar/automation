import assert from "node:assert/strict";
import test from "node:test";
import { extractRolesFromClaims, parseAuthHeader, resolveAuthContext } from "../src/index.js";

test("parseAuthHeader keeps legacy bearer token compatibility", () => {
  const parsed = parseAuthHeader("Bearer smoke-admin:admin:operator");
  assert.equal(parsed.userId, "smoke-admin");
  assert.deepEqual(parsed.roles, ["admin", "operator", "useradmin"]);
});

test("extractRolesFromClaims maps Keycloak realm and client roles", () => {
  const roles = extractRolesFromClaims(
    {
      realm_access: { roles: ["admin", "random-role"] },
      resource_access: {
        "automation-web": {
          roles: ["operator", "viewer", "other-role"]
        }
      }
    },
    "automation-web"
  );
  assert.deepEqual(roles, ["admin", "operator", "useradmin", "viewer"]);
});

test("resolveAuthContext falls back to viewer for missing header", async () => {
  const context = await resolveAuthContext();
  assert.equal(context.userId, "anonymous");
  assert.deepEqual(context.roles, ["viewer"]);
});

test("resolveAuthContext disables legacy token path by default", async () => {
  delete process.env.AUTH_ALLOW_LEGACY_BEARER;
  const context = await resolveAuthContext("Bearer smoke-viewer:viewer");
  assert.equal(context.userId, "anonymous");
  assert.deepEqual(context.roles, ["viewer"]);
});

test("resolveAuthContext preserves legacy token path when explicitly enabled", async () => {
  process.env.AUTH_ALLOW_LEGACY_BEARER = "true";
  try {
    const context = await resolveAuthContext("Bearer smoke-viewer:viewer");
    assert.equal(context.userId, "smoke-viewer");
    assert.deepEqual(context.roles, ["viewer"]);
  } finally {
    delete process.env.AUTH_ALLOW_LEGACY_BEARER;
  }
});
