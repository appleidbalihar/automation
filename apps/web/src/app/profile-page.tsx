"use client";

import { useState } from "react";
import type { ReactElement } from "react";
import { authHeaderFromStoredToken } from "./auth-client";

export function ProfilePage(): ReactElement {
  const [currentPassword, setCurrentPassword] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [confirmPassword, setConfirmPassword] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  async function submitChange(): Promise<void> {
    setStatus("");
    setError("");
    if (!currentPassword || !newPassword) {
      setError("Current password and new password are required.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password confirmation does not match.");
      return;
    }
    setSubmitting(true);
    try {
      const authorization = authHeaderFromStoredToken();
      const response = await fetch("/api/profile/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {})
        },
        body: JSON.stringify({
          currentPassword,
          newPassword
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
      if (!response.ok) {
        setError(payload.details ?? payload.error ?? "Password change failed");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setStatus("Password updated successfully in Keycloak.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Password change request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card" style={{ maxWidth: 620 }}>
      <h1 style={{ marginTop: 0 }}>Profile</h1>
      <p>Change your account password. The update is applied directly in Keycloak.</p>
      <div className="login-form">
        <label htmlFor="profile-current-password">Current Password</label>
        <input
          id="profile-current-password"
          type="password"
          value={currentPassword}
          autoComplete="current-password"
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <label htmlFor="profile-new-password">New Password</label>
        <input
          id="profile-new-password"
          type="password"
          value={newPassword}
          autoComplete="new-password"
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <label htmlFor="profile-confirm-password">Confirm New Password</label>
        <input
          id="profile-confirm-password"
          type="password"
          value={confirmPassword}
          autoComplete="new-password"
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
      </div>
      <div className="login-actions">
        <button type="button" disabled={submitting} onClick={() => submitChange().catch(() => undefined)}>
          {submitting ? "Updating..." : "Change Password"}
        </button>
      </div>
      {status ? <p className="ops-status-line">{status}</p> : null}
      {error ? <p className="ops-error">{error}</p> : null}
    </section>
  );
}
