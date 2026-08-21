import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BFF = process.env.BFF_ORIGIN ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BFF, changeOrigin: true },
      "/auth": { target: BFF, changeOrigin: true },
      "/ws": { target: BFF, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
