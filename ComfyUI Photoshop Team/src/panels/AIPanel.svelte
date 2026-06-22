<script>
  import { onMount, afterUpdate } from "svelte";
  import gsap from "gsap";
  // ... (rest of imports)

  function log(...args) {
    console.log("[CPS-DEBUG:AIPanel]", ...args);
  }

  onMount(() => {
    log("onMount - stores check:", { ip: $ip, sliderValue: $sliderValue });
  });
  import Button from "$lib/components/Button.svelte";
  import SVGIcon from "$lib/components/SVGIcon.svelte";
  import ProgressBar from "$lib/components/ProgressBar.svelte";
  import TextField from "$lib/components/TextField.svelte";
  import Dropdown from "$lib/components/Dropdown.svelte";
  import SectionHeader from "$lib/components/SectionHeader.svelte";
  import {
    t, ip, connected, connecting, progress, statusText, statusColor,
    positivePrompt, negativePrompt, sliderValue, imageMode,
    autoRandomize, showNegativeInput, keepBottomControllerVisible,
    keepEverythingVisible, disableAllAnimations, workflowOptions,
    renderModeOptions, selectedWorkflow, selectedRenderMode,
    renderOnChanges, cropToSelection,
  } from "$comfy/stores.js";
  import { connect, send, setOnMessage } from "$comfy/core/ws.js";
  import { render, setWorkflow, setRenderMode, sendEvent } from "$comfy/core/api.js";
  import { exportCanvas, exportMask } from "$comfy/photoshop/exportCanvas.js";
  import { placeLayer } from "$comfy/photoshop/placeLayer.js";
  import { ps, uxp } from "$comfy/photoshop/batchPlay.js";

  // SVG data from the built plugin
  const playIcon = `<path d="M15.143 22.5218C15.0734 22.454 14.7758 22.1979 14.531 21.9594C12.9914 20.5613 10.4714 16.9139 9.70219 15.005C9.57859 14.7151 9.31699 13.982 9.30019 13.5904C9.30019 13.2152 9.38659 12.8575 9.56179 12.5161C9.80659 12.0906 10.1918 11.7492 10.6466 11.5622C10.9622 11.4418 11.9066 11.2547 11.9234 11.2547C12.9566 11.0677 14.6354 10.9649 16.4906 10.9649C18.2582 10.9649 19.8686 11.0677 20.9174 11.2208C20.9342 11.2384 22.1078 11.4254 22.5098 11.63C23.2442 12.0053 23.7002 12.7382 23.7002 13.5227L23.7002 13.5904C23.6822 14.1013 23.2262 15.1756 23.2094 15.1756C22.439 16.9818 20.0426 20.5449 18.4502 21.977C18.4502 21.977 18.041 22.3803 17.7854 22.5557C17.4182 22.8292 16.9634 22.9648 16.5086 22.9648C16.001 22.9648 15.5282 22.8116 15.143 22.5218Z" fill="#7D7D7D"/>`;
  const settingsIcon = `<path fill-rule="evenodd" clip-rule="evenodd" d="M21.6809 16.2095C21.6809 16.5068 21.8334 16.772 22.0878 16.9206C23.1918 17.5625 23.5706 18.9877 22.9343 20.0987C22.6239 20.6386 22.1235 21.0244 21.5246 21.1855C20.9294 21.3427 20.307 21.2618 19.7725 20.9513C19.5197 20.8036 19.2186 20.8036 18.9657 20.9497C18.709 21.0968 18.5558 21.3637 18.5558 21.6616C18.5558 22.9446 17.5179 23.9894 16.242 23.9894C14.9653 23.9894 13.9275 22.9446 13.9275 21.6616C13.9275 21.3628 13.7742 21.0968 13.5176 20.949C13.2647 20.8036 12.9636 20.8036 12.7123 20.9513C12.1771 21.2618 11.5539 21.3442 10.9572 21.1847C10.3589 21.0237 9.85945 20.6379 9.54981 20.0987C8.91342 18.9877 9.29308 17.5617 10.3963 16.9199C10.6507 16.7728 10.8024 16.5068 10.8024 16.2095C10.8024 15.9123 10.6507 15.6463 10.3963 15.4985C9.29308 14.8582 8.91342 13.4329 9.54981 12.3212C9.85945 11.7812 10.3589 11.3954 10.958 11.2343C11.5554 11.074 12.1771 11.1581 12.7123 11.4685C12.9643 11.6163 13.2655 11.6148 13.5176 11.4701C13.7742 11.3222 13.9275 11.0561 13.9275 10.7574C13.9275 9.47452 14.9653 8.42969 16.242 8.42969C17.5179 8.42969 18.5558 9.47452 18.5558 10.7574C18.5558 11.0554 18.709 11.3222 18.9657 11.4692C19.2193 11.6163 19.5205 11.6163 19.7725 11.4685C20.3063 11.1581 20.9285 11.0756 21.5246 11.2335C22.1235 11.3946 22.6239 11.7805 22.9343 12.3204C23.5706 13.4321 23.1918 14.8574 22.0885 15.4992C21.8334 15.647 21.6809 15.9123 21.6809 16.2095ZM16.2419 18.5434C14.955 18.5434 13.9079 17.4962 13.9079 16.2094C13.9079 14.9226 14.955 13.8755 16.2419 13.8755C17.5287 13.8755 18.5758 14.9226 18.5758 16.2094C18.5758 17.4962 17.5287 18.5434 16.2419 18.5434Z" fill="#7D7D7D"/>`;
  const webIcon = `<path fill-rule="evenodd" clip-rule="evenodd" d="M11.7758 9.75781H21.2235C21.9971 9.75781 22.6243 10.385 22.6243 11.1586C22.6243 11.9322 21.9971 12.5594 21.2235 12.5594H11.7758C11.0022 12.5594 10.375 11.9322 10.375 11.1586C10.375 10.385 11.0022 9.75781 11.7758 9.75781ZM11.7758 16.0996H21.2235C21.9971 16.0996 22.6243 16.7268 22.6243 17.5004C22.6243 18.274 21.9971 18.9012 21.2235 18.9012H11.7758C11.0022 18.9012 10.375 18.274 10.375 17.5004C10.375 16.7268 11.0022 16.0996 11.7758 16.0996ZM11.7759 22.4395H16.5951C17.3688 22.4395 17.9961 23.0667 17.9961 23.8404C17.9961 24.6141 17.3688 25.2413 16.5951 25.2413H11.7759C11.0022 25.2413 10.375 24.6141 10.375 23.8404C10.375 23.0667 11.0022 22.4395 11.7759 22.4395Z" fill="#666666"/>`;
  const sparkleIcon = `<path fill-rule="evenodd" clip-rule="evenodd" d="M24.654 16.1027C21.0767 15.1804 18.2813 12.385 17.359 8.80771C17.2532 8.39743 16.6706 8.39743 16.5648 8.80771C15.6426 12.385 12.8471 15.1804 9.26984 16.1027C8.85924 16.2086 8.8593 16.7916 9.26984 16.8977C12.8471 17.82 15.6426 20.6153 16.5648 24.1919C16.6705 24.6022 17.2532 24.6022 17.359 24.1919C18.2813 20.6153 21.0767 17.82 24.654 16.8977C25.0645 16.7916 25.0645 16.2086 24.654 16.1027Z" fill="#666666"/><path fill-rule="evenodd" clip-rule="evenodd" d="M22.5008 13.0121C22.5008 12.0587 23.5461 10.9617 24.5511 10.9617C23.5838 10.9617 22.5008 9.85322 22.5008 8.91211C22.5008 9.85322 21.4276 10.9617 20.4512 10.9617C21.3906 10.9617 22.5008 12.053 22.5008 13.0121Z" fill="#666666"/>`;
  const sendIcon = `<path d="M7.9345 10.6899C8.92099 10.6899 9.90705 10.6883 10.8935 10.6912C12.5226 10.6962 13.7755 11.386 14.6422 12.75C15.7581 14.5062 16.8694 16.2658 17.9682 18.0328C18.4578 18.8204 19.1452 19.2089 20.0748 19.1861C20.3022 19.1807 20.5297 19.1852 20.7785 19.1852C20.7785 18.9883 20.7785 18.8025 20.7785 18.6163C20.7785 18.2901 20.7818 17.9639 20.7772 17.6376C20.7739 17.3978 20.8706 17.2154 21.0864 17.1123C21.3042 17.008 21.5099 17.0595 21.6917 17.2096C22.2614 17.6796 22.8306 18.15 23.3999 18.6205C23.8665 19.0061 24.334 19.3905 24.799 19.7779C25.0482 19.9852 25.1266 20.2113 25.0168 20.4453C24.9741 20.5367 24.902 20.6236 24.8233 20.6892C23.7815 21.5557 22.7364 22.4176 21.6921 23.2812C21.509 23.4325 21.305 23.4828 21.0872 23.3793C20.8715 23.2767 20.7751 23.0946 20.7768 22.8548C20.7806 22.347 20.7781 21.8387 20.7781 21.3072C20.6327 21.3072 20.4957 21.3051 20.3588 21.3072C19.8121 21.3164 19.2684 21.3072 18.7364 21.1564C17.636 20.8438 16.8007 20.193 16.1979 19.233C15.0799 17.4519 13.9556 15.6744 12.8359 13.8945C12.5326 13.4124 12.1297 13.0542 11.5675 12.9087C11.3493 12.8522 11.1185 12.819 10.8931 12.8169C9.90705 12.8073 8.92057 12.8131 7.93408 12.8131V10.6895L7.9345 10.6899Z" fill="#7D7D7D"/><path d="M7.93457 19.1854C8.92022 19.1854 9.90586 19.1892 10.8919 19.1854C11.731 19.1821 12.3798 18.8313 12.8255 18.1207C13.0572 17.7517 13.2905 17.3835 13.5313 17.002C13.5783 17.0726 13.616 17.1262 13.6512 17.1819C14.0106 17.7529 14.3712 18.3231 14.7256 18.8974C14.7558 18.9465 14.7704 19.0383 14.7445 19.0828C14.0847 20.2181 13.1238 20.9562 11.8206 21.2263C11.5877 21.2746 11.3468 21.3024 11.1089 21.3045C10.0508 21.3132 8.99268 21.309 7.93457 21.3099V19.1863V19.1854Z" fill="#7D7D7D"/>`;
  const addLayerIcon = `<path fill-rule="evenodd" clip-rule="evenodd" d="M19.4632 19.4178V21.7631C19.4632 22.3509 18.9875 22.8322 18.3941 22.8322C17.8008 22.8322 17.325 22.3565 17.325 21.7631V19.4178H14.9797C14.392 19.4178 13.9106 18.9421 13.9106 18.3487C13.9106 17.7554 14.3864 17.2796 14.9797 17.2796H17.325V14.9343C17.325 14.3466 17.8008 13.8652 18.3941 13.8652C18.9875 13.8652 19.4632 14.341 19.4632 14.9343V17.2796H21.8085C22.3963 17.2796 22.8776 17.7554 22.8776 18.3487C22.8776 18.9421 22.4019 19.4178 21.8085 19.4178H19.4632Z" fill="#7D7D7D"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12.4211 17.3472L8.79962 14.834L5.88898 16.8546C5.88898 16.8546 5.86099 16.8826 5.8498 16.8994C5.83861 16.9162 5.83301 16.9386 5.83301 16.9554C5.83301 16.9722 5.83301 16.9946 5.8498 17.0114C5.86099 17.0282 5.87219 17.045 5.88898 17.0561L13.7757 22.5304C13.8205 22.5584 13.8708 22.5752 13.9212 22.5752C13.9716 22.5752 14.022 22.5584 14.0668 22.5304L15.6508 21.6852V21.0975H14.9847C13.4678 21.0975 12.2364 19.866 12.2364 18.3491C12.2364 17.9965 12.3036 17.6551 12.4267 17.3472H12.4211Z" fill="#7D7D7D"/>`;

  let toolbarEl;
  let controllerEl;
  let sliderContainer;
  let isHovering = false;

  let imageModeContain = $imageMode === "contain";
  $: imageModeContain = $imageMode === "contain";

  let isCropToSelection = $cropToSelection;
  $: isCropToSelection = $cropToSelection;

  let isAutoRandomize = $autoRandomize;
  $: isAutoRandomize = $autoRandomize;

  $: workflowItems = $workflowOptions.map((w) => ({ id: w, label: w }));
  $: renderModeItems = $renderModeOptions.map((m) => ({ id: m, label: m }));

  function toggleImageMode() {
    $imageMode = $imageMode === "cover" ? "contain" : "cover";
  }

  function randomize() {
    $sliderValue = String(Math.floor(Math.random() * 100));
  }

  async function handleRender() {
    render({
      positivePrompt: $positivePrompt,
      negativePrompt: $negativePrompt,
      sliderValue: $sliderValue,
      imageMode: $imageMode,
      cropToSelection: $cropToSelection,
    });
  }

  async function handleAddToLayer() {
    // Will be triggered when render result arrives
    sendEvent("addLayer");
  }

  async function openSettingsPanel() {
    try {
      const plugins = Array.from(uxp?.pluginManager?.plugins || []);
      const plugin = plugins.find((p) => p.id === uxp?.entrypoints?._pluginInfo?.id);
      if (plugin?.showPanel) await plugin.showPanel("comfyui.ps.svelte.settings");
    } catch (e) {
      console.error("Error opening settings:", e);
    }
  }

  async function openWebPanel() {
    try {
      const plugins = Array.from(uxp?.pluginManager?.plugins || []);
      const plugin = plugins.find((p) => p.id === uxp?.entrypoints?._pluginInfo?.id);
      if (plugin?.showPanel) await plugin.showPanel("comfyui.ps.svelte.web");
    } catch (e) {
      console.error("Error opening web panel:", e);
    }
  }

  onMount(() => {
    // Setup WS message handler
    setOnMessage(async (msg) => {
      for (const [type, payload] of Object.entries(msg)) {
        if (type === "progress") $progress = Number(payload) || 0;
        else if (type === "render") { /* handle render result */ }
        else if (type === "render_status") { $statusText = String(payload); $statusColor = "yellow"; }
        else if (type === "generating") $progress = 0;
        else if (type === "Send_workflow") $workflowOptions = payload;
        else if (type === "Send_rndrMode") $renderModeOptions = payload;
        else if (type === "alert") alert(String(payload));
      }
    });

    // GSAP toolbar animations
    const panel = document.querySelector("uxp-panel");
    if (panel && toolbarEl) {
      panel.addEventListener("mouseenter", () => {
        if (!$disableAllAnimations) {
          gsap.to(toolbarEl, { x: "0%", duration: 0.3, ease: "power1.out" });
        }
      });
      panel.addEventListener("mouseleave", () => {
        if (!$disableAllAnimations) {
          gsap.to(toolbarEl, { x: "-116%", duration: 0.3, ease: "power1.in" });
        }
      });
    }
  });

  function handleSliderInput(e) {
    const rect = sliderContainer.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pct = Math.max(0, Math.min(1, 1 - y / rect.height));
    $sliderValue = String(Math.round(pct * 100));
  }

  let isDragging = false;
  function startDrag() { isDragging = true; }
  function stopDrag() { isDragging = false; }
  function onDrag(e) { if (isDragging) handleSliderInput(e); }
