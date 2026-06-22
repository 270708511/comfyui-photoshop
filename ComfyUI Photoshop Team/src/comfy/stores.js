import { writable, derived } from "svelte/store";
import { persist } from "$lib/stores/persist.js";
import i18n from "$comfy/i18n/index.js";

function log(...args) {
  console.log("[CPS-DEBUG:stores]", ...args);
}

// ---- Language ----
const LANGUAGES = {
  1: { name: "English", short: "en_US" },
  // TODO: Add zh_CN, zh_TW, ko_KR, ja_JP when translations are ready
};
export const languageList = Object.entries(LANGUAGES).map(([id, val]) => ({
  id,
  ...val,
}));

let detectedLangId = "1";
try {
  if (typeof require === "function") {
    const uxpLocale = require("uxp")?.host?.uiLocale || "en_US";
    const match = Object.entries(LANGUAGES).find(
      ([, v]) => v.short === uxpLocale
    );
    if (match) detectedLangId = match[0];
  }
} catch (_) {}

export const pluginLang = persist("pluginlang", detectedLangId);

// Initialize i18n when language changes
pluginLang.subscribe((id) => {
  const short = LANGUAGES[id]?.short || "en_US";
  i18n.changeLanguage(short);
});

export const t = derived(pluginLang, ($pluginLang) => {
  // Force re-derive when language changes
  const lang = LANGUAGES[$pluginLang]?.short || "en_US";
  i18n.changeLanguage(lang);
  return (key, options) => i18n.t(key, options);
});

// ---- Connection ----
export const ip = persist("ipaddress", "http://127.0.0.1:8188");
export const mode = persist("connectionMode", "local");
export const cloudUrl = persist("cloudUrl", "");
export const cloudUsername = persist("cloudUsername", "");
export const cloudPassword = persist("cloudPassword", "");
export const comfyUser = persist("comfyUser", "default");

// ---- Image Processing ----
export const downScaleIfBigger = persist("downScaleIfBigger", "1024");
export const upScaleIfSmaller = persist("upScaleIfSmaller", "512");
export const fixMaskEdge = persist("fixMaskEdge", true);
export const forceResize = persist("forceResize", false);
export const cropToSelection = persist("cropToSelection", false);
export const cropPadding = persist("cropPadding", "32");
export const renderOnChanges = persist("renderOnChanges", false);

// ---- General Settings ----
export const showNegativeInput = persist("showNegativeInput", false);
export const keepBottomControllerVisible = persist(
  "keepBottomControllerVisible",
  true
);
export const keepEverythingVisible = persist("keepEverythingVisible", true);
export const disableAllAnimations = persist("disableAllAnimations", false);

// ---- AI Panel State ----
export const positivePrompt = persist("positivePrompt", "");
export const negativePrompt = persist("negativePrompt", "");
export const sliderValue = persist("sliderValue", "32");
export const imageMode = persist("imageMode", "cover");
export const autoRandomize = persist("autoRandomize", false);

// ---- Runtime State (not persisted) ----
export const connected = writable(false);
export const connecting = writable(false);
export const progress = writable(0);
export const statusText = writable("Not Connected");
export const statusColor = writable("red");
export const workflowOptions = writable([]);
export const renderModeOptions = writable([]);
export const selectedWorkflow = persist("selectedWorkflow", "");
export const selectedRenderMode = persist("selectedRenderMode", "");

// Plugin version — as a writable store so $pluginVersion works in Svelte
let _pluginVersion = "1.0.0";
try {
  if (typeof require === "function") {
    _pluginVersion = require("uxp")?.versions?.plugin || "1.0.0";
  }
} catch (_) {}
export const pluginVersion = writable(_pluginVersion);

// Debug: log store initialization
log("Stores initialized", {
  pluginVersion: _pluginVersion,
  ip: typeof persist === "function" ? "persist fn ok" : "MISSING",
});
