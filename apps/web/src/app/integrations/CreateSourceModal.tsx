"use client";

import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useState } from "react";
import type { IntegrationForm } from "./types";
import { normalizeRepositoryInput } from "./types";

type AuthMode = "choose" | "oauth" | "pat";
type OAuthStep = "provider" | "details";
type Provider = "github" | "gitlab" | "googledrive";

// PLATFORM_URL and OAUTH_CALLBACK_BASE are driven by env vars set in .env / .env.production.
// Fallbacks use the /rapidrag path prefix so they're correct even without env vars.
// Dev:  NEXT_PUBLIC_PLATFORM_URL=https://dev.eclassmanager.com/rapidrag
// Prod: NEXT_PUBLIC_PLATFORM_URL=https://theaitools.ca/rapidrag
const PLATFORM_URL = (process.env.NEXT_PUBLIC_PLATFORM_URL ?? "https://dev.eclassmanager.com/rapidrag").replace(/\/$/, "");
const OAUTH_CALLBACK_BASE = (process.env.NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL ?? "https://dev.eclassmanager.com/rapidrag/connect").replace(/\/$/, "");

type ProviderMeta = {
  label: string;
  icon: string;
  scope: string[];
  note: string;
  setupSteps: Array<{ step: number; text: string }>;
  callbackUrl: string;
  homepageUrl: string;
  registrationUrl: string;
};

const PROVIDER_META: Record<Provider, ProviderMeta> = {
  github: {
    label: "GitHub",
    icon: "🐙",
    scope: ["Read access to repositories (repo scope)", "Works for both public and private repos"],
    note: "After clicking \"Create & Connect\" you will be redirected to GitHub to authorise. Once approved, you land back here automatically.",
    callbackUrl: `${OAUTH_CALLBACK_BASE}/oauth/callback/github`,
    homepageUrl: PLATFORM_URL,
    registrationUrl: "https://github.com/settings/applications/new",
    setupSteps: [
      { step: 1, text: "Go to github.com → Settings → Developer Settings → OAuth Apps → New OAuth App" },
      { step: 2, text: `Set Application name to anything (e.g. "RAG Platform")` },
      { step: 3, text: `Set Homepage URL to: ${PLATFORM_URL}` },
      { step: 4, text: `Set Authorization callback URL to: ${OAUTH_CALLBACK_BASE}/oauth/callback/github` },
      { step: 5, text: "Click Register application — copy the Client ID and Client Secret" },
      { step: 6, text: "Paste both values into the fields below ↓" }
    ]
  },
  gitlab: {
    label: "GitLab",
    icon: "🦊",
    scope: ["Read repository contents (read_repository)", "Read API metadata (read_api)"],
    note: "After clicking \"Create & Connect\" you will be redirected to GitLab. Tokens expire every 2 hours and are auto-refreshed by the platform.",
    callbackUrl: `${OAUTH_CALLBACK_BASE}/oauth/callback/gitlab`,
    homepageUrl: PLATFORM_URL,
    registrationUrl: "https://gitlab.com/-/profile/applications",
    setupSteps: [
      { step: 1, text: "Go to gitlab.com → User Settings → Applications (or your self-hosted instance)" },
      { step: 2, text: `Set Name to anything (e.g. "RAG Platform")` },
      { step: 3, text: `Set Redirect URI to: ${OAUTH_CALLBACK_BASE}/oauth/callback/gitlab` },
      { step: 4, text: "Enable scopes: read_repository and read_api" },
      { step: 5, text: "Click Save application — copy the Application ID and Secret" },
      { step: 6, text: "Paste both values into the fields below ↓" }
    ]
  },
  googledrive: {
    label: "Google Drive",
    icon: "📂",
    scope: ["Read-only access to Drive files and folders (drive.readonly)"],
    note: "After clicking \"Create & Connect\" you will be redirected to Google. Tokens are auto-refreshed — no manual renewal needed.",
    callbackUrl: `${OAUTH_CALLBACK_BASE}/oauth/callback/google`,
    homepageUrl: PLATFORM_URL,
    registrationUrl: "https://console.cloud.google.com/apis/credentials",
    setupSteps: [
      { step: 1, text: "Go to console.cloud.google.com → APIs & Services → Credentials" },
      { step: 2, text: "Click Create Credentials → OAuth 2.0 Client ID → Application type: Web application" },
      { step: 3, text: `Add Authorised redirect URI: ${OAUTH_CALLBACK_BASE}/oauth/callback/google` },
      { step: 4, text: "Click Create — copy the Client ID and Client Secret" },
      { step: 5, text: "Also enable the Google Drive API in APIs & Services → Library" },
      { step: 6, text: "Paste both values into the fields below ↓" }
    ]
  }
};

