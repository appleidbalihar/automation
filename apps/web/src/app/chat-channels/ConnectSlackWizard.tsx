"use client";

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  activateSlackDeployment,
  createSlackDeployment,
  fetchKnowledgeBases,
  fetchSharedSlackDeployments,
  getSlackIdentityOAuthUrl,
  getSlackInstallUrl,
  updateSlackDeployment,
  validateSlackToken
} from "./api";
import type { RagKnowledgeBaseOption, SlackDeployment } from "./types";

type WizardMode = "choose" | "use-existing" | "create-own";

interface Props {
  existing?: SlackDeployment | null;
  connectTo?: SlackDeployment | null;
  onClose: () => void;
  onSaved: () => void;
}

function friendlyError(raw: string): string {
  if (raw.includes("SLACK_WORKSPACE_ALREADY_ACTIVE"))
    return 'A bot is already active for this Slack workspace. Use "Use existing shared bot" to connect to it instead.';
  if (raw.includes("ACTIVATION_FIELDS_REQUIRED"))
    return "Please select at least one knowledge base before activating.";
  if (raw.includes("INVALID_SLACK_BOT_TOKEN"))
    return "The bot token is invalid. Check it in your Slack app's OAuth & Permissions page.";
  if (raw.includes("MANUAL_SLACK_SECRETS_REQUIRED"))
    return "Bot token and signing secret are both required.";
  if (raw.includes("SLACK_OAUTH_INSTALL_REQUIRED"))
    return "OAuth install is required before activation. Re-open the OAuth flow.";
  return raw;
}

function KbMultiSelect({ kbs, selected, onChange }: { kbs: RagKnowledgeBaseOption[]; selected: string[]; onChange: (ids: string[]) => void }): ReactElement {
  return (
    <fieldset className="tpl-form-field">
      <legend>Knowledge bases</legend>
      {kbs.length === 0 && <p className="tpl-hint">No knowledge bases available.</p>}
      {kbs.map((kb) => (
        <label key={kb.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={selected.includes(kb.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, kb.id] : selected.filter((id) => id !== kb.id))}
          />
          {kb.name}
          {kb.ownerUsername ? <span className="tpl-badge tpl-badge-category">{kb.ownerUsername}</span> : null}
        </label>
      ))}
    </fieldset>
  );
}

function CopyRow({ label, value, placeholder }: { label: string; value: string; placeholder?: string }): ReactElement {
  function copyText(): void {
    navigator.clipboard?.writeText(value).catch(() => undefined);
  }
  return (
    <div className="tpl-form-field" style={{ marginBottom: 6 }}>
      {label && <label style={{ fontSize: 12, color: "#64748b" }}>{label}</label>}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="tpl-input"
          readOnly
          value={value || placeholder || ""}
          style={{ fontFamily: "monospace", fontSize: 12, background: value ? "#f8fafc" : "#f1f5f9", color: value ? "#0f172a" : "#94a3b8" }}
        />
        {value && (
          <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost" onClick={copyText}>Copy</button>
        )}
      </div>
    </div>
  );
}

// ── Use Existing Shared Bot ────────────────────────────────────────────────────

