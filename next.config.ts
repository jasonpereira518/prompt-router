import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  // PDF.js loads its worker and native polyfills dynamically; standalone tracing cannot discover them.
  outputFileTracingIncludes: {
    "/api/*": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
  },
  serverExternalPackages: ["mammoth", "pdfjs-dist"],
  experimental: { proxyClientMaxBodySize: "30mb" },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};
export default config;