type Props = {
  open: boolean;
  onClose: () => void;
  form: IntegrationForm;
  setForm: Dispatch<SetStateAction<IntegrationForm>>;
  busy: boolean;
  onSubmitPat: () => void;
  onSubmitOauth: (provider: Provider, appCredentials: { clientId: string; clientSecret: string } | null) => void;
};

export function CreateSourceModal(props: Props): ReactElement | null {
  const { open, onClose, form, setForm, busy, onSubmitPat, onSubmitOauth } = props;
  const [mode, setMode] = useState<AuthMode>("choose");
  const [oauthStep, setOauthStep] = useState<OAuthStep>("provider");
  const [oauthProvider, setOauthProvider] = useState<Provider>("github");
  const [appClientId, setAppClientId] = useState("");
  const [appClientSecret, setAppClientSecret] = useState("");

  if (!open) return null;

  function handleClose(): void {
    setMode("choose");
    setOauthStep("provider");
    setAppClientId("");
    setAppClientSecret("");
    onClose();
  }

  function selectProvider(p: Provider): void {
    setOauthProvider(p);
    setForm((c) => ({ ...c, sourceType: p }));
    setOauthStep("details");
  }

  // ── Step 0: choose auth mode ────────────────────────────────────────────────
  if (mode === "choose") {
    return (
      <div className="ops-modal-overlay" role="presentation" onClick={handleClose}>
        <div className="ops-modal-panel ops-modal-narrow" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="ops-modal-panel-header">
            <h2>Connect Knowledge Source</h2>
            <button type="button" className="ops-modal-close" onClick={handleClose} aria-label="Close">×</button>
          </div>
          <p className="ops-modal-lead">How would you like to connect your source?</p>

          <div className="ops-auth-choice-grid">
            <button type="button" className="ops-auth-choice-card ops-auth-choice-oauth" onClick={() => setMode("oauth")}>
              <span className="ops-auth-choice-icon">🔗</span>
              <strong>Connect with OAuth</strong>
              <span>Recommended — no manual tokens. The platform authorises directly with the provider.</span>
              <span className="ops-auth-choice-badge">Recommended</span>
            </button>

            <button type="button" className="ops-auth-choice-card ops-auth-choice-pat" onClick={() => setMode("pat")}>
              <span className="ops-auth-choice-icon">🔑</span>
              <strong>Enter Token (PAT)</strong>
              <span>For self-hosted providers or service accounts. Paste your personal access token.</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── OAuth Step 1: choose provider ───────────────────────────────────────────
  if (mode === "oauth" && oauthStep === "provider") {
    return (
      <div className="ops-modal-overlay" role="presentation" onClick={handleClose}>
        <div className="ops-modal-panel ops-modal-narrow" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="ops-modal-panel-header">
            <h2>Choose Provider</h2>
            <button type="button" className="ops-modal-close" onClick={handleClose} aria-label="Close">×</button>
          </div>
          <p className="ops-modal-lead">Select the source provider you want to connect via OAuth.</p>

          <div className="ops-provider-grid">
            {(Object.keys(PROVIDER_META) as Provider[]).map((p) => (
              <button key={p} type="button" className="ops-provider-card" onClick={() => selectProvider(p)}>
                <span className="ops-provider-icon">{PROVIDER_META[p].icon}</span>
                <strong>{PROVIDER_META[p].label}</strong>
              </button>
            ))}
            <button
              type="button"
              className="ops-provider-card ops-provider-card-web"
              onClick={() => { setForm((c) => ({ ...c, sourceType: "web" })); setMode("pat"); }}
            >
              <span className="ops-provider-icon">🌐</span>
              <strong>Web URL</strong>
              <small>No auth needed</small>
            </button>
          </div>

          <div className="ops-modal-footer-nav">
            <button type="button" className="ops-modal-back-btn" onClick={() => setMode("choose")}>← Back</button>
          </div>
        </div>
      </div>
    );
  }

  // ── OAuth Step 2: source details + instructions ─────────────────────────────
  if (mode === "oauth" && oauthStep === "details") {
    const meta = PROVIDER_META[oauthProvider];
    return (
      <div className="ops-modal-overlay" role="presentation" onClick={handleClose}>
        <div className="ops-modal-panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="ops-modal-panel-header">
            <h2>{meta.icon} Connect {meta.label}</h2>
            <button type="button" className="ops-modal-close" onClick={handleClose} aria-label="Close">×</button>
          </div>

          <div className="ops-oauth-instructions">
            <div className="ops-oauth-setup-section">
              <strong className="ops-oauth-setup-title">One-time setup — register your own OAuth App with {meta.label}</strong>
              <p className="ops-oauth-setup-note">Each user registers their own OAuth App. If you have already done this before, skip to the credentials fields below.</p>
              <ol className="ops-oauth-setup-steps">
                {meta.setupSteps.map(({ step, text }) => (
                  <li key={step}>{text}</li>
                ))}
              </ol>
              <div className="ops-oauth-url-row">
                <span className="ops-oauth-url-label">Homepage URL</span>
                <code className="ops-oauth-url-value">{meta.homepageUrl}</code>
              </div>
              <div className="ops-oauth-url-row">
                <span className="ops-oauth-url-label">Callback URL</span>
                <code className="ops-oauth-url-value">{meta.callbackUrl}</code>
              </div>
              <a className="ops-oauth-register-link" href={meta.registrationUrl} target="_blank" rel="noopener noreferrer">
                Open {meta.label} OAuth registration →
              </a>
            </div>
            <div className="ops-oauth-scope-section">
              <strong>Permissions requested from {meta.label}:</strong>
              <ul>{meta.scope.map((s) => <li key={s}>{s}</li>)}</ul>
              <p className="ops-oauth-note">{meta.note}</p>
            </div>
          </div>

          <div className="integrations-form-grid ops-modal-form">
            <label>
              <span>Name</span>
              <input value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} placeholder="My Ops Docs" />
            </label>

            <label>
              <span>Project Name <small style={{ fontWeight: 400, color: "#64748b" }}>(optional — group multiple sources)</small></span>
              <input value={form.projectName} onChange={(e) => setForm((c) => ({ ...c, projectName: e.target.value }))} placeholder="e.g. Ops Platform, RAG Pipeline" />
            </label>

            <label className="integrations-form-span-2">
              <span>Source URL</span>
              <input
                value={form.sourceUrl}
                onChange={(e) => setForm((c) => ({ ...c, ...normalizeRepositoryInput(e.target.value, c) }))}
                placeholder={oauthProvider === "googledrive" ? "https://drive.google.com/drive/folders/..." : "https://github.com/org/repo"}
              />
            </label>

            {oauthProvider !== "googledrive" && (
              <>
                <label>
                  <span>Branch</span>
                  <input value={form.sourceBranch} onChange={(e) => setForm((c) => ({ ...c, sourceBranch: e.target.value }))} placeholder="main" />
                </label>
                <div className="integrations-form-span-2">
                  <span className="ops-paths-label">Document Paths <small style={{ fontWeight: 400, color: "#64748b" }}>(add multiple paths to index)</small></span>
                  {form.sourcePaths.map((p, idx) => (
                    <div key={idx} className="ops-path-row">
                      <input
                        value={p}
                        onChange={(e) => {
                          const next = [...form.sourcePaths];
                          next[idx] = e.target.value;
                          setForm((c) => ({ ...c, sourcePaths: next }));
                        }}
                        placeholder="docs/"
                      />
                      {form.sourcePaths.length > 1 ? (
                        <button
                          type="button"
                          className="ops-path-remove-btn"
                          onClick={() => setForm((c) => ({ ...c, sourcePaths: c.sourcePaths.filter((_, i) => i !== idx) }))}
                          aria-label="Remove path"
                        >✕</button>
                      ) : null}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="ops-path-add-btn"
                    onClick={() => setForm((c) => ({ ...c, sourcePaths: [...c.sourcePaths, ""] }))}
                  >+ Add another path</button>
                </div>
              </>
            )}

            <label className="integrations-form-span-2">
              <label className="integrations-checkbox">
                <input type="checkbox" checked={form.setDefault} onChange={(e) => setForm((c) => ({ ...c, setDefault: e.target.checked }))} />
                <span>Set as my default Operations AI knowledge base</span>
              </label>
            </label>
          </div>

          <div className="ops-oauth-app-creds">
            <div className="ops-oauth-app-creds-header">
              <strong>Step 6 — {meta.label} OAuth App credentials</strong>
              <span>From the app you just registered. Saved to Vault and reused for all future connections.</span>
            </div>
            <div className="ops-oauth-app-creds-fields">
              <label>
                <span>Client ID</span>
                {/* Use autoComplete="new-password" to prevent ALL browser autofill/password-manager injection.
                    The name attribute is intentionally generic to avoid browser heuristics. */}
                <input
                  id="oauth-app-client-id"
                  name="oauth-app-client-id"
                  value={appClientId}
                  onChange={(e) => setAppClientId(e.target.value)}
                  placeholder={`${meta.label} Client ID`}
                  autoComplete="new-password"
                  data-form-type="other"
                />
              </label>
              <label>
                <span>Client Secret</span>
                <input
                  id="oauth-app-client-secret"
                  name="oauth-app-client-secret"
                  type="password"
                  value={appClientSecret}
                  onChange={(e) => setAppClientSecret(e.target.value)}
                  placeholder={`${meta.label} Client Secret`}
                  autoComplete="new-password"
                  data-form-type="other"
                />
              </label>
            </div>
            <p className="ops-oauth-app-creds-note">
              Already registered your OAuth App previously? Leave these blank to reuse your existing credentials stored in Vault.
            </p>
          </div>

          <div className="ops-modal-footer-nav ops-modal-footer-nav-spread">
            <button type="button" className="ops-modal-back-btn" onClick={() => setOauthStep("provider")}>← Back</button>
            <button
              type="button"
              className="integrations-primary-button sync-btn-ready"
              onClick={() => void onSubmitOauth(oauthProvider, appClientId.trim() || appClientSecret.trim() ? { clientId: appClientId.trim(), clientSecret: appClientSecret.trim() } : null)}
              disabled={busy || !form.name.trim() || !form.sourceUrl.trim()}
            >
              {busy ? "Creating…" : `Create & Connect ${meta.label} →`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── PAT form ─────────────────────────────────────────────────────────────────
  return (
    <div className="ops-modal-overlay" role="presentation" onClick={handleClose}>
      <div className="ops-modal-panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ops-modal-panel-header">
          <h2>Connect Source — Enter Token</h2>
          <button type="button" className="ops-modal-close" onClick={handleClose} aria-label="Close">×</button>
        </div>
        <p className="ops-modal-lead">Fill in the source details and paste your personal access token.</p>

        <div className="integrations-form-grid ops-modal-form">
          <label>
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} placeholder="My Ops Docs" />
          </label>

          <label>
            <span>Project Name <small style={{ fontWeight: 400, color: "#64748b" }}>(optional — group sources)</small></span>
            <input value={form.projectName} onChange={(e) => setForm((c) => ({ ...c, projectName: e.target.value }))} placeholder="e.g. Ops Platform" />
          </label>

          <label>
            <span>Source Type</span>
            <select value={form.sourceType} onChange={(e) => setForm((c) => ({ ...c, sourceType: e.target.value as IntegrationForm["sourceType"] }))}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="googledrive">Google Drive</option>
              <option value="web">Web</option>
            </select>
          </label>

          <label className="integrations-form-span-2">
            <span>Source URL</span>
            <input
              value={form.sourceUrl}
              onChange={(e) => setForm((c) => ({ ...c, ...normalizeRepositoryInput(e.target.value, c) }))}
              placeholder="Repository URL, Drive folder URL, or website URL"
            />
          </label>

          {form.sourceType !== "web" && (
            <>
              <label>
                <span>Branch</span>
                <input value={form.sourceBranch} onChange={(e) => setForm((c) => ({ ...c, sourceBranch: e.target.value }))} placeholder="main" />
              </label>
              <div className="integrations-form-span-2">
                <span className="ops-paths-label">Document Paths <small style={{ fontWeight: 400, color: "#64748b" }}>(add multiple paths to index)</small></span>
                {form.sourcePaths.map((p, idx) => (
                  <div key={idx} className="ops-path-row">
                    <input
                      value={p}
                      onChange={(e) => {
                        const next = [...form.sourcePaths];
                        next[idx] = e.target.value;
                        setForm((c) => ({ ...c, sourcePaths: next }));
                      }}
                      placeholder="docs/"
                    />
                    {form.sourcePaths.length > 1 ? (
                      <button
                        type="button"
                        className="ops-path-remove-btn"
                        onClick={() => setForm((c) => ({ ...c, sourcePaths: c.sourcePaths.filter((_, i) => i !== idx) }))}
                        aria-label="Remove path"
                      >✕</button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="ops-path-add-btn"
                  onClick={() => setForm((c) => ({ ...c, sourcePaths: [...c.sourcePaths, ""] }))}
                >+ Add another path</button>
              </div>
            </>
          )}

          {form.sourceType === "github" && (
            <label className="integrations-form-span-2">
              <span>GitHub Personal Access Token</span>
              <input type="password" value={form.githubToken} onChange={(e) => setForm((c) => ({ ...c, githubToken: e.target.value }))} placeholder="Optional for public repositories" />
            </label>
          )}

          {form.sourceType === "gitlab" && (
            <label className="integrations-form-span-2">
              <span>GitLab Access Token</span>
              <input type="password" value={form.gitlabToken} onChange={(e) => setForm((c) => ({ ...c, gitlabToken: e.target.value }))} placeholder="GitLab private token" />
            </label>
          )}

          {form.sourceType === "googledrive" && (
            <>
              <label>
                <span>Access Token</span>
                <input type="password" value={form.googleDriveAccessToken} onChange={(e) => setForm((c) => ({ ...c, googleDriveAccessToken: e.target.value }))} placeholder="OAuth access token" />
              </label>
              <label>
                <span>Refresh Token</span>
                <input type="password" value={form.googleDriveRefreshToken} onChange={(e) => setForm((c) => ({ ...c, googleDriveRefreshToken: e.target.value }))} placeholder="OAuth refresh token" />
              </label>
            </>
          )}
        </div>

        <div className="integrations-panel-footer ops-modal-footer">
          <div className="integrations-footer-copy">
            <label className="integrations-checkbox">
              <input type="checkbox" checked={form.setDefault} onChange={(e) => setForm((c) => ({ ...c, setDefault: e.target.checked }))} />
              <span>Set as my default Operations AI knowledge base</span>
            </label>
          </div>
          <div className="ops-modal-footer-nav-spread" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" className="ops-modal-back-btn" onClick={() => setMode("choose")}>← Back</button>
            <button type="button" className="integrations-primary-button sync-btn-ready" onClick={() => void onSubmitPat()} disabled={busy}>
              {busy ? "Saving…" : "Connect Source"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
