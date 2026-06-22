import "./app.css";
import App from "./App.svelte";

const DEBUG = true;
function log(...args) {
  if (DEBUG) console.log("[CPS-DEBUG]", ...args);
}

log("=== ComfyUI Photoshop Svelte Plugin ===");
log("main.js: starting...");

let app;

try {
  const target = document.getElementById("app");
  log("main.js: app target", target);

  app = new App({
    target,
  });

  log("main.js: App mounted successfully!", app);
} catch (e) {
  console.error("[CPS-ERROR] main.js failed:", e, e?.stack);
}

// Expose globally for UXP debugging
if (typeof globalThis !== "undefined") {
  globalThis.__CPS_APP = app;
}
