"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";

interface ManagedUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  roles: string[];
}

const editableRoles = ["admin", "useradmin", "approver", "viewer", "operator"] as const;

export function UsersAdminPanel(): ReactElement {
  const [identity, setIdentity] = useState<{ userId: string; roles: string[] } | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [newUsername, setNewUsername] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [newEmail, setNewEmail] = useState<string>("");
  const [newFirstName, setNewFirstName] = useState<string>("");
  const [newLastName, setNewLastName] = useState<string>("");
  const [newRoles, setNewRoles] = useState<string[]>(["useradmin"]);

  const [editEnabled, setEditEnabled] = useState<boolean>(true);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [resetPassword, setResetPassword] = useState<string>("");

  const selectedUser = users.find((entry) => entry.id === selectedUserId) ?? null;

  function isAdmin(): boolean {
    return Boolean(identity?.roles.includes("admin"));
  }

  function roleToggle(current: string[], role: string): string[] {
    return current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role];
  }

  async function requestJson<T>(url: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
    const authorization = authHeaderFromStoredToken();
    const response = await fetch(url, {
      method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
    if (!response.ok) {
      throw new Error(payload.details ?? payload.error ?? `Request failed ${response.status}`);
    }
    return payload as T;
  }

  async function loadUsers(): Promise<void> {
    const payload = await requestJson<{ users: ManagedUser[] }>("/api/admin/users", "GET");
    setUsers(payload.users);
    if (!selectedUserId && payload.users[0]?.id) {
      setSelectedUserId(payload.users[0].id);
    }
  }

  useEffect(() => {
    fetchIdentity()
      .then((entry) => setIdentity(entry))
      .catch(() => setIdentity(null));
  }, []);

  useEffect(() => {
    if (!isAdmin()) return;
    loadUsers().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load users");
    });
  }, [identity?.roles.join(",")]);

  useEffect(() => {
    if (!selectedUser) return;
    setEditEnabled(selectedUser.enabled);
    setEditRoles(selectedUser.roles);
  }, [selectedUserId, users]);

  if (!isAdmin()) {
    return (
      <section className="card">
        <h1 style={{ marginTop: 0 }}>User Management</h1>
        <p>Only platform-admin users can access this page.</p>
      </section>
    );
  }

  async function createManagedUser(): Promise<void> {
    setStatus("");
    setError("");
    if (!newUsername.trim() || !newPassword.trim()) {
      setError("Username and password are required.");
      return;
    }
    setStatus("Creating user...");
    try {
      const payload = await requestJson<{ user: ManagedUser }>("/api/admin/users", "POST", {
        username: newUsername.trim(),
        password: newPassword,
        email: newEmail.trim() || undefined,
        firstName: newFirstName.trim() || undefined,
        lastName: newLastName.trim() || undefined,
        roles: newRoles
      });
      setStatus(`User ${payload.user.username} created.`);
      setNewUsername("");
      setNewPassword("");
      setNewEmail("");
      setNewFirstName("");
      setNewLastName("");
      setNewRoles(["useradmin"]);
      await loadUsers();
      setSelectedUserId(payload.user.id);
    } catch (createError) {
      setStatus("");
      setError(createError instanceof Error ? createError.message : "User create failed");
    }
  }

  async function saveUserChanges(): Promise<void> {
    if (!selectedUser) return;
    setStatus("Saving user settings...");
    setError("");
    try {
      await requestJson(`/api/admin/users/${selectedUser.id}`, "PATCH", {
        enabled: editEnabled,
        roles: editRoles
      });
      setStatus("User updated.");
      await loadUsers();
    } catch (saveError) {
      setStatus("");
      setError(saveError instanceof Error ? saveError.message : "Failed to update user");
    }
  }

  async function submitPasswordReset(): Promise<void> {
    if (!selectedUser) return;
    if (!resetPassword.trim()) {
      setError("Reset password cannot be empty.");
      return;
    }
    setStatus("Resetting user password...");
    setError("");
    try {
      await requestJson(`/api/admin/users/${selectedUser.id}/password`, "POST", {
        password: resetPassword,
        temporary: false
      });
      setStatus("Password reset completed.");
      setResetPassword("");
    } catch (resetError) {
      setStatus("");
      setError(resetError instanceof Error ? resetError.message : "Password reset failed");
    }
  }

  async function removeUser(): Promise<void> {
    if (!selectedUser) return;
    if (selectedUser.username === "platform-admin") {
      setError("platform-admin cannot be deleted.");
      return;
    }
    const confirmed = window.confirm(`Delete user ${selectedUser.username}?`);
    if (!confirmed) return;
    setStatus("Deleting user...");
    setError("");
    try {
      await requestJson(`/api/admin/users/${selectedUser.id}`, "DELETE");
      setStatus("User deleted.");
      setSelectedUserId("");
      await loadUsers();
    } catch (deleteError) {
      setStatus("");
      setError(deleteError instanceof Error ? deleteError.message : "User delete failed");
    }
  }

  return (
    <div className="card-grid">
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Users</h1>
        <p>Platform-admin can fully manage Keycloak users and roles.</p>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Roles</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} onClick={() => setSelectedUserId(user.id)} style={{ cursor: "pointer", background: selectedUserId === user.id ? "#eff6ff" : "transparent" }}>
                  <td>{user.username}</td>
                  <td>{user.roles.join(", ") || "-"}</td>
                  <td>{user.enabled ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Create User</h2>
        <div className="login-form">
          <label>Username</label>
          <input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
          <label>Password</label>
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <label>Email</label>
          <input value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
          <label>First Name</label>
          <input value={newFirstName} onChange={(event) => setNewFirstName(event.target.value)} />
          <label>Last Name</label>
          <input value={newLastName} onChange={(event) => setNewLastName(event.target.value)} />
          <label>Roles</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {editableRoles.map((role) => (
              <label key={role} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={newRoles.includes(role)}
                  onChange={() => setNewRoles((current) => roleToggle(current, role))}
                />
                {role}
              </label>
            ))}
          </div>
        </div>
        <div className="login-actions">
          <button type="button" onClick={() => createManagedUser().catch(() => undefined)}>
            Create User
          </button>
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Selected User</h2>
        {selectedUser ? (
          <>
            <p style={{ marginTop: 0 }}>
              <strong>{selectedUser.username}</strong> ({selectedUser.email || "no email"})
            </p>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={editEnabled} onChange={(event) => setEditEnabled(event.target.checked)} />
              Enabled
            </label>
            <p style={{ marginBottom: 6 }}>Roles</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
              {editableRoles.map((role) => (
                <label key={role} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={editRoles.includes(role)} onChange={() => setEditRoles((current) => roleToggle(current, role))} />
                  {role}
                </label>
              ))}
            </div>
            <div className="ops-actions-grid">
              <button type="button" onClick={() => saveUserChanges().catch(() => undefined)}>
                Save User
              </button>
              <button type="button" onClick={() => removeUser().catch(() => undefined)}>
                Delete User
              </button>
            </div>
            <div className="login-form">
              <label>Reset Password</label>
              <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </div>
            <div className="login-actions">
              <button type="button" onClick={() => submitPasswordReset().catch(() => undefined)}>
                Reset Password
              </button>
            </div>
          </>
        ) : (
          <p>Select a user to edit details.</p>
        )}
        {status ? <p className="ops-status-line">{status}</p> : null}
        {error ? <p className="ops-error">{error}</p> : null}
      </section>
    </div>
  );
}
