"use client";

import { useRouter } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import { AUTH_SESSION_CLEARED_EVENT, clearStoredToken, fetchIdentity, saveStoredToken } from "./auth-client";

interface Identity {
  userId: string;
  roles: string[];
}

function LoginPanel({
  onSignedIn
}: {
  onSignedIn: (identity: Identity) => void;
}): ReactElement {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  async function signIn(): Promise<void> {
    setSubmitting(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const payload = (await response.json()) as {
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        error?: string;
        details?: string;
      };
      if (!response.ok || !payload.accessToken) {
        setError(payload.details ?? payload.error ?? "Login failed");
        return;
      }
      saveStoredToken(payload.accessToken, payload.refreshToken, payload.expiresIn);
      const identity = await fetchIdentity();
      onSignedIn(identity);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Login request failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function register(): Promise<void> {
    setSubmitting(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          email,
          firstName,
          lastName
        })
      });
      const payload = (await response.json()) as { created?: boolean; error?: string; details?: string };
      if (!response.ok || !payload.created) {
        setError(payload.details ?? payload.error ?? "Registration failed");
        return;
      }
      setStatus("Registration successful. Signing in...");
      await signIn();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Registration request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rr-auth-page">
    <main className="rr-auth-shell">
      {/* Left panel */}
      <div className="rr-auth-left">
        <div className="rr-auth-left-inner">
          <div className="rr-auth-logo">
            <span className="rr-logo-mark">R</span>
            <span>RapidRAG</span>
          </div>
          <div className="rr-auth-welcome-badge">● WELCOME BACK</div>
          <h2 className="rr-auth-left-headline">
            Your knowledge,<br /><span className="rr-auth-left-accent">instant answers.</span>
          </h2>
          <p className="rr-auth-left-sub">
            Sign in to manage your knowledge bases, monitor chatbots, and connect new sources across Slack, Telegram, and WhatsApp.
          </p>
          <ul className="rr-auth-features">
            <li><span className="rr-auth-check">✓</span> 20+ connectors — GitHub, Drive, Notion, Confluence</li>
            <li><span className="rr-auth-check">✓</span> Encryption at rest, role-based access, full audit logs</li>
            <li><span className="rr-auth-check">✓</span> Bring your own LLM key — no vendor lock-in</li>
          </ul>
        </div>
      </div>

      {/* Right panel */}
      <div className="rr-auth-right">
        <div className="rr-auth-form-wrap">
          <h1 className="rr-auth-title">{mode === "login" ? "Sign in to RapidRAG" : "Create your account"}</h1>
          <p className="rr-auth-subtitle">
            {mode === "login"
              ? "Access your knowledge bases, integrations, and AI chatbots."
              : "Create your account to get started. Your user will be provisioned automatically."}
          </p>

          <div className="rr-auth-tabs">
            <button type="button" className={mode === "login" ? "rr-auth-tab rr-auth-tab-active" : "rr-auth-tab"} onClick={() => setMode("login")}>
              Sign In
            </button>
            <button type="button" className={mode === "register" ? "rr-auth-tab rr-auth-tab-active" : "rr-auth-tab"} onClick={() => setMode("register")}>
              Register
            </button>
          </div>

          <div className="rr-auth-divider"><span>OR WITH EMAIL</span></div>

          {/*
            Security: autoComplete="off" + data-form-type="other" + name attrs that don't
            match browser heuristics prevent password managers from injecting saved credentials.
          */}
          <form
            autoComplete="off"
            onSubmit={(e) => { e.preventDefault(); (mode === "login" ? signIn() : register()).catch(() => undefined); }}
            className="rr-auth-form"
          >
            <input type="text" name="prevent_autofill" style={{ display: "none" }} readOnly tabIndex={-1} aria-hidden="true" />
            <input type="password" name="prevent_autofill_pw" style={{ display: "none" }} readOnly tabIndex={-1} aria-hidden="true" />

            <div className="rr-auth-field">
              <label htmlFor="login-username">USERNAME</label>
              <div className="rr-auth-input-wrap">
                <span className="rr-auth-input-icon">👤</span>
                <input
                  id="login-username"
                  name="rapidrag-user"
                  placeholder="your.username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                />
              </div>
            </div>

            <div className="rr-auth-field">
              <label htmlFor="login-password">PASSWORD</label>
              <div className="rr-auth-input-wrap">
                <span className="rr-auth-input-icon">🔒</span>
                <input
                  id="login-password"
                  name="rapidrag-secret"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                />
              </div>
            </div>

            {mode === "register" ? (
              <>
                <div className="rr-auth-field">
                  <label htmlFor="register-email">EMAIL</label>
                  <div className="rr-auth-input-wrap">
                    <span className="rr-auth-input-icon">✉️</span>
                    <input id="register-email" name="rapidrag-email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" data-form-type="other" />
                  </div>
                </div>
                <div className="rr-auth-name-row">
                  <div className="rr-auth-field">
                    <label htmlFor="register-first-name">FIRST NAME</label>
                    <input id="register-first-name" name="rapidrag-fname" placeholder="Jane" value={firstName} onChange={(event) => setFirstName(event.target.value)} autoComplete="off" data-form-type="other" />
                  </div>
                  <div className="rr-auth-field">
                    <label htmlFor="register-last-name">LAST NAME</label>
                    <input id="register-last-name" name="rapidrag-lname" placeholder="Smith" value={lastName} onChange={(event) => setLastName(event.target.value)} autoComplete="off" data-form-type="other" />
                  </div>
                </div>
              </>
            ) : null}

            <button type="submit" className="rr-auth-submit" disabled={submitting}>
              {submitting
                ? (mode === "login" ? "Signing In..." : "Registering...")
                : mode === "login" ? "Sign in →" : "Create account →"}
            </button>
          </form>

          {status ? <p className="rr-auth-status">{status}</p> : null}
          {error ? <p className="rr-auth-error">{error}</p> : null}

          {mode === "login" ? (
            <p className="rr-auth-switch">
              New to RapidRAG?{" "}
              <button type="button" className="rr-auth-switch-link" onClick={() => setMode("register")}>
                Create an account
              </button>
            </p>
          ) : (
            <p className="rr-auth-switch">
              Already have an account?{" "}
              <button type="button" className="rr-auth-switch-link" onClick={() => setMode("login")}>
                Sign in
              </button>
            </p>
          )}

          <p className="rr-auth-terms">
            By continuing, you agree to RapidRAG&apos;s Terms and Privacy Policy
          </p>
        </div>
      </div>
    </main>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<"checking" | "signed-in" | "signed-out">("checking");
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    let mounted = true;
    function handleSessionCleared(): void {
      if (!mounted) return;
      setIdentity(null);
      setStatus("signed-out");
    }
    window.addEventListener(AUTH_SESSION_CLEARED_EVENT, handleSessionCleared);
    fetchIdentity()
      .then((result) => {
        if (!mounted) return;
        setIdentity(result);
        setStatus("signed-in");
      })
      .catch(() => {
        if (!mounted) return;
        clearStoredToken();
        setIdentity(null);
        setStatus("signed-out");
      });
    return () => {
      mounted = false;
      window.removeEventListener(AUTH_SESSION_CLEARED_EVENT, handleSessionCleared);
    };
  }, []);

  if (status === "checking") {
    return (
      <main className="login-shell">
        <section className="login-card">
          <h1>RapidRAG</h1>
          <p>Validating session...</p>
        </section>
      </main>
    );
  }

  if (status === "signed-out") {
    return (
      <LoginPanel
        onSignedIn={(result) => {
          setIdentity(result);
          setStatus("signed-in");
        }}
      />
    );
  }

  return (
    <>
      <div className="session-banner">
        Signed in as <strong>{identity?.userId ?? "unknown"}</strong> ({(identity?.roles ?? []).join(", ") || "viewer"})
        <button
          type="button"
          onClick={() => {
            clearStoredToken();
            setIdentity(null);
            setStatus("signed-out");
            router.refresh();
          }}
        >
          Sign Out
        </button>
      </div>
      {children}
    </>
  );
}
