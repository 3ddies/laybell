/** @type {import('next').NextConfig} */
const nextConfig = {
  // Plain <img> everywhere (no next/image optimizer) so this ports cleanly to
  // Cloudflare Pages later without image-optimization config.
  reactStrictMode: true,
};
export default nextConfig;