</script>

<div class="ai-root">
  <!-- Progress bar -->
  <ProgressBar progress={$progress} />

  <!-- Background image -->
  <div class="ai-panel"></div>

  <!-- Toolbar (left side, GSAP animated) -->
  <div class="toolbar" bind:this={toolbarEl}>
    <div class="buttonSeg">
      <Button class="icon" style="height:48px;width:48px;" toggle bind:value={isCropToSelection} on:mouseenter={() => {}}>
        <SVGIcon data={settingsIcon} size="32" />
      </Button>
      <Button class="icon" style="height:48px;width:48px;" toggle bind:value={imageModeContain} on:click={toggleImageMode} on:mouseenter={() => {}}>
        <SVGIcon data={webIcon} size="32" />
      </Button>
    </div>
    <Button
      class="icon"
      style="height:48px;width:48px;"
      toggle
      bind:value={isAutoRandomize}
      on:mouseenter={() => {}}
    >
      <SVGIcon data={sparkleIcon} size="32" />
    </Button>
  </div>

  <!-- Slider (right side) -->
  <div class="zone">
    <div class="section">
      <div
        id="background"
        bind:this={sliderContainer}
        on:mousedown={startDrag}
        on:mouseup={stopDrag}
        on:mouseleave={stopDrag}
        on:mousemove={onDrag}
      >
        <div id="slider-fill" style="height: {$sliderValue}%">
          <div class="slider-handle"></div>
        </div>
        <div id="slider-rail"></div>
      </div>
      <span class="slider-caption discrip">{$sliderValue}</span>
    </div>
  </div>

  <!-- Center content -->
  {#if !$keepEverythingVisible}
    <div class="add-layer">
      <span class="discrip">{$t("clickEmptyArea")}</span>
    </div>
  {/if}

  <!-- Layer actions (bottom center) -->
  <div class="layer-actions">
    <Button
      class="round-action"
      on:click={handleAddToLayer}
    >
      <SVGIcon data={addLayerIcon} size="34" />
    </Button>
  </div>

  <!-- Controller (bottom center) -->
  <div class="controller" bind:this={controllerEl}>
    <div class="floatcontainer">
      <!-- Dropdowns for workflow and render mode -->
      <Dropdown
        label={$t("workflow")}
        items={workflowItems}
        bind:selected={$selectedWorkflow}
        on:change={(e) => setWorkflow(e.detail.id)}
        style="width: 100%;"
      />
      <Dropdown
        label={$t("renderMode")}
        items={renderModeItems}
        bind:selected={$selectedRenderMode}
        on:change={(e) => setRenderMode(e.detail.id)}
        style="width: 100%;"
      />
    </div>

    <div class="prompt-section" id="promptsection">
      {#if $showNegativeInput}
        <TextField type="textarea" placeholder={$t("negativePrompt")} id="nPrompt" bind:value={$negativePrompt} style="width: 100%;" />
      {/if}
      <TextField type="textarea" placeholder={$t("positivePrompt")} id="pPrompt" bind:value={$positivePrompt} style="width: 100%; border-bottom-left-radius: 10px !important;" />
    </div>

    <div class="style-containerBG">
      <div class="row">
        <Button
          class="s"
          style="width:auto; border-radius: 18px; padding:0 16px"
          on:click={connect}
        >
          {$t("connect")}
        </Button>
        <Button
          class="s icon"
          style="font-size: large; width: auto;"
          on:click={() => { $ip = "http://127.0.0.1:8188"; }}
        >
          ↺
        </Button>
        <Button
          style="width: 100px; margin-left: 8px;"
          class="s icon"
          on:mouseenter={() => {}}
          on:mouseleave={() => {}}
          on:contextmenu={randomize}
          on:click={handleRender}
        >
          {$t("render")}
          <SVGIcon data={playIcon} size="24" style="margin-right: -4px;" />
        </Button>
        <Button
          style="width: 40px; margin-right: 8px;"
          class="s icon"
          on:click={handleAddToLayer}
        >
          <SVGIcon data={sendIcon} size="24" />
        </Button>
      </div>
    </div>
  </div>

  <!-- Status pill -->
  <div class="status-pill">
    <span class="status-{$statusColor}">{$statusText}</span>
  </div>
</div>

<style>
  :root {
    --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --color-white: #cccccc;
    --color-dark-gray: #262627;
    --color-hover-gray: #303031;
    --border-radius-m: 18px;
    --border-radius-l: 24px;
    --padding-small: 4px;
    --padding-medium: 8px;
    --font-size-small: 10px;
    --font-size-medium: 12px;
  }

  .ai-root {
    position: relative;
    width: 100%;
    height: 100%;
    display: block;
    overflow: hidden;
    background: #f7f7f7;
  }

  .ai-panel {
    position: fixed;
    inset: 0;
    z-index: 0;
    background-image: url("/assets/defaultImg-BcFEYa9o.jpg");
    background-size: cover;
    background-position: center;
  }

  .toolbar {
    position: absolute;
    left: 8px;
    top: 8px;
    z-index: 3;
    display: flex;
    flex-direction: column;
    height: auto;
  }

  .toolbar > * {
    width: 48px;
    border-radius: 12px;
    margin-bottom: var(--padding-small);
  }

  .buttonSeg {
    display: flex;
    flex-direction: column;
  }

  .buttonSeg > * {
    width: 48px;
    height: 48px;
    border-radius: 4px;
    margin-bottom: 2px;
    background: #000;
    border: 1px solid #000;
    padding: 3px;
    color: #9f9f9f;
  }

  .buttonSeg > :first-child {
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
  }

  .buttonSeg > :last-child {
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
    margin-bottom: 0;
  }

  .zone {
    position: absolute;
    height: 100vh;
    right: 0;
    top: 0;
    width: 30%;
    padding-right: 8px;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    z-index: 9;
  }

  .section {
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    z-index: 9;
  }

  #background {
    width: 56px;
    height: 200px;
    min-height: 35vh;
    max-height: 160px;
    background: #000;
    border-radius: 16px;
    position: relative;
    display: flex;
    align-items: flex-end;
    padding: 6px;
  }

  #slider-fill {
    width: 100%;
    background: var(--color-dark-gray);
    border: 1px solid var(--color-hover-gray);
    border-radius: 10px;
    transition: height 0.15s;
    position: relative;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 16px;
    overflow: hidden;
    transform-origin: center bottom;
  }

  .slider-handle {
    width: 16px;
    height: 3px;
    background: #7c7c7c;
    border-radius: 1.5px;
    margin-top: -8px;
  }

  .section:hover .slider-handle {
    background: #cfcfcf;
  }

  #slider-rail {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: ns-resize;
    width: 56px;
    height: 100%;
    margin: 0;
    z-index: 3;
  }

  .slider-caption {
    display: none;
  }

  .layer-actions {
    position: absolute;
    left: 50%;
    bottom: 82px;
    transform: translateX(38px);
    display: flex;
    flex-direction: row;
    gap: 8px;
    z-index: 4;
  }

  .round-action {
    width: 42px;
    height: 42px;
    background: #000;
    border-radius: 50%;
    border: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: #8f8f8f;
  }

  .round-action:hover {
    background: #1c1c1c;
  }

  .add-layer {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 2;
  }

  .add-layer .discrip {
    position: absolute;
    bottom: 72px;
    color: #969696;
  }

  .controller {
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    padding-bottom: 10px;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    z-index: 5;
  }

  .floatcontainer {
    display: flex;
    justify-content: flex-end;
    flex-direction: row;
    width: 100%;
    margin-bottom: 4px;
    z-index: 1;
    gap: 4px;
  }

  .prompt-section {
    width: 100%;
    margin-bottom: 4px;
  }

  .style-containerBG {
    border-radius: var(--border-radius-l);
    background: #000;
    padding: var(--padding-medium);
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 188px;
    height: 58px;
  }

  .row {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 100%;
    gap: 4px;
  }

  .discrip {
    font-size: var(--font-size-medium);
    color: #969696;
    font-weight: 200;
    width: fit-content;
    margin-bottom: 0;
  }

  .status-pill {
    position: absolute;
    left: 12px;
    bottom: 24px;
    z-index: 7;
    max-width: 160px;
    min-height: 20px;
    background: rgba(0, 0, 0, 0.65);
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 11px;
    display: flex;
    align-items: center;
  }

  .status-green { color: #36a026 !important; }
  .status-red { color: #d45151 !important; }
  .status-yellow { color: #e6c619 !important; }
</style>
