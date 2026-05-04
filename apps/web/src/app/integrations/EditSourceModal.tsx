"use client";

import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import type { Integration } from "./types";

// PLATFORM_URL and OAUTH_CALLBACK_BASE are driven by env vars set in .env / .env.production.
// Fallbacks use the /rapidrag path prefix so they're correct even without env vars.
// Dev:  NEXT_PUBLIC_PLATFORM_URL=https://dev.eclassmanager.com/rapidrag
// Prod: NEXT_PUBLIC_PLATFORM_URL=https://theaitools.ca/rapidrag
const PLATFORM_URL = (process.env.NEXT_PUBLIC_PLATFORM_URL ?? "https://dev.eclassmanager.com/rapidrag").replace(/\/$/, "");
const OAUTH_CALLBACK_BASE = (process.env.NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL ?? "https://dev.eclassmanager.com/rapidrag/connect").replace(/\/$/, "");

type Props = {
  integration: Integration | null;
  busy: string;
  onClose: () => void;
  /**
   * onSave receives both the patch fields and smart-sync metadata:
   *  - addedPaths: paths that are new vs what was saved before
   *  - removedPaths: paths that were removed vs what was saved before
   *  - projectNameChanged: whether projectName was changed
   */
  onSave: (
    id: string,
    patch: Record<string, unknown>,
    syncMeta: { addedPaths: string[]; removedPaths: string[]; projectNameChanged: boolean }
  ) => void;
  onOAuthReconnect: (integration: Integration, appCredentials: { clientId: string; clientSecret: string } | null) => void;
  onOAuthDisconnect: (integration: Integration) => void;
  onUpdateToken: (integration: Integration, token: string) => void;
};

/**
 * Resolve unique, non-empty paths from an integration record.
 * Prefers the sourcePaths array; falls back to the legacy sourcePath string.
 * De-duplicates so that if both fields contain the same value, we only show it once.
 */
function resolveInitialPaths(integration: Integration): string[] {
  const arr: string[] = [];
  const seen = new Set<string>();

  const candidates = integration.sourcePaths && integration.sourcePaths.length > 0
    ? integration.sourcePaths
    : integration.sourcePath
      ? [integration.sourcePath]
      : [];

  for (const p of candidates) {
    const trimmed = p.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      arr.push(trimmed);
    }
  }
  return arr.length > 0 ? arr : [""];
}

