import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Resume parsing libraries use Node built-ins / pdfjs worker loading, so keep
  // them out of the server bundle and load them at runtime from node_modules.
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
