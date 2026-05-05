"use client";

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useRouter } from "next/navigation";
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
  const [username, setUsername] = useState<string>("platform-admin");
  const [password, setPassword] = useState<string>("admin123");
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
    <main className="login-shell">
      <section className="login-card">
        <h1>{mode === "login" ? "Sign in to RapidRAG" : "Create your RapidRAG account"}</h1>
        <p>
          {mode === "login"
            ? "Sign in to access your knowledge bases, integrations, and AI chatbots."
            : "Create your account to get started. Your user will be provisioned automatically."}
        </p>
        <div className="integration-tabs">
          <button type="button" className={mode === "login" ? "tab-active" : ""} onClick={() => setMode("login")}>
            Sign In
          </button>
          <button type="button" className={mode === "register" ? "tab-active" : ""} onClick={() => setMode("register")}>
            Register
          </button>
        </div>
        <div className="login-form">
          <label htmlFor="login-username">Username</label>
          <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          {mode === "register" ? (
            <>
              <label htmlFor="register-email">Email</label>
              <input id="register-email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
              <label htmlFor="register-first-name">First Name</label>
              <input id="register-first-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} autoComplete="given-name" />
              <label htmlFor="register-last-name">Last Name</label>
              <input id="register-last-name" value={lastName} onChange={(event) => setLastName(event.target.value)} autoComplete="family-name" />
            </>
          ) : null}
        </div>
        <div className="login-actions">
          <button type="button" onClick={() => (mode === "login" ? signIn() : register()).catch(() => undefined)} disabled={submitting}>
            {submitting ? (mode === "login" ? "Signing In..." : "Registering...") : mode === "login" ? "Sign In" : "Register"}
          </button>
        </div>
        {status ? <p className="ops-status-line">{status}</p> : null}
        {error ? <p className="ops-error">{error}</p> : null}
      </section>
    </main>
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
