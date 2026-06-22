// Simple i18n module — no external dependency
// Avoids i18next's .split() crash in UXP environment

const en_US = {
  sponsoredBy: "Sponsored By",
  title: "PHOTOSHOP<br />to COMFYUI",
  buyACoffee: "Buy a Coffee \u2615",
  version: "Version {{version}} - By NimaNzrii",
  getStarted: "Get Started",
  requestFeatures: "\uD83D\uDE80 Request New Features!",
  haveAnIdea: "Have an idea?",
  reportBugs: "\uD83D\uDC1B Report Bugs Here!",
  report: "Report",
  collaborate: "\uD91E\uDD25 Collaborate With Us!",
  collab: "Collab",
  modalTitle: "Let's Collaborate!",
  modalDescription: "If you'd like to collaborate, feel free to reach out via email anytime.",
  emailMe: "Email Me:",
  preset: "Preset",
  positivePrompt: "Positive Prompt:",
  negativePrompt: "Negative Prompt:",
  sliderValue: "Slider Value",
  randomize: "Randomize",
  ipAddress: "IP Address",
  reset: "Reset",
  apply: "Apply",
  imageProcessing: "Image Processing",
  downScaleIfBigger: "DownScale if Bigger:",
  upScaleIfSmaller: "Upscale if Smaller:",
  fixMaskEdge: "Fix Mask Edge (feather mask)",
  forceResize: "Force resize layer to match document dimensions",
  cropPadding: "Crop Padding (%):",
  paddingInfo: "(set padding in settings)",
  general: "General",
  showNegativeInput: "Show Negative Prompt in AI Panel",
  keepBottomControllerVisible: "Keep Bottom Controller Visible",
  keepEverythingVisible: "Keep Everything Visible (requires reload)",
  disableAllAnimations: "Disable All Animations",
  reloadPlugin: "Reload Plugin",
  logs: "Logs",
  renderOnPSChanges: "Render On PS Changes",
  cropToSelectionArea: "Crop to Selection Area.\n(set padding in settings)",
  randomizeHint: "\uD83D\uDCB1 R-Click: Randomize",
  render: "Render",
  addToLayer: "Add to Layer",
  clickEmptyArea: "click empty Area",
  install: "Install",
  newFeatures: "Added New Features!",
  installHint: "\u2728 DO IT!",
  workflow: "Workflow",
  renderMode: "Render Mode",
  renderOnChanges: "Render On Changes",
  prompt: "Prompt",
  autoRandomizeHint: "\uD83D\uDD04 Auto Randomize each time",
  panelTitle: "ComfyUI Photoshop Plugin Panel",
  saveAsPng: "Save as PNG",
  connect: "Connect",
  sendLatestImgAndMask: "Send Latest IMG & MASK etc to comfy",
  comfyUIIP: "ComfyUI IP Address",
  resetStatus: "make it empty to reset",
  downscaleIfBigger: "DownScale if Bigger",
  upscaleIfSmaller: "Upscale if Smaller",
  enabled: "is enabled.",
};

const translations = { en_US };

let _currentLang = "en_US";

function t(key, options) {
  let text = translations[_currentLang]?.[key] || translations.en_US[key] || key;
  // Interpolate {{variable}} placeholders (e.g., {{version}})
  if (options && typeof text === "string") {
    Object.keys(options).forEach((k) => {
      text = text.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), options[k]);
    });
  }
  return text;
}

function changeLanguage(lang) {
  if (translations[lang]) {
    _currentLang = lang;
  }
}

export default {
  t,
  changeLanguage,
  language: _currentLang,
};
