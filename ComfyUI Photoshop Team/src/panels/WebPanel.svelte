<script>
  import { onMount } from "svelte";
  import { ip, mode, cloudUrl, cloudUsername, cloudPassword, comfyUser } from "$comfy/stores.js";

  function log(...args) {
    console.log("[CPS-DEBUG:WebPanel]", ...args);
  }

  let webviewUrl = "http://127.0.0.1:8188";

  $: {
    const baseUrl = $mode === "cloud" ? $cloudUrl : $ip;
    if (baseUrl) {
      let url = baseUrl.trim().replace(/\/+$/, "");
      if (url === "127.0.0.1" || url === "http://127.0.0.1") url = "http://127.0.0.1:8188";
      if (!/^https?:\/\//.test(url)) url = "http://" + url;
      if (url.startsWith("wss://")) url = "https://" + url.slice("wss://".length);
      if (url.startsWith("ws://")) url = "http://" + url.slice("ws://".length);
      webviewUrl = url;
    }
  }

  onMount(() => {
    log("onMount - webviewUrl:", webviewUrl);
    // Check if webview element exists after mount
    setTimeout(() => {
      const wv = document.getElementById("comfy-webview");
      log("webview element:", wv ? `found (src=${wv.src})` : "NOT FOUND");
    }, 100);
  });

  export function refreshWebview(force = false) {
    const wv = document.getElementById("comfy-webview");
    if (wv) {
      wv.src = force ? webviewUrl + "?_t=" + Date.now() : webviewUrl;
      log("refreshWebview ->", wv.src);
    } else {
      log("refreshWebview: webview not found!");
    }
  }
</script>

<div class="web-root">
  <webview id="comfy-webview" src={webviewUrl} style="width:100%;height:100%;border:none;"></webview>
</div>

<style>
  .web-root {
    width: 100%;
    height: 100%;
  }
</style>
