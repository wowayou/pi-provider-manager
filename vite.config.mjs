import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageManifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageManifest.version),
    __PI_VALIDATED_VERSION__: JSON.stringify(packageManifest.piValidatedVersion),
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "@phosphor-icons/react"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "localhost", "127.0.0.1"],
    proxy: {
      // changeOrigin rewrites Host to the target, so proxied dev requests satisfy
      // the API's host allowlist regardless of which name the browser used.
      "/api": { target: "http://127.0.0.1:43121", changeOrigin: true },
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
