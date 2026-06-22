// Photoshop batchPlay wrapper for UXP
let ps = null;
let uxp = null;

try {
  if (typeof require === "function") {
    ps = require("photoshop");
    uxp = require("uxp");
  }
} catch (_) {}

export async function batchPlay(commands, options = {}) {
  if (!ps?.action) return null;
  return ps.action.batchPlay(commands, {
    synchronous: false,
    ...options,
  });
}

export { ps, uxp };
