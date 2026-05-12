"use client";

import { useEffect, useState, type ReactElement } from "react";
import {
  activateSlackDeployment,
  createSlackDeployment,
  fetchKnowledgeBases,
  fetchSlackDeployments,
  startSlackOAuthConnect,
  validateSlackToken
} from "./api";
import type { RagKnowledgeBaseOption, SlackDeployment } from "./types";

interface Props {
  existing?: SlackDeployment | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ConnectSlackWizard({ existing, onClose, onSaved }: Props): ReactElement {
  const [deployment, setDeployment] = useState<SlackDeployment | null>(existing ?? null);
  const [installMode, setInstallMode] = useState<"oauth" | "manual">(existing?.installMode ?? "oauth");
  const [deploymentName, setDeploymentName] = useState(existing?.deploymentName ?? "Slack KB Bot");
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [workspaceName, setWorkspaceName] = useState(existing?.slackWorkspaceName ?? "");
  const [kbs, setKbs] = useState<RagKnowledgeBaseOption[]>([]);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>(existing?.kbMappings.map((kb) => kb.knowledgeBaseId) ?? []);
  const [accessMode, setAccessMode] = useState<"channel" | "allowlist">(existing?.accessMode ?? "channel");
  const [allowedSlackUserIds, setAllowedSlackUserIds] = useState((existing?.allowedSlackUserIds ?? []).join("\n"));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(installMode === "manual");

  useEffect(() => {
    fetchKnowledgeBases().then(setKbs).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function ensureDeployment(): Promise<SlackDeployment> {
    if (deployment && deployment.installMode === installMode) return deployment;
    const created = await createSlackDeployment(deploymentName, installMode);
    setDeployment(created);
    return created;
  }

  async function connectOAuth(): Promise<void> {
    setError(null);
    setMessage(null);
    const current = await ensureDeployment();
    try {
      const response = await startSlackOAuthConnect(current.id);
      const popup = window.open(response.url, "rapidrag-slack-oauth", "popup,width=720,height=840");
      if (!popup) {
        window.location.href = response.url;
        return;
      }
      setMessage("Slack authorization opened in a popup. After approving RapidRAG Bot, this wizard will fill the workspace automatically.");
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        fetchSlackDeployments()
          .then((rows) => {
            const updated = rows.find((row) => row.id === current.id);
            if (updated?.slackWorkspaceName) {
              window.clearInterval(timer);
              popup.close();
              setDeployment(updated);
              setWorkspaceName(updated.slackWorkspaceName ?? "");
              setMessage(`Connected to ${updated.slackWorkspaceName}. Select the knowledge bases this bot can answer from.`);
            } else if (Date.now() - startedAt > 120000 || popup.closed) {
              window.clearInterval(timer);
              setMessage("Slack authorization is not complete yet. If you approved the app, close and reopen this wizard or click Add RapidRAG Bot again.");
            }
          })
          .catch(() => undefined);
      }, 2500);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`${detail}. Configure real Slack OAuth credentials in Vault at platform/global/slack/oauth, or switch install mode to Advanced: own Slack app.`);
    }
  }

  async function validateManual(): Promise<void> {
    setError(null);
    setMessage(null);
    const info = await validateSlackToken(botToken);
    setWorkspaceName(info.workspaceName);
    setMessage(`Connected to ${info.workspaceName}`);
  }

  async function activate(): Promise<void> {
    setError(null);
    setMessage(null);
    const current = await ensureDeployment();
    const saved = await activateSlackDeployment(current.id, {
      ...(installMode === "manual" ? { botToken, signingSecret } : {}),
      knowledgeBaseIds,
      accessMode,
      allowedSlackUserIds: allowedSlackUserIds.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    });
    setDeployment(saved);
    setMessage(`Activated. Webhook: ${saved.webhookUrl ?? "configured"}`);
    onSaved();
  }

  function copyText(value: string): void {
    navigator.clipboard?.writeText(value).catch(() => undefined);
  }

  function buildUserInstructions(): string {
    const botName = installMode === "manual" ? (deploymentName.trim() || "your company Slack bot") : "RapidRAG Bot";
    const workspaceLine = workspaceName.trim()
      ? `Open Slack in the ${workspaceName.trim()} workspace.`
      : "Open Slack in the workspace where the bot is installed.";
    return [
      `You have been granted access to the ${botName} Slack knowledge base bot.`,
      "",
      "How to use it:",
      `1. ${workspaceLine}`,
      `2. Search for "${botName}" in Slack.`,
      "3. Open a direct message with the bot.",
      "4. Send: /kb list",
      "5. To choose a knowledge base, send: /kb use <name>",
      "6. Then ask your question in the same DM.",
      "",
      "If Slack says you are not authorized, reply with your Slack member ID so access can be checked.",
      "To copy your Slack member ID:",
      "Open your Slack profile -> More -> Copy member ID."
    ].join("\n");
  }

  const manualWebhookUrl = deployment?.webhookUrl ?? "Create or save this deployment first to generate the manual webhook URL.";
  const requiredScopes = "chat:write, commands, im:history";
  const userInstructions = buildUserInstructions();

