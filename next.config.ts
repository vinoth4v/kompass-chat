import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This app lives in a subdirectory of the kompass monorepo, which has its
  // own root pnpm-lock.yaml — pin the trace root here so Next.js doesn't try
  // to infer it (and warn) from the parent lockfile.
  outputFileTracingRoot: path.join(__dirname),

  // `webpack` comes from the context arg: Next bundles its own copy, and there
  // is no top-level `webpack` package installed to import.
  webpack: (config, { isServer, webpack }) => {
    if (isServer) return config;

    // Document generation runs entirely in the browser — nothing is uploaded.
    // But exceljs and pptxgenjs ship isomorphic builds that reference `node:fs`
    // and `node:https`, and webpack 5 refuses the `node:` scheme outright
    // rather than consulting resolve.fallback. Rewriting the scheme away lets
    // the fallbacks below apply; both libraries feature-detect and use their
    // browser paths, so the stubs are never called.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
        resource.request = resource.request.replace(/^node:/, '');
      }),
    );
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      https: false,
      http: false,
      stream: false,
      zlib: false,
    };
    return config;
  },
};

export default nextConfig;
