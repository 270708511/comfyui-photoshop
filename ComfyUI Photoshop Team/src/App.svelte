<script>
  import { onMount } from "svelte";
  import AIPanel from "./panels/AIPanel.svelte";
  import SettingsPanel from "./panels/SettingsPanel.svelte";
  import WebPanel from "./panels/WebPanel.svelte";

  function log(...args) {
    console.log("[CPS-DEBUG:App]", ...args);
  }

  onMount(() => {
    log("App onMount - checking uxp-panel elements");
    const panels = document.querySelectorAll("uxp-panel");
    log(`Found ${panels.length} uxp-panel elements`);
    panels.forEach((p, i) => {
      const panelId = p.getAttribute("panelid") || p.id || "no id";
      log(`  Panel ${i}: id="${panelId}" clientRect:`, {
        width: p.clientWidth,
        height: p.clientHeight,
        offsetWidth: p.offsetWidth,
        offsetHeight: p.offsetHeight,
        scrollWidth: p.scrollWidth,
        scrollHeight: p.scrollHeight,
        display: getComputedStyle(p).display,
        visibility: getComputedStyle(p).visibility,
        overflow: getComputedStyle(p).overflow,
        innerHTML_len: p.innerHTML ? p.innerHTML.length : 0,
      });
    });
    // Log the #app container (mount target)
    const appEl = document.getElementById("app");
    if (appEl) {
      log("App #app mount target:", {
        width: appEl.clientWidth,
        height: appEl.clientHeight,
        childCount: appEl.children.length,
        childTags: Array.from(appEl.children).map(c => c.tagName + (c.getAttribute("panelid") ? `#${c.getAttribute("panelid")}` : "")),
      });
    }
  });
</script>

<!-- NO wrapper div — uxp-panel elements are direct children of #app mount target -->
<uxp-panel panelid="comfyui.ps.svelte.panel">
  <AIPanel />
</uxp-panel>

<uxp-panel panelid="comfyui.ps.svelte.settings">
  <SettingsPanel />
</uxp-panel>

<uxp-panel panelid="comfyui.ps.svelte.web">
  <WebPanel />
</uxp-panel>

<style>
  /* These are injected as scoped but we need them global — use app.css instead */
</style>