function UseExistingFlow({ preselected, onClose }: { preselected?: SlackDeployment | null; onClose: () => void }): ReactElement {
  const [sharedBots, setSharedBots] = useState<SlackDeployment[]>([]);
  const [selectedBot, setSelectedBot] = useState<SlackDeployment | null>(preselected ?? null);
  const [kbs, setKbs] = useState<RagKnowledgeBaseOption[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<"select" | "install" | "identity">(preselected ? "install" : "select");
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchSharedSlackDeployments(), fetchKnowledgeBases()])
      .then(([bots, myKbs]) => { setSharedBots(bots); setKbs(myKbs); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // When bot is selected, load its install URL
  async function handleBotSelect(bot: SlackDeployment): Promise<void> {
    setSelectedBot(bot);
    setError(null);
    try {
      const result = await getSlackInstallUrl(bot.id);
      setInstallUrl(result.installAvailable && result.url ? result.url : null);
    } catch {
      setInstallUrl(null);
    }
    setPhase("install");
  }

  async function handleConnectViaSlack(): Promise<void> {
    if (!selectedBot) return;
    setError(null);
    if (selectedKbIds.length === 0 && selectedBot.requireUserVerification) {
      setError("Select at least one knowledge base.");
      return;
    }
    setRedirecting(true);
    try {
      const result = await getSlackIdentityOAuthUrl(selectedBot.id, selectedKbIds);
      if (result.oauthAvailable && result.url) {
        window.location.href = result.url;
      } else {
        setError("OAuth not available for this bot. Contact the bot owner to add Client ID and Secret.");
        setRedirecting(false);
      }
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
      setRedirecting(false);
    }
  }

  // Phase: select bot
  if (phase === "select") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="tpl-form-field">
          <label>Available shared bots</label>
          {sharedBots.length === 0 && <p className="tpl-hint">No shared bots are available to you yet. Ask an admin to share one.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sharedBots.map((bot) => (
              <label key={bot.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: `1px solid ${selectedBot?.id === bot.id ? "#10b981" : "#e2e8f0"}`, borderRadius: 8, cursor: "pointer", background: selectedBot?.id === bot.id ? "#f0fdf4" : "white" }}>
                <input type="radio" name="shared-bot" checked={selectedBot?.id === bot.id} onChange={() => handleBotSelect(bot).catch(() => undefined)} />
                <div>
                  <strong>{bot.deploymentName}</strong>
                  {bot.slackWorkspaceName && <span style={{ marginLeft: 8, color: "#64748b", fontSize: 13 }}>{bot.slackWorkspaceName}</span>}
                  <span className={`tpl-badge ${bot.requireUserVerification ? "tpl-badge-category" : "tpl-badge-shared"}`} style={{ marginLeft: 8 }}>
                    {bot.requireUserVerification ? "Verified 🔒" : "Open 🌐"}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>
        {error && <p className="tpl-error">{error}</p>}
        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  // Phase: install bot to Slack workspace
  if (phase === "install") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="ops-card" style={{ background: "#f8fafc" }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{selectedBot?.deploymentName}</p>
          {selectedBot?.slackWorkspaceName && <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>{selectedBot.slackWorkspaceName}</p>}
        </div>

        <div className="ops-card">
          <p style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 14 }}>Step 1 — Add bot to your Slack workspace</p>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#64748b" }}>
            Click the button below to install the bot into your Slack workspace. If it&apos;s already installed, click Skip.
          </p>
          {installUrl ? (
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              className="ops-btn ops-btn-primary"
              style={{ display: "inline-block", textDecoration: "none" }}
            >
              Add to Slack ↗
            </a>
          ) : (
            <p className="tpl-hint">Install link not available. The bot may already be in your workspace — proceed to the next step.</p>
          )}
        </div>

        {error && <p className="tpl-error">{error}</p>}

        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-secondary" onClick={() => setPhase("select")}>← Back</button>
          <button type="button" className="ops-btn ops-btn-primary" onClick={() => setPhase("identity")}>
            {installUrl ? "Already added / Next →" : "Next →"}
          </button>
        </div>
      </div>
    );
  }

  // Phase: link Slack identity
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="ops-card" style={{ background: "#f8fafc" }}>
        <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{selectedBot?.deploymentName}</p>
        {selectedBot?.slackWorkspaceName && <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>{selectedBot.slackWorkspaceName}</p>}
      </div>

      {selectedBot && !selectedBot.requireUserVerification ? (
        <div className="ops-card" style={{ background: "#f0fdf4", border: "1px solid #6ee7b7" }}>
          <p style={{ margin: 0 }}>This bot is <strong>open access</strong>. Anyone with the app installed can message it — no registration needed.</p>
        </div>
      ) : (
        <>
          <div className="ops-card">
            <p style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 14 }}>Step 2 — Link your Slack identity</p>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: "#64748b" }}>
              Sign in with Slack so RapidRAG can identify you when you message the bot.
            </p>
            <KbMultiSelect kbs={kbs} selected={selectedKbIds} onChange={setSelectedKbIds} />
          </div>
          {error && <p className="tpl-error">{error}</p>}
          <div className="ops-modal-footer">
            <button type="button" className="ops-btn ops-btn-secondary" onClick={() => setPhase("install")}>← Back</button>
            <button
              type="button"
              className="ops-btn ops-btn-primary"
              disabled={redirecting}
              onClick={() => handleConnectViaSlack().catch(() => undefined)}
            >
              {redirecting ? "Redirecting…" : "Connect via Slack →"}
            </button>
          </div>
        </>
      )}
      {selectedBot && !selectedBot.requireUserVerification && (
        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-secondary" onClick={() => setPhase("install")}>← Back</button>
          <button type="button" className="ops-btn ops-btn-primary" onClick={onClose}>Done</button>
        </div>
      )}
    </div>
  );
}

