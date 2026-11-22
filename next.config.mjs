/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: no `output: 'export'` — the app needs API routes
  // (/api/tts runs on the server), so Vercel runs it as a normal
  // Next.js app, not a static export.
  images: { unoptimized: true },
  // @xenova/transformers pulls in large onnxruntime-web assets; keep the
  // static export working by not inlining them.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      'onnxruntime-node$': false,
    };
    return config;
  },
};

export default nextConfig;
