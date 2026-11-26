import type { NextConfig } from "next";

// The settings a new create-next-app starts with. CI builds this app, which
// fails if the SDK makes a page block prerendering under Cache Components.
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
