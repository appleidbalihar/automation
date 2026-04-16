import assert from "node:assert/strict";
import test from "node:test";
import { extractRolesFromClaims, resolveAuthContext } from "../src/index.js";

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
  const context = await resolveAuthContext("Bearer smoke-viewer:viewer");
  assert.equal(context.userId, "anonymous");
  assert.deepEqual(context.roles, ["viewer"]);
});
