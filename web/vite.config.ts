import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Preview only: never proxy owner APIs or credentials to the private listener.
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    outDir: "../dist/owner-ui",
    // Root build owns cleanup; don't remove the backend or sibling artifacts.
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        preview: fileURLToPath(new URL("./index.html", import.meta.url)),
        owner: fileURLToPath(new URL("./owner.html", import.meta.url)),
      },
    },
  },
});
