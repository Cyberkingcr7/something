const API_BASE = "https://clipkey-server.onrender.com/ai";
const SERVER_URL = "https://clipkey-server.onrender.com/api/activate";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ hotkey: "Ctrl+Shift+X" });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    try {
      switch (msg.type) {
        case "ANSWER_CLIPBOARD": {
          const text = msg.text?.trim();
          if (!text) {
            sendResponse({ ok: false, error: "Clipboard text is empty." });
            return;
          }

          const url = `${API_BASE}?text=${encodeURIComponent(text)}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`API request failed: ${res.status}`);

          const data = await res.json();
          const answer = data?.result?.data?.trim();

          if (!answer) {
            sendResponse({ ok: false, error: "AI returned empty answer." });
            return;
          }

          sendResponse({ ok: true, answer });
          break;
        }

        case "ACTIVATE_KEY": {
          const { key } = msg;
          const res = await fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key })
          });

          const data = await res.json();

          if (data.status === "ok" && data.type) {
            await chrome.storage.local.set({
              expiryTimestamp: data.expiry,
              userType: data.type, // "free", "daily", "monthly"
              apiKey: key
            });
            sendResponse({ ok: true, message: "Key activated", userType: data.type });
          } else {
            sendResponse({ ok: false, message: "Invalid key" });
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (err) {
      console.error("background.js error:", err);
      sendResponse({ ok: false, error: "Background operation failed." });
    }
  })();

  return true; // Keep channel open for async sendResponse
});