export function EditSourceModal(props: Props): ReactElement | null {
  const { integration, busy, onClose, onSave, onOAuthReconnect, onOAuthDisconnect, onUpdateToken } = props;

  // Track the integration id to detect when a different integration is opened
  const prevIntegrationId = useRef<string | null>(null);

  const [name, setName] = useState(integration?.name ?? "");
  const [projectName, setProjectName] = useState(integration?.projectName ?? "");
  const [description, setDescription] = useState(integration?.description ?? "");
  const [sourceBranch, setSourceBranch] = useState(integration?.sourceBranch ?? "");
  const [sourcePaths, setSourcePaths] = useState<string[]>(() => (integration ? resolveInitialPaths(integration) : [""]));
  const [patDraft, setPatDraft] = useState("");
  const [credTab, setCredTab] = useState<"oauth" | "pat">(integration?.authMethod === "oauth" ? "oauth" : "pat");
  const [appClientId, setAppClientId] = useState("");
  const [appClientSecret, setAppClientSecret] = useState("");

  // Reset all form fields when a different integration is opened (e.g. user opens edit on another row)
  useEffect(() => {
    if (!integration) return;
    if (prevIntegrationId.current !== integration.id) {
      prevIntegrationId.current = integration.id;
      setName(integration.name ?? "");
      setProjectName(integration.projectName ?? "");
      setDescription(integration.description ?? "");
      setSourceBranch(integration.sourceBranch ?? "");
      setSourcePaths(resolveInitialPaths(integration));
      setPatDraft("");
      setAppClientId("");
      setAppClientSecret("");
      setCredTab(integration.authMethod === "oauth" ? "oauth" : "pat");
    }
  }, [integration]);

  if (!integration) return null;

  const isBusy = (key: string) => busy === key;
  const providerLabel = integration.sourceType === "gitlab" ? "GitLab"
    : integration.sourceType === "googledrive" ? "Google Drive"
    : "GitHub";
  const oauthProvider = integration.sourceType === "googledrive" ? "google" : integration.sourceType;
  const supportsOauth = ["github", "gitlab", "googledrive"].includes(integration.sourceType);

  // The "original" saved paths for diff computation
  const originalPaths = resolveInitialPaths(integration).filter(Boolean);

  function handleSave(): void {
    const filteredPaths = [...new Set(sourcePaths.map((p) => p.trim()).filter(Boolean))];
    const origSet = new Set(originalPaths);
    const newSet = new Set(filteredPaths);

    // Compute what changed so the page can trigger smart incremental sync
    const addedPaths = filteredPaths.filter((p) => !origSet.has(p));
    const removedPaths = originalPaths.filter((p) => !newSet.has(p));
    const projectNameChanged = (projectName.trim() || "") !== (integration!.projectName ?? "");

    onSave(
      integration!.id,
      {
        name: name.trim() || integration!.name,
        projectName: projectName.trim() || undefined,
        description: description.trim() || undefined,
        sourceBranch: sourceBranch.trim() || undefined,
        sourcePaths: filteredPaths.length > 0 ? filteredPaths : undefined,
        // backward-compat single-path field
        sourcePath: filteredPaths[0] ?? undefined
      },
      { addedPaths, removedPaths, projectNameChanged }
    );
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

          <label>
            <span>Project Name <small style={{ fontWeight: 400, color: "#64748b" }}>(optional — group sources)</small></span>
            <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="e.g. Ops Platform" />
          </label>

          <label className="integrations-form-span-2">
            <span>Description</span>
            <textarea value={description ?? ""} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional description" />
          </label>

          <label className="integrations-form-span-2">
            <span>Source URL</span>
            <input value={integration.sourceUrl} disabled className="ops-input-readonly" />
          </label>

          {integration.sourceType !== "web" ? (
            <>
              <label>
                <span>Branch</span>
                <input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} placeholder={integration.sourceBranch ?? "main"} />
              </label>
              <div className="integrations-form-span-2">
                <span className="ops-paths-label">Document Paths <small style={{ fontWeight: 400, color: "#64748b" }}>(add multiple paths to index)</small></span>
                {sourcePaths.map((p, idx) => (
                  <div key={idx} className="ops-path-row">
                    <input
                      value={p}
                      onChange={(e) => {
                        const next = [...sourcePaths];
                        next[idx] = e.target.value;
                        setSourcePaths(next);
                      }}
                      placeholder={integration.sourcePath ?? "docs/"}
                    />
                    {sourcePaths.length > 1 ? (
                      <button
                        type="button"
                        className="ops-path-remove-btn"
                        onClick={() => setSourcePaths((prev) => prev.filter((_, i) => i !== idx))}
                        aria-label="Remove path"
                      >✕</button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="ops-path-add-btn"
                  onClick={() => setSourcePaths((prev) => [...prev, ""])}
                >+ Add another path</button>
              </div>
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
                          {/* Show masked placeholder when configured — never show actual stored value */}
                          <input
                            value={appClientId}
                            onChange={(e) => setAppClientId(e.target.value)}
                            placeholder={integration.oauthAppConfigured ? "••••••••••••••••  (set — paste new value to update)" : `${providerLabel} Client ID`}
                            autoComplete="off"
                          />
                        </label>
                        <label>
                          <span>Client Secret {integration.oauthAppConfigured ? <span className="ops-oauth-cred-badge ops-oauth-cred-badge-ok">✓ Set</span> : null}</span>
                          <input type="password" value={appClientSecret} onChange={(e) => setAppClientSecret(e.target.value)} placeholder={integration.oauthAppConfigured ? "••••••••••••••••  (set — paste new value to update)" : `${providerLabel} Client Secret`} autoComplete="off" />
                        </label>
                      </div>
                      <p className="ops-oauth-app-creds-note">{integration.oauthAppConfigured ? "App credentials are configured. Leave blank to keep existing." : "Enter your OAuth App credentials to connect."}</p>
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
                          {/* Show blank input — never echo back the stored client_id value from state */}
                          <input
                            value={appClientId}
                            onChange={(e) => setAppClientId(e.target.value)}
                            placeholder={integration.oauthAppConfigured ? "••••••••••••••••  (set — paste new value to update)" : `${providerLabel} Client ID`}
                            autoComplete="off"
                          />
                        </label>
                        <label>
                          <span>Client Secret {integration.oauthAppConfigured ? <span className="ops-oauth-cred-badge ops-oauth-cred-badge-ok">✓ Set</span> : null}</span>
                          <input type="password" value={appClientSecret} onChange={(e) => setAppClientSecret(e.target.value)} placeholder={integration.oauthAppConfigured ? "••••••••••••••••  (set — paste new value to update)" : `${providerLabel} Client Secret`} autoComplete="off" />
                        </label>
                      </div>
                      <p className="ops-oauth-app-creds-note">{integration.oauthAppConfigured ? "App credentials are configured. Leave blank to keep existing." : "Leave blank to use admin-configured credentials."}</p>
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
              /* PAT tab — only shown when user explicitly selects Token (PAT) */
              <div className="ops-edit-cred-pat">
                {integration.authMethod === "oauth" ? (
                  <p className="ops-pat-note">⚠ OAuth is currently active. Save a PAT here if you want to switch to token authentication — then disconnect OAuth.</p>
                ) : null}
                <div className="ops-pat-input-row">
                  <input
                    type="password"
                    value={patDraft}
                    onChange={(e) => setPatDraft(e.target.value)}
                    placeholder={integration.credentialConfigured ? `${providerLabel} personal access token (already set — paste to update)` : `${providerLabel} personal access token`}
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
