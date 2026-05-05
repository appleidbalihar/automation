"use client";

import { resolveApiBase } from "./api-base";

export const TOKEN_STORAGE_KEY = "ops_bearer_token";
const REFRESH_TOKEN_STORAGE_KEY = "ops_refresh_token";
const TOKEN_EXPIRES_AT_STORAGE_KEY = "ops_token_expires_at";
export const AUTH_SESSION_CLEARED_EVENT = "rapidrag:auth-session-cleared";

export function normalizeToken(input: string): string {
  return input.trim().replace(/^Bearer\s+/i, "");
}

export function readStoredToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export function saveStoredToken(token: string, refreshToken?: string, expiresIn?: number): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeToken(token);
  if (!normalized) {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(TOKEN_STORAGE_KEY, normalized);
  if (refreshToken !== undefined) {
    const normalizedRefresh = normalizeToken(refreshToken);
    if (normalizedRefresh) window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, normalizedRefresh);
    else window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  }
  if (expiresIn && expiresIn > 0) {
    window.localStorage.setItem(TOKEN_EXPIRES_AT_STORAGE_KEY, String(Date.now() + expiresIn * 1000));
  }
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(TOKEN_EXPIRES_AT_STORAGE_KEY);
  window.dispatchEvent(new Event(AUTH_SESSION_CLEARED_EVENT));
}

export function authHeaderFromStoredToken(): string | undefined {
  const token = readStoredToken();
  if (!token.trim()) return undefined;
  return `Bearer ${normalizeToken(token)}`;
}

async function refreshStoredToken(): Promise<string | undefined> {
  if (typeof window === "undefined") return undefined;
  const refreshToken = window.localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) ?? "";
  if (!refreshToken.trim()) return undefined;
  const response = await fetch("/api/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: normalizeToken(refreshToken) }),
    cache: "no-store"
  });
  const payload = (await response.json().catch(() => ({}))) as {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  if (!response.ok || !payload.accessToken) {
    clearStoredToken();
    return undefined;
  }
  saveStoredToken(payload.accessToken, payload.refreshToken, payload.expiresIn);
  return authHeaderFromStoredToken();
}

export async function authHeaderFromStoredTokenOrRefresh(forceRefresh = false): Promise<string | undefined> {
  const authHeader = authHeaderFromStoredToken();
  if (typeof window === "undefined") return authHeader;
  const expiresAt = Number(window.localStorage.getItem(TOKEN_EXPIRES_AT_STORAGE_KEY) ?? "0");
  if (forceRefresh || !authHeader || (expiresAt > 0 && Date.now() > expiresAt - 30000)) {
    return refreshStoredToken();
  }
  return authHeader;
}

export async function fetchIdentity(): Promise<{ userId: string; roles: string[] }> {
  let authHeader = await authHeaderFromStoredTokenOrRefresh();
  if (!authHeader) {
    throw new Error("UNAUTHENTICATED");
  }
  let response = await fetch(`${resolveApiBase()}/auth/me`, {
    headers: { authorization: authHeader }
  });
  if (response.status === 401 || response.status === 403) {
    authHeader = await authHeaderFromStoredTokenOrRefresh(true);
    if (authHeader) {
      response = await fetch(`${resolveApiBase()}/auth/me`, {
        headers: { authorization: authHeader }
      });
    }
  }
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403 ? "UNAUTHENTICATED" : `AUTH_CHECK_FAILED:${response.status}`);
  }
  return (await response.json()) as { userId: string; roles: string[] };
}