  return (
    <div className="ops-modal-overlay" role="presentation" onClick={onClose}>
      <div className="ops-modal-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="ops-modal-panel-header">
          <h2>{existing ? "Manage Slack Deployment" : "Connect Slack"}</h2>
          <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="ops-modal-form">
          <div className="integrations-form-grid">
            <label>Deployment name<input value={deploymentName} onChange={(event) => setDeploymentName(event.target.value)} /></label>
            <label>Workspace
              <input value={workspaceName} readOnly placeholder={installMode === "oauth" ? "Filled after Add RapidRAG Bot" : "Filled after token validation"} />
            </label>
          </div>
          <p className="ops-modal-lead">
            A deployment is a Slack bot connected to selected knowledge bases. The workspace is read from Slack; you do not type it manually.
          </p>
          <ol>
            <li>Name this deployment.</li>
            <li>Add RapidRAG Bot to Slack, or open Advanced to use your own company bot.</li>
            <li>Confirm the workspace.</li>
            <li>Select knowledge bases.</li>
            <li>Choose access and activate.</li>
          </ol>
          {installMode === "oauth" ? (
            <button type="button" onClick={() => connectOAuth().catch((err) => setError(err instanceof Error ? err.message : String(err)))}>Add RapidRAG Bot to Slack</button>
          ) : null}
          <button
            type="button"
            className="ops-modal-back-btn"
            onClick={() => {
              const next = !advancedOpen;
              setAdvancedOpen(next);
              setInstallMode(next ? "manual" : "oauth");
            }}
          >
            {advancedOpen ? "Use RapidRAG Bot instead" : "Advanced: use your own Slack app"}
          </button>
          {advancedOpen ? (
            <section className="ops-card">
              <h3>Own company bot setup</h3>
              <ol>
                <li>Go to api.slack.com/apps.</li>
                <li>Click Create New App, then choose From scratch.</li>
                <li>Enter an app name, for example eclass-bot, and select your workspace.</li>
                <li>Go to OAuth &amp; Permissions → Scopes → Bot Token Scopes, then add: {requiredScopes}.</li>
                <li>Do not use App-Level Tokens for this flow.</li>
                <li>Go to App Home, turn on the Messages Tab, and check "Allow users to send Slash commands and messages from the messages tab".</li>
                <li>Enable Event Subscriptions and use the webhook URL below.</li>
                <li>After Slack shows Verified, click Add Bot User Event, add message.im, then click Save Changes.</li>
                <li>Create slash command /kb using the same URL. The command name and usage hint are RapidRAG platform commands and should be the same for every bot.</li>
                <li>Install the app to your workspace.</li>
                <li>Copy Bot User OAuth Token from OAuth &amp; Permissions → OAuth Tokens.</li>
                <li>Copy Signing Secret from Basic Information → App Credentials.</li>
              </ol>
              <button type="button" onClick={() => ensureDeployment().then((row) => setMessage(`Manual setup URL ready: ${row.webhookUrl}`)).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                Generate setup URLs
              </button>
              <div className="integrations-form-grid">
                <label>Required scopes<input readOnly value={requiredScopes} /></label>
                <button type="button" onClick={() => copyText(requiredScopes)}>Copy scopes</button>
                <label>Event and slash command URL<input readOnly value={manualWebhookUrl} /></label>
                <button type="button" onClick={() => copyText(manualWebhookUrl)}>Copy URL</button>
                <label>Usage hint<input readOnly value="[list | use <name> | all | status | help]" /></label>
                <button type="button" onClick={() => copyText("[list | use <name> | all | status | help]")}>Copy hint</button>
                <label>Bot token<input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} /></label>
                <label>Signing secret<input type="password" value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} /></label>
              </div>
              <button type="button" onClick={() => validateManual().catch((err) => setError(err instanceof Error ? err.message : String(err)))}>Validate token</button>
            </section>
          ) : null}
          <fieldset>
            <legend>Knowledge bases</legend>
            {kbs.map((kb) => (
              <label key={kb.id}>
                <input type="checkbox" checked={knowledgeBaseIds.includes(kb.id)} onChange={(event) => setKnowledgeBaseIds((current) => event.target.checked ? [...current, kb.id] : current.filter((id) => id !== kb.id))} />
                {kb.name}
              </label>
            ))}
          </fieldset>
          <label>Access
            <select value={accessMode} onChange={(event) => setAccessMode(event.target.value as "channel" | "allowlist")}>
              <option value="channel">All Slack users in workspace</option>
              <option value="allowlist">Allowlist</option>
            </select>
          </label>
          {accessMode === "allowlist" ? (
            <section className="ops-card">
              <label>Slack user IDs<textarea value={allowedSlackUserIds} onChange={(event) => setAllowedSlackUserIds(event.target.value)} placeholder="One Slack user ID per line" /></label>
              <p className="ops-modal-lead">
                RapidRAG does not send Slack invites in Phase 1. Copy these instructions and send them to users manually by email, Slack, or your internal onboarding process.
              </p>
              <label>User instructions<textarea readOnly value={userInstructions} /></label>
              <button type="button" onClick={() => {
                copyText(userInstructions);
                setMessage("User instructions copied.");
              }}>
                Copy user instructions
              </button>
            </section>
          ) : null}
          {message ? <p>{message}</p> : null}
          {error ? <p className="ops-log-drawer-error">{error}</p> : null}
          {deployment?.status === "active" ? (
            <section className="ops-card">
              <h3>Next steps in Slack</h3>
              <p>Open Slack, find {installMode === "manual" ? "your company bot" : "RapidRAG Bot"}, send a direct message, or run /kb list.</p>
            </section>
          ) : null}
        </div>
        <div className="ops-modal-footer-nav ops-modal-footer-nav-spread">
          <button type="button" className="ops-modal-back-btn" onClick={onClose}>Close</button>
          <button type="button" onClick={() => activate().catch((err) => setError(err instanceof Error ? err.message : String(err)))} disabled={knowledgeBaseIds.length === 0}>Activate</button>
        </div>
      </div>
    </div>
  );
}
