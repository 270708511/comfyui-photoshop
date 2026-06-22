import {
  ip, mode, cloudUrl, cloudUsername, cloudPassword, comfyUser,
  connected, connecting, progress, statusText, statusColor,
} from "../stores.js";

let socket = null;
let reconnectTimer = null;
let onMessageCallback = null;

function getStoreValue(store) {
  let val;
  store.subscribe((v) => { val = v; })();
  return val;
}

function getBaseUrl() {
  const currentMode = getStoreValue(mode);
  const currentIp = getStoreValue(ip);
  const currentCloudUrl = getStoreValue(cloudUrl);
  let url = (currentMode === "cloud" ? currentCloudUrl : currentIp || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (url === "127.0.0.1" || url === "http://127.0.0.1") url = "http://127.0.0.1:8188";
  if (!/^https?:\/\//.test(url)) url = "http://" + url;
  return url;
}

function httpToWsUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const currentMode = getStoreValue(mode);
  const currentComfyUser = getStoreValue(comfyUser);
  const currentCloudUsername = getStoreValue(cloudUsername);
  const currentCloudPassword = getStoreValue(cloudPassword);
  const currentClientId = getStoreValue(ip) ? `ps-${Math.random().toString(36).substring(2, 11)}` : `ps-${Math.random().toString(36).substring(2, 11)}`;
  const params = new URLSearchParams({
    clientId: currentClientId,
    platform: "ps",
    mode: currentMode,
  });
  if (currentMode === "cloud" && currentComfyUser) {
    params.set("comfyUser", currentComfyUser);
    if (currentCloudUsername) parsed.username = encodeURIComponent(currentCloudUsername);
    if (currentCloudPassword) parsed.password = encodeURIComponent(currentCloudPassword);
  }
  return `${parsed.toString().replace(/\/$/, "")}/ps/ws?${params.toString()}`;
}

export function connect() {
  disconnect(false);
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    statusText.set("Missing URL");
    statusColor.set("red");
    return;
  }
  const wsUrl = httpToWsUrl(baseUrl);
  connecting.set(true);
  statusText.set("Connecting");
  statusColor.set("yellow");

  try {
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      connected.set(true);
      connecting.set(false);
      statusText.set("Connected");
      statusColor.set("green");
    };
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessageCallback?.(msg);
      } catch (e) {
        console.error("Failed to parse WS message:", e);
      }
    };
    socket.onerror = () => {
      statusText.set("Socket Error");
      statusColor.set("red");
    };
    socket.onclose = () => {
      connected.set(false);
      connecting.set(false);
      statusText.set("Disconnected");
      statusColor.set("red");
      scheduleReconnect(wsUrl);
    };
  } catch (e) {
    connected.set(false);
    connecting.set(false);
    statusText.set("Connect Error");
    statusColor.set("red");
    scheduleReconnect(wsUrl);
  }
}

export function disconnect(clearReconnect = true) {
  if (clearReconnect && reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.onclose = null;
      socket.close();
    } catch (_) {}
    socket = null;
  }
  connected.set(false);
}

function scheduleReconnect(url) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const isConnected = getStoreValue(connected);
    if (!isConnected) connect();
  }, 5000);
}

export function send(data) {
  if (socket?.readyState === 1) {
    socket.send(JSON.stringify(data));
    return true;
  }
  console.warn("Socket not open. Payload not sent:", data);
  return false;
}

export function setOnMessage(fn) { onMessageCallback = fn; }
