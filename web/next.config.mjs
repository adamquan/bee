/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` keeps the Docker runtime image small — no node_modules copy.
  output: "standalone",
  // better-sqlite3 is a native addon; it must not be bundled by Turbopack/webpack.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
