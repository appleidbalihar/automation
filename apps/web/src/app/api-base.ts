export function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (configured) {
    if (typeof window !== "undefined") {
      const host = window.location.hostname.trim().toLowerCase();
      const isRemoteHost = host.length > 0 && host !== "localhost" && host !== "127.0.0.1";
      if (isRemoteHost && /localhost|127\.0\.0\.1/i.test(configured)) {
        return "/gateway";
      }
    }
    return configured.replace(/\/+$/, "");
  }
  return "/gateway";
}
