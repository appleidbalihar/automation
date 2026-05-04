/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serve the app under /rapidrag/ in both dev and production.
  // In dev:  https://dev.eclassmanager.com/rapidrag/
  // In prod: https://theaitools.ca/rapidrag/
  // The outer nginx strips nothing — Next.js handles the prefix itself.
  basePath: "/rapidrag",
  assetPrefix: "/rapidrag",

  // Do NOT set trailingSlash: true — that would 308-redirect POST /api/ routes
  // and break authentication. The trailing-slash redirect for the root page
  // (/rapidrag/ → /rapidrag) is handled cleanly by the outer nginx rewrite.

  experimental: {
    optimizePackageImports: ["@platform/ui-kit"]
  }
};

export default nextConfig;
