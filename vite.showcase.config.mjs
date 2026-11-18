import { mergeConfig } from "vite";
import app from "./vite.config.mjs";

// Publish only this static directory, never the local manager or its API.
export default mergeConfig(app, {
  base: "./",
  build: { outDir: "artifacts/showcase" },
  plugins: [{
    name: "offline-showcase",
    transformIndexHtml() {
      return [{ tag: "meta", attrs: {
        "http-equiv": "Content-Security-Policy",
        content: "connect-src 'none'; form-action 'none'; object-src 'none'; img-src 'self' data:; base-uri 'none'",
      }, injectTo: "head-prepend" }];
    },
  }],
});
