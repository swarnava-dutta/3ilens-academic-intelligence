import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The client demo runs on `next dev` (start.bat): hide the route-indicator bubble.
  // Compile and runtime errors are still shown.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
