<script>
  import { onMount } from "svelte";
  import {
    t, ip,
    downScaleIfBigger, upScaleIfSmaller, fixMaskEdge, forceResize,
    cropToSelection, cropPadding, showNegativeInput,
    keepBottomControllerVisible, keepEverythingVisible,
    disableAllAnimations, pluginLang, languageList,
    pluginVersion, positivePrompt, negativePrompt, sliderValue,
    selectedWorkflow, workflowOptions, connected, statusText, statusColor,
  } from "$comfy/stores.js";
  import { connect } from "$comfy/core/ws.js";

  function log(...args) {
    console.log("[CPS-DEBUG:Settings]", ...args);
  }

  const langItems = languageList.map((l) => ({ id: l.id, label: `${l.name} (${l.short})` }));
  let seedInput = "120433";

  onMount(() => {
    log("onMount", { ip: $ip, version: $pluginVersion });
  });

  function reloadPlugin() { window.location.reload(); }
  function randomizeSeed() { seedInput = Math.floor(Math.random() * 99999999).toString(); }
</script>

<div class="settings-root">
  <!-- LEFT: Connection -->
  <div class="seg">
    <div class="seg-head">ComfyUI IP <span class="status" style="color:{$statusColor || '#666'}">{#if $connected}✓ Connected{:else}Not Connected{/if}</span></div>
    <div class="seg-body">
      <div class="row">
        <label>IP Address</label>
        <input type="text" bind:value={$ip} class="inp" />
      </div>
      <div class="row-btns">
        <button class="btn" onclick={() => { $ip = ""; }}>Reset</button>
        <button class="btn primary" onclick={connect}>Connect</button>
      </div>
    </div>
  </div>

  <!-- LEFT: Presets -->
  <div class="seg">
    <div class="seg-head">Presets</div>
    <div class="seg-body">
      <label class="lbl">Positive Prompt</label>
      <textarea class="ta" bind:value={$positivePrompt} placeholder="a girl..."></textarea>

      {#if $showNegativeInput}
        <label class="lbl" style="margin-top:6px">Negative Prompt</label>
        <textarea class="ta" bind:value={$negativePrompt}></textarea>
      {/if}

      <div class="row" style="margin-top:6px">
        <label>Slider Value</label>
        <input type="text" bind:value={$sliderValue} class="inp-short" />
      </div>
      <div class="row-btns">
        <button class="btn" onclick={randomizeSeed}>🎲 Randomize</button>
        <input type="text" bind:value={seedInput} class="inp-short" />
      </div>
    </div>
  </div>

  <!-- RIGHT: Image Processing -->
  <div class="seg">
    <div class="seg-head">Image Processing</div>
    <div class="seg-body">
      <div class="row"><label>Downscale if Bigger</label><input type="text" bind:value={$downScaleIfBigger} class="inp-short" /></div>
      <div class="row"><label>Upscale if Smaller</label><input type="text" bind:value={$upScaleIfSmaller} class="inp-short" /></div>
      <div class="chk"><input type="checkbox" id="fme" bind:checked={$fixMaskEdge} /><label for="fme">Fix Mask Edge</label></div>
      <div class="chk"><input type="checkbox" id="frz" bind:checked={$forceResize} /><label for="frz">Force Resize</label></div>
      <div class="chk"><input type="checkbox" id="cts" bind:checked={$cropToSelection} /><label for="cts">Crop To Selection</label></div>
      <div class="row" style="margin-top:4px"><label>Crop Padding</label><input type="text" bind:value={$cropPadding} class="inp-short" /></div>
    </div>
  </div>

  <!-- RIGHT: General -->
  <div class="seg">
    <div class="seg-head">General <span class="ver">v{$pluginVersion}</span></div>
    <div class="seg-body">
      <div class="row">
        <label>Language</label>
        <select bind:value={$pluginLang} class="sel">
          {#each langItems as item}
            <option value={item.id}>{item.label}</option>
          {/each}
        </select>
      </div>
      <div class="chk"><input type="checkbox" id="sni" bind:checked={$showNegativeInput} /><label for="sni">Show Negative Input</label></div>
      <div class="chk"><input type="checkbox" id="kbc" bind:checked={$keepBottomControllerVisible} /><label for="kbc">Keep Bottom Controller Visible</label></div>
      <div class="chk"><input type="checkbox" id="kev" bind:checked={$keepEverythingVisible} /><label for="kev">Keep Everything Visible</label></div>
      <div class="chk"><input type="checkbox" id="daa" bind:checked={$disableAllAnimations} /><label for="daa">Disable All Animations</label></div>
      <button class="btn full" onclick={reloadPlugin}>Reload Plugin</button>
    </div>
  </div>

  <!-- Sponsored -->
  <div class="seg seg-full">
    <div class="seg-head">Sponsored By</div>
    <div class="seg-body sponsor-body">
      <div style="text-align:center;color:#777;font-size:11px;line-height:1.5;padding:10px 0">
        PHOTOSHOP<br/>to COMFYUI ☕<br/>
        <a href="https://buymeacoffee.com/nimanzri" style="color:#666;text-decoration:none;font-size:11px">Buy a Coffee</a>
      </div>
      <div class="link-row">
        <a href="https://discord.gg/mh5P4hY7" class="lnk">Discord</a>
        <a href="https://github.com/NimaNzrii/comfyui-photoshop/issues/new" class="lnk">Report</a>
      </div>
    </div>
  </div>
</div>

<style>
  .settings-root {
    background: #262627;
    width: 100%;
    min-height: 100%;
    padding: 8px;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-content: start;
  }

  .seg {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    overflow: hidden;
  }

  .seg-full {
    grid-column: 1 / -1;
  }

  .seg-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    background: #1e1e1f;
    font-size: 11px;
    font-weight: 700;
    color: #b0b0b0;
  }

  .status { font-size: 9px; font-weight: 600; }
  .ver { font-size: 9px; color: #555; font-weight: 400; }

  .seg-body {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .sponsor-body {
    align-items: center;
  }

  .lbl {
    font-size: 11px;
    color: #888;
    margin-bottom: 3px;
    display: block;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .row label {
    font-size: 11px;
    color: #888;
  }

  .inp {
    flex: 1;
    max-width: 150px;
    background: #252526;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 4px 8px;
    color: #ccc;
    font-size: 11px;
  }

  .inp-short {
    width: 60px;
    background: #252526;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 4px 6px;
    color: #ccc;
    font-size: 11px;
    text-align: right;
  }

  .sel {
    background: #252526;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 6px;
    color: #ccc;
    font-size: 11px;
    max-width: 150px;
  }

  .ta {
    width: 100%;
    height: 50px;
    background: #252526;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 6px 8px;
    color: #ccc;
    font-size: 11px;
    resize: none;
    box-sizing: border-box;
    font-family: inherit;
  }

  .row-btns {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .btn {
    flex: 1;
    padding: 5px 10px;
    background: #333;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ccc;
    font-size: 11px;
    cursor: pointer;
  }

  .btn.primary {
    background: #0060c0;
    border-color: #0078d4;
    color: #fff;
  }

  .btn.full {
    width: 100%;
  }

  .chk {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #999;
    padding: 2px 0;
  }

  .chk input[type="checkbox"] {
    accent-color: #666;
    width: 13px;
    height: 13px;
  }

  .link-row {
    display: flex;
    justify-content: center;
    gap: 16px;
    width: 100%;
    padding-top: 4px;
  }

  .lnk {
    font-size: 10px;
    color: #666;
    text-decoration: none;
  }

  .lnk:hover { color: #aaa; }

  @media (max-width: 500px) {
    .settings-root { grid-template-columns: 1fr; }
  }
</style>
