/** @type {import('next').NextConfig} */
const nextConfig = {
  // Served at root / on the dedicated rapidrag.ai domain.
  // Do NOT set trailingSlash: true — that would 308-redirect POST /api/ routes
  // and break authentication.

  output: 'standalone',

  experimental: {
    optimizePackageImports: ["@platform/ui-kit"]
  }
};

export default nextConfig;
