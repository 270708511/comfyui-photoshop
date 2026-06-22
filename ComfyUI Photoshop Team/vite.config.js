import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import fs from "fs";

// UXP 不支持 ES module，构建后去除 type="module"
function fixUxpHtml() {
  return {
    name: "fix-uxp-html",
    closeBundle() {
      const distDir = path.resolve(__dirname, "dist");
      const htmlPath = path.join(distDir, "index.html");
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, "utf-8");
        // 去掉 type="module"
        html = html.replace(/\s+type="module"/g, "");
        // 去掉 crossorigin 属性
        html = html.replace(/\s+crossorigin/g, "");
        fs.writeFileSync(htmlPath, html);
      }
      // 复制 Updater 脚本
      const srcCp = path.resolve(__dirname, "../Install_Plugin/3e6d64e0/cp");
      const dstCp = path.join(distDir, "cp");
      if (fs.existsSync(srcCp) && !fs.existsSync(dstCp)) {
        fs.cpSync(srcCp, dstCp, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [svelte(), fixUxpHtml()],
  base: "/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        format: "iife",
        entryFileNames: "assets/index-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  resolve: {
    alias: {
      "$lib": path.resolve("./src/lib"),
      "$comfy": path.resolve("./src/comfy"),
    },
  },
});
