import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { lovinspPlugin } from "lovinsp";

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: "web",
  // lovinsp goes before the framework plugin; its defaults are Copy Path on Option+Shift, Open in IDE with Command added.
  // It only injects under `vite dev`; LOVINSP=1 also injects into a build, for the :8787 server that serves web/dist.
  plugins: [lovinspPlugin({ bundler: "vite", ...(process.env.LOVINSP === "1" ? { dev: true } : {}) }), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
