/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev-only: allow the preview/embedded browser to reach dev resources (HMR,
  // fonts) when the app is opened via 127.0.0.1 — without this, Next 16 blocks
  // the origin and the page never hydrates.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Route handlers already declare `export const dynamic = 'force-dynamic'`;
  // keep static assets fast while never caching API responses.
  poweredByHeader: false,
  images: {
    // Uploaded WebP evidence lives under /uploads (served as static files).
    unoptimized: true,
  },
};

module.exports = nextConfig;
