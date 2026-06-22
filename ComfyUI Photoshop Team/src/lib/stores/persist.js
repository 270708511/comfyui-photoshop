import { writable } from "svelte/store";

// Safe storage abstraction — works in both browser and UXP
function getStorage() {
  try {
    // Test if localStorage is available
    if (typeof localStorage !== "undefined" && localStorage.getItem && localStorage.setItem) {
      console.log("[CPS-DEBUG:persist] Using localStorage");
      return localStorage;
    }
  } catch (e) {
    console.log("[CPS-DEBUG:persist] localStorage not available:", e.message);
  }
  console.log("[CPS-DEBUG:persist] Using in-memory fallback storage");
  const store = {};
  return {
    getItem(key) { return store[key] || null; },
    setItem(key, val) { store[key] = val; },
    removeItem(key) { delete store[key]; },
  };
}

// Persist a store to storage (localStorage or in-memory fallback)
export function persist(key, value) {
  const storage = getStorage();
  let initial = value;
  try {
    const stored = storage.getItem(key);
    if (stored !== null) initial = JSON.parse(stored);
  } catch (_) {}

  const store = writable(initial);
  store.subscribe((val) => {
    try {
      storage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn("Failed to persist store:", key, e);
    }
  });
  return store;
}
