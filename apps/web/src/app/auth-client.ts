"use client";

import { resolveApiBase } from "./api-base";

export const TOKEN_STORAGE_KEY = "ops_bearer_token";

export function normalizeToken(input: string): string {
  return input.trim().replace(/^Bearer\s+/i, "");
}

export function readStoredToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export function saveStoredToken(token: string): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeToken(token);
  if (!normalized) {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(TOKEN_STORAGE_KEY, normalized);
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function authHeaderFromStoredToken(): string | undefined {
  const token = readStoredToken();
  if (!token.trim()) return undefined;
  return `Bearer ${normalizeToken(token)}`;
}

export async function fetchIdentity(): Promise<{ userId: string; roles: string[] }> {
  const authHeader = authHeaderFromStoredToken();
  if (!authHeader) {
    throw new Error("UNAUTHENTICATED");
  }
  const response = await fetch(`${resolveApiBase()}/auth/me`, {
    headers: { authorization: authHeader }
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403 ? "UNAUTHENTICATED" : `AUTH_CHECK_FAILED:${response.status}`);
  }
  return (await response.json()) as { userId: string; roles: string[] };
}
