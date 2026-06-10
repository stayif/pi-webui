import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const SERVER_PORT = process.env.PI_WEBUI_PORT ?? process.env.PORT ?? "9529";
const target = `http://127.0.0.1:${SERVER_PORT}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Share the server's wire-protocol types with the web app without a
      // separate package. Type-only import, erased at build time.
      "@protocol": fileURLToPath(new URL("../server/src/protocol.ts", import.meta.url)),
    },
  },
  server: {
    port: 9527,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/ws": { target, ws: true },
    },
  },
});
