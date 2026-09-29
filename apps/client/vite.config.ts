import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const proxyTarget = env.VITE_PROXY_TARGET || "http://127.0.0.1:8787";

  const proxy = {
    "/api": {
      target: proxyTarget,
      changeOrigin: true,
      ws: true,
    },
    "/health": {
      target: proxyTarget,
      changeOrigin: true,
    },
  };

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy,
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      proxy,
    },
  };
});