// ── Create Own Bot ─────────────────────────────────────────────────────────────

function CreateOwnBotFlow({ existing, onClose, onSaved }: { existing?: SlackDeployment | null; onClose: () => void; onSaved: () => void }): ReactElement {
  // Pre-generate a UUID so the webhook URL is known before any DB write
  const webhookId = useMemo(() => existing?.id ?? crypto.randomUUID(), [existing?.id]);
  const webhookUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/api/slack/events/${webhookId}`;
  }, [webhookId]);

  const [deploymentName, setDeploymentName] = useState(existing?.deploymentName ?? "Slack KB Bot");
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [workspaceName, setWorkspaceName] = useState(existing?.slackWorkspaceName ?? "");
  const [kbs, setKbs] = useState<RagKnowledgeBaseOption[]>([]);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>(existing?.kbMappings.map((kb) => kb.knowledgeBaseId) ?? []);
  const [shareScope, setShareScope] = useState<"private" | "all" | "specific">(existing?.shareScope ?? "private");
  const [requireUserVerification, setRequireUserVerification] = useState(existing?.requireUserVerification ?? true);
  const [defaultKbIds, setDefaultKbIds] = useState<string[]>(existing?.defaultKbIds ?? []);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    fetchKnowledgeBases().then(setKbs).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function handleValidate(): Promise<void> {
    setError(null);
    setValidating(true);
    try {
      const info = await validateSlackToken(botToken);
      setWorkspaceName(info.workspaceName);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setValidating(false);
    }
  }

  // Save settings only (no credentials) — for already-active bots
  async function handleSaveSettings(): Promise<void> {
    if (!existing?.id) return;
    setError(null);
    setSaving(true);
    try {
      const activationKbIds = requireUserVerification ? knowledgeBaseIds : defaultKbIds;
      if (activationKbIds.length === 0) {
        setError("Select at least one knowledge base.");
        setSaving(false);
        return;
      }
      await updateSlackDeployment(existing.id, {
        deploymentName,
        knowledgeBaseIds: requireUserVerification ? knowledgeBaseIds : [],
        defaultKbIds: requireUserVerification ? [] : defaultKbIds,
        requireUserVerification,
        shareScope,
        sharedWithUserIds: []
      });
      onSaved();
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      const activationKbIds = requireUserVerification ? knowledgeBaseIds : defaultKbIds;
      if (activationKbIds.length === 0) {
        setError("Select at least one knowledge base.");
        setSaving(false);
        return;
      }

      let deploymentId = existing?.id;
      if (!deploymentId) {
        const created = await createSlackDeployment(deploymentName, "manual", webhookId);
        deploymentId = created.id;
      }

      await activateSlackDeployment(deploymentId, {
        botToken,
        signingSecret,
        clientId,
        clientSecret,
        knowledgeBaseIds: requireUserVerification ? knowledgeBaseIds : [],
        defaultKbIds: requireUserVerification ? [] : defaultKbIds,
        requireUserVerification,
        shareScope,
        sharedWithUserIds: [],
        accessMode: "channel"
      });

      setActivated(true);
      onSaved();
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  const requiredScopes = "chat:write, commands, im:history";
  const slashHint = "[list | use <name> | all | status | help]";

  // ── Phase 2 success screen (shown after activation) ──────────────────────────
  if (activated) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="ops-card" style={{ background: "#f0fdf4", border: "1px solid #6ee7b7" }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600, color: "#065f46" }}>✓ Bot activated! Complete the final steps in Slack:</p>
        </div>

        <div className="ops-card">
          <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600 }}>Your webhook URL</p>
          <CopyRow label="" value={webhookUrl} />
          <ol style={{ margin: "12px 0 0", paddingLeft: 20, fontSize: 13, lineHeight: "1.9" }}>
            <li>Go to your Slack app → <strong>Event Subscriptions</strong> → toggle <strong>Enable Events</strong> on.</li>
            <li>Paste the webhook URL above as the <strong>Request URL</strong>. Wait until Slack shows <strong>Verified ✓</strong>.</li>
            <li>Under <strong>Subscribe to bot events</strong> → <strong>Add Bot User Event</strong> → add <code>message.im</code>.</li>
            <li>Click <strong>Save Changes</strong>. If Slack prompts you to reinstall, click <strong>Reinstall App</strong>.</li>
          </ol>
        </div>

        <p style={{ fontSize: 13, color: "#64748b" }}>
          Your bot is now live. You can find the webhook URL anytime by clicking <strong>View</strong> on the bot card.
        </p>

        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  const isEditingActive = !!(existing?.status === "active");

  // ── Edit settings form (active bot — no credentials needed) ──────────────────
  if (isEditingActive) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="tpl-form-field">
          <label>Deployment name</label>
          <input className="tpl-input" value={deploymentName} onChange={(e) => setDeploymentName(e.target.value)} />
        </div>

        <div className="tpl-form-field">
          <label>Share with RapidRAG users</label>
          <select className="tpl-select" value={shareScope} onChange={(e) => setShareScope(e.target.value as "private" | "all" | "specific")}>
            <option value="private">Private (only me)</option>
            <option value="all">All RapidRAG users</option>
            <option value="specific">Specific users</option>
          </select>
          {shareScope === "all" && <p className="tpl-hint">Any RapidRAG user will see this bot in the "Use existing shared bot" list.</p>}
          {shareScope === "specific" && <p className="tpl-hint">Specific user sharing — add users from the Members panel.</p>}
        </div>

        <label className="tpl-checkbox-label" style={{ gap: 10 }}>
          <input type="checkbox" checked={requireUserVerification} onChange={(e) => setRequireUserVerification(e.target.checked)} />
          <div>
            <strong>Require Slack user verification</strong>
            <p className="tpl-hint" style={{ margin: "2px 0 0" }}>
              {requireUserVerification
                ? "Each user must register their Slack ID and select their KBs. Responses are isolated per user."
                : "Open access — any Slack user who messages this bot gets answers from the default KBs below."}
            </p>
          </div>
        </label>

        {requireUserVerification ? (
          <KbMultiSelect kbs={kbs} selected={knowledgeBaseIds} onChange={setKnowledgeBaseIds} />
        ) : (
          <div className="tpl-form-field">
            <label>Default KBs (served to all Slack users)</label>
            <KbMultiSelect kbs={kbs} selected={defaultKbIds} onChange={setDefaultKbIds} />
          </div>
        )}

        {error && <p className="tpl-error">{error}</p>}

        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="ops-btn ops-btn-primary" disabled={saving} onClick={() => handleSaveSettings().catch((err) => setError(friendlyError(err instanceof Error ? err.message : String(err))))}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    );
  }

  // ── Creation / activation form ─────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="tpl-form-field">
        <label>Deployment name</label>
        <input className="tpl-input" value={deploymentName} onChange={(e) => setDeploymentName(e.target.value)} placeholder="e.g. Company Slack Bot" />
      </div>

      {/* Always-visible webhook URL */}
      <div style={{ background: "#f0fdf4", border: "1px solid #6ee7b7", borderRadius: 8, padding: "10px 14px" }}>
        <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600 }}>Your webhook URL (unique to this bot)</p>
        <CopyRow label="" value={webhookUrl} />
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "#047857" }}>You will need this URL in steps 5 and after activation.</p>
      </div>

      {/* Phase 1 steps — do these in Slack before entering credentials below */}
      <div className="ops-card">
        <h3 style={{ marginTop: 0, marginBottom: 10, fontSize: 14 }}>Step 1 — Set up your Slack app</h3>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>Complete these steps in Slack, then come back to fill in the credentials below.</p>
        <ol style={{ margin: "0 0 12px 0", paddingLeft: 20, fontSize: 13, lineHeight: "1.9" }}>
          <li>Go to <strong>api.slack.com/apps</strong> → <strong>Create New App</strong> → choose <strong>From scratch</strong>.</li>
          <li>Enter an app name (e.g. <em>RapidRAG Bot</em>) and select your Slack workspace → <strong>Create App</strong>.</li>
          <li>Go to <strong>OAuth &amp; Permissions → Scopes → Bot Token Scopes</strong> and add:</li>
        </ol>
        <CopyRow label="Required scopes" value={requiredScopes} />
        <ol start={4} style={{ margin: "8px 0 12px 0", paddingLeft: 20, fontSize: 13, lineHeight: "1.9" }}>
          <li>Go to <strong>App Home</strong> → <strong>Show Tabs</strong> → enable <strong>Messages Tab</strong> and check<br />
            <em>"Allow users to send Slash commands and messages from the messages tab."</em>
          </li>
          <li>Go to <strong>Slash Commands</strong> → <strong>Create New Command</strong> and fill in (use your webhook URL above):</li>
        </ol>
        <CopyRow label="Command" value="/kb" />
        <CopyRow label="Request URL" value={webhookUrl} />
        <CopyRow label="Short description" value="Query RapidRAG knowledge bases" />
        <CopyRow label="Usage hint" value={slashHint} />
        <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 10px" }}>Leave "Escape channels, users, and links" unchecked → Save.</p>
        <ol start={6} style={{ margin: "0 0 4px 0", paddingLeft: 20, fontSize: 13, lineHeight: "1.9" }}>
          <li>Go to <strong>Event Subscriptions</strong> → toggle <strong>Enable Events</strong> on → paste the webhook URL above as the <strong>Request URL</strong> → wait for <strong>Verified ✓</strong>.</li>
        </ol>
        <p style={{ fontSize: 12, color: "#64748b", margin: "2px 0 6px 20px" }}>
          Under <strong>Subscribe to bot events</strong> → click <strong>Add Bot User Event</strong> → search and add <code>message.im</code> → click <strong>Save Changes</strong>. If Slack prompts to reinstall, do so.
        </p>
        <ol start={7} style={{ margin: "0 0 4px 0", paddingLeft: 20, fontSize: 13, lineHeight: "1.9" }}>
          <li>Go to <strong>OAuth &amp; Permissions → Redirect URLs</strong> → click <strong>Add New Redirect URL</strong> and enter:</li>
        </ol>
        <CopyRow label="Redirect URL" value={`${typeof window !== "undefined" ? window.location.origin : ""}/api/slack/oauth/callback`} />
        <ol start={8} style={{ margin: "8px 0 12px 0", paddingLeft: 20, fontSize: 13, lineHeight: "1.9" }}>
          <li>Click <strong>Save URLs</strong>, then go to <strong>Install App</strong> → <strong>Install to Workspace</strong> → <strong>Allow</strong>.</li>
          <li>Go to <strong>OAuth &amp; Permissions → OAuth Tokens</strong> → copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>).</li>
          <li>Go to <strong>Basic Information → App Credentials</strong> → copy the <strong>Signing Secret</strong>.</li>
          <li>Copy <strong>Client ID</strong> and <strong>Client Secret</strong> from the same page — <strong>required</strong> for users to install this bot and link their Slack identity.</li>
        </ol>
        <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
          <strong>Note:</strong> Do not use App-Level Tokens or Socket Mode — RapidRAG uses the Bot User OAuth Token.
        </p>
      </div>

      {/* Credentials form */}
      <div className="ops-card">
        <h3 style={{ marginTop: 0, marginBottom: 10, fontSize: 14 }}>Step 2 — Enter credentials &amp; activate</h3>
        <div className="tpl-form-row" style={{ gap: 12 }}>
          <div className="tpl-form-field tpl-form-field-grow">
            <label>Bot token</label>
            <input className="tpl-input" type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="xoxb-…" />
          </div>
          <div className="tpl-form-field tpl-form-field-grow">
            <label>Signing secret</label>
            <input className="tpl-input" type="password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} placeholder="From Basic Information" />
          </div>
        </div>
        <div className="tpl-form-row" style={{ gap: 12 }}>
          <div className="tpl-form-field tpl-form-field-grow">
            <label>Client ID <span style={{ color: "#dc2626" }}>*</span></label>
            <input className="tpl-input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="From Basic Information → App Credentials" />
          </div>
          <div className="tpl-form-field tpl-form-field-grow">
            <label>Client secret <span style={{ color: "#dc2626" }}>*</span></label>
            <input className="tpl-input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="From Basic Information → App Credentials" />
          </div>
        </div>
        <p className="tpl-hint" style={{ marginTop: 0 }}>Client ID and Secret are required — they allow users to install the bot to their Slack workspace and link their Slack identity.</p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
          <button type="button" className="ops-btn ops-btn-sm ops-btn-secondary" onClick={() => handleValidate().catch((err) => setError(friendlyError(err instanceof Error ? err.message : String(err))))} disabled={validating || !botToken}>
            {validating ? "Validating…" : "Validate token"}
          </button>
          {workspaceName && <span style={{ color: "#059669", fontWeight: 600, fontSize: 13 }}>✓ {workspaceName}</span>}
        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid #e2e8f0" }} />

      <div className="tpl-form-field">
        <label>Share with RapidRAG users</label>
        <select className="tpl-select" value={shareScope} onChange={(e) => setShareScope(e.target.value as "private" | "all" | "specific")}>
          <option value="private">Private (only me)</option>
          <option value="all">All RapidRAG users</option>
          <option value="specific">Specific users</option>
        </select>
        {shareScope === "all" && <p className="tpl-hint">Any RapidRAG user will see this bot in the "Use existing shared bot" list.</p>}
        {shareScope === "specific" && <p className="tpl-hint">Specific user sharing — add users from the Members panel after activation.</p>}
      </div>

      <label className="tpl-checkbox-label" style={{ gap: 10 }}>
        <input
          type="checkbox"
          checked={requireUserVerification}
          onChange={(e) => setRequireUserVerification(e.target.checked)}
        />
        <div>
          <strong>Require Slack user verification</strong>
          <p className="tpl-hint" style={{ margin: "2px 0 0" }}>
            {requireUserVerification
              ? "Each user must register their Slack ID and select their KBs. Responses are isolated per user."
              : "Open access — any Slack user who messages this bot gets answers from the default KBs below. No registration needed."}
          </p>
        </div>
      </label>

      {requireUserVerification ? (
        <KbMultiSelect kbs={kbs} selected={knowledgeBaseIds} onChange={setKnowledgeBaseIds} />
      ) : (
        <div className="tpl-form-field">
          <label>Default KBs (served to all Slack users)</label>
          <KbMultiSelect kbs={kbs} selected={defaultKbIds} onChange={setDefaultKbIds} />
        </div>
      )}

      {error && <p className="tpl-error">{error}</p>}

      <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
        After activating, you will be guided to complete Event Subscriptions in Slack (step 3).
      </p>

      <div className="ops-modal-footer">
        <button type="button" className="ops-btn ops-btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="ops-btn ops-btn-primary" onClick={() => handleActivate().catch((err) => setError(friendlyError(err instanceof Error ? err.message : String(err))))} disabled={saving || !botToken || !signingSecret || !clientId || !clientSecret}>
          {saving ? "Activating…" : "Save & Activate"}
        </button>
      </div>
    </div>
  );
}

// ── Main Wizard ────────────────────────────────────────────────────────────────

export function ConnectSlackWizard({ existing, connectTo, onClose, onSaved }: Props): ReactElement {
  const [mode, setMode] = useState<WizardMode>(existing ? "create-own" : connectTo ? "use-existing" : "choose");

  return (
    <div className="ops-modal-overlay" role="presentation" onClick={onClose}>
      <div className="ops-modal-panel" role="dialog" aria-modal="true" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <div className="ops-modal-panel-header">
          <h2>{existing ? "Manage Slack Deployment" : "Connect Slack"}</h2>
          <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ops-modal-form" style={{ gap: 16 }}>
          {mode === "choose" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p className="ops-modal-lead">How would you like to connect to Slack?</p>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer" }}>
                <input type="radio" name="wizard-mode" style={{ marginTop: 3 }} onChange={() => setMode("use-existing")} />
                <div>
                  <strong>Use an existing shared bot</strong>
                  <p className="tpl-hint" style={{ margin: "4px 0 0" }}>Connect to a bot created by your admin. Your Slack messages will route to your own knowledge bases.</p>
                </div>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer" }}>
                <input type="radio" name="wizard-mode" style={{ marginTop: 3 }} onChange={() => setMode("create-own")} />
                <div>
                  <strong>Create my own bot</strong>
                  <p className="tpl-hint" style={{ margin: "4px 0 0" }}>Register your own Slack app with a bot token. You control which KBs are served and who can use it.</p>
                </div>
              </label>
              <div className="ops-modal-footer">
                <button type="button" className="ops-btn ops-btn-secondary" onClick={onClose}>Cancel</button>
              </div>
            </div>
          )}

          {mode === "use-existing" && <UseExistingFlow preselected={connectTo} onClose={onClose} />}
          {mode === "create-own" && <CreateOwnBotFlow existing={existing} onClose={onClose} onSaved={onSaved} />}
        </div>
      </div>
    </div>
  );
}
