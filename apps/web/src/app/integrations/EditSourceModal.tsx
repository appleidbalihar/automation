"use client";

import { useState } from "react";
import type { ReactElement } from "react";
import type { Integration } from "./types";

const PLATFORM_URL = (process.env.NEXT_PUBLIC_PLATFORM_URL ?? "https://dev.eclassmanager.com").replace(/\/$/, "");
const OAUTH_CALLBACK_BASE = (process.env.NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL ?? "https://dev.eclassmanager.com/ap").replace(/\/$/, "");

type Props = {
  integration: Integration | null;
  busy: string;
  onClose: () => void;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onOAuthReconnect: (integration: Integration, appCredentials: { clientId: string; clientSecret: string } | null) => void;
  onOAuthDisconnect: (integration: Integration) => void;
  onUpdateToken: (integration: Integration, token: string) => void;
};

export function EditSourceModal(props: Props): ReactElement | null {
  const { integration, busy, onClose, onSave, onOAuthReconnect, onOAuthDisconnect, onUpdateToken } = props;
  const [name, setName] = useState(integration?.name ?? "");
  const [description, setDescription] = useState(integration?.description ?? "");
  const [sourceBranch, setSourceBranch] = useState(integration?.sourceBranch ?? "");
  const [sourcePath, setSourcePath] = useState(integration?.sourcePath ?? "");
  const [patDraft, setPatDraft] = useState("");
  const [credTab, setCredTab] = useState<"oauth" | "pat">(integration?.authMethod === "oauth" ? "oauth" : "pat");
  const [appClientId, setAppClientId] = useState("");
  const [appClientSecret, setAppClientSecret] = useState("");

  if (!integration) return null;

  const isBusy = (key: string) => busy === key;
  const providerLabel = integration.sourceType === "gitlab" ? "GitLab"
    : integration.sourceType === "googledrive" ? "Google Drive"
    : "GitHub";
  const oauthProvider = integration.sourceType === "googledrive" ? "google" : integration.sourceType;
  const supportsOauth = ["github", "gitlab", "googledrive"].includes(integration.sourceType);

  function handleSave(): void {
    onSave(integration!.id, {
      name: name.trim() || integration!.name,
      description: description.trim() || undefined,
      sourceBranch: sourceBranch.trim() || undefined,
      sourcePath: sourcePath.trim() || undefined
    });
  }

  return (
    <div className="ops-modal-overlay" role="presentation" onClick={onClose}>
      <div className="ops-modal-panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ops-modal-panel-header">
          <h2>Edit Source — {integration.name}</h2>
          <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Source details */}
        <div className="integrations-form-grid ops-modal-form">
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={integration.name} />
          </label>

          <label className="integrations-form-span-2">
            <span>Description</span>
            <textarea value={description ?? ""} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional description" />
          </label>

          <label>
            <span>Source URL</span>
            <input value={integration.sourceUrl} disabled className="ops-input-readonly" />
          </label>

          {integration.sourceType !== "web" ? (
            <>
              <label>
                <span>Branch</span>
                <input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} placeholder={integration.sourceBranch ?? "main"} />
              </label>
              <label>
                <span>Path</span>
                <input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} placeholder={integration.sourcePath ?? "docs/"} />
              </label>
            </>
          ) : null}
        </div>

        <div className="ops-edit-save-row">
          <button
            type="button"
            className="integrations-primary-button sync-btn-ready"
            onClick={handleSave}
            disabled={isBusy(`edit:${integration.id}`)}
          >
            {isBusy(`edit:${integration.id}`) ? "Saving…" : "Save Changes"}
          </button>
        </div>

        {/* Credentials section */}
        {supportsOauth ? (
          <div className="ops-edit-cred-section">
            <h3 className="ops-edit-section-title">Credentials</h3>

            <div className="ops-cred-tabs">
              <button
                type="button"
                className={`ops-cred-tab${credTab === "oauth" ? " ops-cred-tab-active" : ""}`}
                onClick={() => setCredTab("oauth")}
              >
                Connect OAuth
              </button>
              <button
                type="button"
                className={`ops-cred-tab${credTab === "pat" ? " ops-cred-tab-active" : ""}`}
                onClick={() => setCredTab("pat")}
              >
                Token (PAT)
              </button>
            </div>

            {credTab === "oauth" ? (
              <div className="ops-edit-cred-oauth">
                {integration.authMethod === "oauth" ? (
                  <div className="ops-edit-oauth-connected">
                    <span className="ops-oauth-connected">✅ Connected via {providerLabel} OAuth</span>
                    <div className="ops-oauth-app-creds ops-oauth-app-creds-inline" style={{ marginTop: 8 }}>
                      <div className="ops-oauth-app-creds-fields">
                        <label>
                          <span>Client ID {integration.oauthAppConfigured ? <span className="ops-oauth-cred-badge ops-oauth-cred-badge-ok">✓ Set</span> : null}</span>
                          <input value={appClientId} onChange={(e) => setAppClientId(e.target.value)} placeholder={integration.oauthAppConfigured ? "••••• (already set — paste to update)" : `${providerLabel} Client ID`} autoComplete="off" />
                        </label>
                        <label>
                          <span>Client Secret {integration.oauthAppConfigured ? <span className="ops-oauth-cred-badge ops-oauth-cred-badge-ok">✓ Set</span> : null}</span>
                          <input type="password" value={appClientSecret} onChange={(e) => setAppClientSecret(e.target.value)} placeholder={integration.oauthAppConfigured ? "••••• (already set — paste to update)" : `${providerLabel} Client Secret`} autoComplete="off" />
                        </label>
                      </div>
                    </div>
                    <div className="ops-edit-oauth-actions">
                      <button
                        type="button"
                        className="ops-oauth-reconnect-btn"
                        onClick={() => onOAuthReconnect(integration, appClientId.trim() || appClientSecret.trim() ? { clientId: appClientId.trim(), clientSecret: appClientSecret.trim() } : null)}
                      >
                        Reconnect {providerLabel}
                      </button>
                      <button
                        type="button"
                        className="ops-oauth-disconnect-btn"
                        onClick={() => onOAuthDisconnect(integration)}
                        disabled={isBusy(`oauth-disconnect:${integration.id}`)}
                      >
                        {isBusy(`oauth-disconnect:${integration.id}`) ? "Disconnecting…" : "Disconnect"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ops-edit-cred-oauth">
                    <p className="ops-oauth-note">Not connected via OAuth. Click below to authorise with {providerLabel}.</p>
                    <div className="ops-oauth-app-creds ops-oauth-app-creds-inline">
                      <div className="ops-oauth-app-creds-fields">
                        <label>
                          <span>Client ID {integration.oauthAppConfigured ? <span className="ops-oauth-cred-badge ops-oauth-cred-badge-ok">✓ Set</span> : null}</span>
                          <input value={appClientId} onChange={(e) => setAppClientId(e.target.value)} placeholder={integration.oauthAppConfigured ? "••••• (already set — paste to update)" : `${providerLabel} Client ID`} autoComplete="off" />
                        </label>
                        <label>
                          <span>Client Secret {integration.oauthAppConfigured ? <span className="ops-oauth-cred-badge ops-oauth-cred-badge-ok">✓ Set</span> : null}</span>
                          <input type="password" value={appClientSecret} onChange={(e) => setAppClientSecret(e.target.value)} placeholder={integration.oauthAppConfigured ? "••••• (already set — paste to update)" : `${providerLabel} Client Secret`} autoComplete="off" />
                        </label>
                      </div>
                      <p className="ops-oauth-app-creds-note">{integration.oauthAppConfigured ? "App credentials already configured for this integration. Leave blank to keep existing." : "Leave blank to use admin-configured credentials."}</p>
                    </div>
                    <button
                      type="button"
                      className="ops-oauth-connect-btn"
                      onClick={() => onOAuthReconnect(integration, appClientId.trim() || appClientSecret.trim() ? { clientId: appClientId.trim(), clientSecret: appClientSecret.trim() } : null)}
                    >
                      Connect {providerLabel}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="ops-edit-cred-pat">
                {integration.authMethod === "oauth" ? (
                  <p className="ops-pat-note">⚠ OAuth is active — this PAT will be ignored unless you disconnect OAuth first.</p>
                ) : null}
                <div className="ops-pat-input-row">
                  <input
                    type="password"
                    value={patDraft}
                    onChange={(e) => setPatDraft(e.target.value)}
                    placeholder={`${providerLabel} personal access token`}
                    className="ops-pat-input"
                  />
                  <button
                    type="button"
                    className="integrations-primary-button sync-btn-ready"
                    onClick={() => { onUpdateToken(integration, patDraft); setPatDraft(""); }}
                    disabled={!patDraft.trim() || isBusy(`token:${integration.id}`)}
                  >
                    {isBusy(`token:${integration.id}`) ? "Saving…" : "Save Token"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* OAuth provider help */}
        {supportsOauth && credTab === "oauth" && (
          <div className="ops-oauth-provider-help">
            {integration.sourceType === "github" && (
              <>
                <strong>GitHub OAuth App — required values</strong>
                <div className="ops-oauth-url-row"><span className="ops-oauth-url-label">Homepage URL</span><code className="ops-oauth-url-value">{PLATFORM_URL}</code></div>
                <div className="ops-oauth-url-row"><span className="ops-oauth-url-label">Callback URL</span><code className="ops-oauth-url-value">{OAUTH_CALLBACK_BASE}/oauth/callback/github</code></div>
                <p className="ops-oauth-help-note">Register at: github.com → Settings → Developer Settings → OAuth Apps<br />Scope needed: <code>repo</code></p>
              </>
            )}
            {integration.sourceType === "gitlab" && (
              <>
                <strong>GitLab OAuth App — required values</strong>
                <div className="ops-oauth-url-row"><span className="ops-oauth-url-label">Homepage URL</span><code className="ops-oauth-url-value">{PLATFORM_URL}</code></div>
                <div className="ops-oauth-url-row"><span className="ops-oauth-url-label">Callback URL</span><code className="ops-oauth-url-value">{OAUTH_CALLBACK_BASE}/oauth/callback/gitlab</code></div>
                <p className="ops-oauth-help-note">Register at: gitlab.com → User Settings → Applications<br />Scopes needed: <code>read_repository</code>, <code>read_api</code></p>
              </>
            )}
            {integration.sourceType === "googledrive" && (
              <>
                <strong>Google Drive OAuth — required values</strong>
                <div className="ops-oauth-url-row"><span className="ops-oauth-url-label">Homepage URL</span><code className="ops-oauth-url-value">{PLATFORM_URL}</code></div>
                <div className="ops-oauth-url-row"><span className="ops-oauth-url-label">Callback URL</span><code className="ops-oauth-url-value">{OAUTH_CALLBACK_BASE}/oauth/callback/google</code></div>
                <p className="ops-oauth-help-note">Register at: console.cloud.google.com → Credentials → OAuth 2.0 Client ID<br />Scope needed: <code>drive.readonly</code></p>
              </>
            )}
          </div>
        )}

        <div className="ops-modal-footer-nav" style={{ marginTop: 12 }}>
          <button type="button" className="ops-modal-back-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
