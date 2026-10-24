import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  server: {
    port: 1421,
    strictPort: true,
    proxy: {
      "/arxiv": {
        target: "https://arxiv.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/arxiv/, ""),
        headers: { "User-Agent": "arxiv-reader/0.1 (personal desktop reader; https://github.com/YazidJanati/arxiv)" },
      },
    },
  },
  build: { target: "es2022" },
});
