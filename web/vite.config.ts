import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const BFF = process.env.BFF_ORIGIN ?? "http://localhost:8080";

export default defineConfig({
  plugins: [
    react(),
    // `injectManifest`, not `generateSW`: a generated service worker has no
    // push/notificationclick listeners at all, and this app sits behind
    // Cloudflare Access, where a top-level navigation must never be served
    // from a cache — it's the only request that can complete an Access
    // re-authentication redirect. sw.ts is hand-written and registers no
    // `fetch` listener, so navigations are never intercepted by construction.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      manifest: false,
      // Registered manually from lib/register-sw.ts, not this plugin's
      // auto-injected script — one registration path, not two.
      injectRegister: false,
      injectManifest: { injectionPoint: "self.__WB_MANIFEST" },
      devOptions: { enabled: true, type: "module" },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BFF, changeOrigin: true },
      "/auth": { target: BFF, changeOrigin: true },
      "/push": { target: BFF, changeOrigin: true },
      "/ws": { target: BFF, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
