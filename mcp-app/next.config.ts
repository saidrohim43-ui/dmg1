import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // نقطة MCP على /mcp كما في المواصفة — التوجيه إلى مسار Pages API المضيف لكائنات Node الأصلية
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
};

export default nextConfig;
