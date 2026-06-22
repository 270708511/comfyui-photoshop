import { send } from "./ws.js";
import { mode, comfyUser } from "../stores.js";

let clientId = `ps-${Math.random().toString(36).substring(2, 11)}`;

function getStoreValue(store) {
  let val;
  store.subscribe((v) => { val = v; })();
  return val;
}

export function render(payload = {}) {
  const currentMode = getStoreValue(mode);
  const currentUser = getStoreValue(comfyUser);
  return send({
    ...payload,
    queue: true,
    clientId,
    mode: currentMode,
    comfyUser: currentMode === "cloud" ? currentUser : undefined,
  });
}

export function setWorkflow(id) {
  return send({ workflow: id });
}

export function setRenderMode(m) {
  return send({ rndrMode: m });
}

export function sendEvent(type, data = true) {
  return send({ [type]: data });
}
