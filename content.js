let isBusy = false;
let leftClickEnabled = true;
let sentenceBuffer = [];
let copyTimeout = null;

/////////////////////
// Storage Helpers //
/////////////////////
async function safeGetStorage(keys, retries = 3, delayMs = 200) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (!chrome?.storage?.local) throw new Error("chrome.storage.local unavailable");

      const result = await new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(res || {});
        });
      });
      return result;
    } catch (err) {
      console.warn(`safeGetStorage attempt ${attempt + 1} failed:`, err);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error("safeGetStorage failed after retries, returning empty object.");
  return {};
}

async function safeSetStorage(items, retries = 3, delayMs = 200) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (!chrome?.storage?.local) throw new Error("chrome.storage.local unavailable");

      await new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
      return;
    } catch (err) {
      console.warn(`safeSetStorage attempt ${attempt + 1} failed:`, err);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error("safeSetStorage failed after retries.");
}

/////////////////////
// Cursor Helpers  //
/////////////////////
function setCursorLoading(loading) {
  if (document.body) document.body.style.cursor = loading ? "progress" : "";
  if (document.documentElement) document.documentElement.style.cursor = loading ? "progress" : "";
}

/////////////////////
// Clipboard Helpers //
/////////////////////
async function getClipboardText() {
  try { return await navigator.clipboard.readText(); } 
  catch (err) { console.error("getClipboardText error:", err); return ""; }
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); } 
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-2000px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch (err) { console.error("copyToClipboard fallback failed:", err); }
  }
}

///////////////////////////
// Activation / Key Logic //
///////////////////////////
const SERVER_URL = "https://clipkey-server.onrender.com/api/activate";

async function activateKey(key) {
  try {
    const res = await fetch(SERVER_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    const data = await res.json();
    if (data.status === "ok") {
      await safeSetStorage({ expiryTimestamp: data.expiry, userType: data.type, apiKey: key });
      return true;
    }
    return false;
  } catch (err) { console.error("activateKey error:", err); return false; }
}

async function isActivated() {
  const { expiryTimestamp } = await safeGetStorage(["expiryTimestamp"]);
  return expiryTimestamp && Date.now() < expiryTimestamp;
}

async function getUserType() {
  const { userType } = await safeGetStorage(["userType"]);
  return userType || "free";
}

/////////////////////
// AI Response     //
/////////////////////
async function getAIResponse(text) {
  try {
    const { apiKey } = await safeGetStorage(["apiKey"]);
    if (!apiKey) return null;

    const res = await fetch("https://clipkey-server.onrender.com/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, apiKey })
    });
    const data = await res.json();
    if (data?.topChunks) console.log("📚 Relevant Study Guide Chunks:", data.topChunks);

    return { answer: data?.result?.data || null, chunks: data?.topChunks || [] };
  } catch (err) { console.error("getAIResponse error:", err); return null; }
}

async function getAIResponseWithGuide(text) {
  const { apiKey, useGuide, selectedSubject: subject } = await safeGetStorage(["apiKey", "useGuide", "selectedSubject"]);
  if (useGuide && subject && apiKey) {
    try {
      const subjectsRes = await fetch(`https://clipkey-server.onrender.com/api/studyguide/subjects?apiKey=${apiKey}`);
      const subjectsData = await subjectsRes.json();
      if (subjectsData.status === "ok" && subjectsData.subjects.includes(subject)) {
        const guideRes = await fetch(`https://clipkey-server.onrender.com/api/studyguide/content?apiKey=${apiKey}&subject=${encodeURIComponent(subject)}`);
        const guideData = await guideRes.json();
        if (guideData.status === "ok" && guideData.chunks?.length) {
          const guideText = guideData.chunks.join("\n");
          text = `Study guide:\n${guideText}\n\nQuestion:\n${text}`;
        }
      }
    } catch (err) { console.error("Error fetching study guide:", err); }
  }
  return await getAIResponse(text);
}

/////////////////////
// Clipboard / AI Processing //
/////////////////////
async function processClipboard(inputText = null, showPopup = false) {
  if (isBusy) return;
  isBusy = true;
  setCursorLoading(true);

  let aiAnswer = "";
  try {
    // Fetch stored API key and expiry
    let { apiKey: storedKey, expiryTimestamp } = await safeGetStorage(["apiKey", "expiryTimestamp"]);

    // Use inputText first, then clipboard
    let text = (inputText || (await getClipboardText())).trim();

    if (!text && !storedKey) {
      throw new Error("No text found and no key available.");
    }

    // Activate key ONLY if no stored key exists and text looks like a key
    if (!storedKey && text.startsWith("bnh")) {
      const success = await activateKey(text);
      const message = success ? "✅ Key Activated! Access granted." : "❌ Invalid Key.";
      if (success) storedKey = text; // immediately mark key as active
      await copyToClipboard(message);
      if (showPopup) aiAnswer = message;
      return aiAnswer;
    }

    // Determine whether key is active
    const active = (expiryTimestamp && Date.now() < expiryTimestamp) || !!storedKey;

    const userType = await getUserType();

    // Free mode fallback
    if (!active && showPopup) {
      aiAnswer = "⚠ Free mode: AI will respond, but some features may be disabled.";
    }

    // Paid mode enforcement
    if (!active && !showPopup) {
      await copyToClipboard("❌ ClipKey is not activated or key expired.");
      return "❌ ClipKey is not activated or key expired.";
    }

    // If no text from input/clipboard, but stored key exists, treat text as input for AI?
    if (!text && storedKey) {
      text = ""; // or optionally prompt user in popup
    }

    // Send text to AI using stored key
    const { answer, chunks } = await getAIResponseWithGuide(text) || {};
    if (chunks?.length) showChunksPopup(chunks);

    const finalAnswer = answer || "⚠ AI returned no response.";
    await copyToClipboard(finalAnswer);

    if (showPopup) aiAnswer = finalAnswer;

  } catch (err) {
    console.error("processClipboard error:", err);
    if (showPopup) aiAnswer = "⚠ Error processing text.";
  } finally {
    isBusy = false;
    setCursorLoading(false);
  }

  return aiAnswer;
}



function showPopupInput() {
  if (document.getElementById("clipkey-popup-container")) return;

  const container = document.createElement("div");
  container.id = "clipkey-popup-container";
  Object.assign(container.style, {
    position: "fixed",
    top: "20%",
    left: "50%",
    transform: "translateX(-50%)",
    width: "60%",
    zIndex: "10000",
    padding: "10px",
    backgroundColor: "white",
    border: "2px solid #ccc",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  Object.assign(closeBtn.style, {
    position: "absolute",
    top: "5px",
    right: "8px",
    border: "none",
    background: "transparent",
    fontSize: "20px",
    cursor: "pointer",
    lineHeight: "1"
  });
  closeBtn.addEventListener("click", () => container.remove());
  container.appendChild(closeBtn);

  const input = document.createElement("textarea");
  input.id = "clipkey-popup-input";
  input.placeholder = "Enter text or API key...";
  Object.assign(input.style, { width: "100%", height: "100px", fontSize: "16px", marginBottom: "8px", padding: "8px", boxSizing: "border-box" });
  container.appendChild(input);

  const sendBtn = document.createElement("button");
  sendBtn.textContent = "Send";
  Object.assign(sendBtn.style, { padding: "8px 16px", fontSize: "16px", cursor: "pointer", marginBottom: "10px" });
  container.appendChild(sendBtn);

  const responseBox = document.createElement("div");
  responseBox.id = "clipkey-popup-response";
  Object.assign(responseBox.style, { whiteSpace: "pre-wrap", fontSize: "14px", maxHeight: "200px", overflowY: "auto", marginTop: "8px" });
  container.appendChild(responseBox);

  async function handleSend() {
    const customText = input.value.trim();
    if (!customText) return;
    responseBox.textContent = "⏳ Processing...";
    const aiResponse = await processClipboard(customText, true);
    responseBox.textContent = aiResponse || "⚠ AI returned no response.";
    input.value = ""; // optionally clear input after send
  }

  sendBtn.addEventListener("click", handleSend);

  container.addEventListener("keydown", async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      await handleSend();
    }
    if (e.key === "Escape") container.remove();
  });

  document.body.appendChild(container);
  input.focus();

  container.tabIndex = -1;
  container.focus();
}


function showChunksPopup(chunks) {
  if (document.getElementById("clipkey-chunks-popup")) return;

  const container = document.createElement("div");
  container.id = "clipkey-chunks-popup";
  Object.assign(container.style, {
    position: "fixed", bottom: "10px", right: "10px",
    width: "300px", maxHeight: "400px", overflowY: "auto",
    zIndex: "10000", padding: "10px",
    backgroundColor: "#fff", border: "1px solid #ccc", borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
  });

  const title = document.createElement("div");
  title.textContent = "📚 Relevant Study Guide Chunks";
  title.style.fontWeight = "bold"; title.style.marginBottom = "8px";
  container.appendChild(title);

  chunks.forEach((chunk, i) => {
    const chunkDiv = document.createElement("div");
    chunkDiv.textContent = `${i + 1}. ${chunk.chunk || chunk}`;
    Object.assign(chunkDiv.style, { marginBottom: "6px", fontSize: "13px", lineHeight: "1.4" });
    container.appendChild(chunkDiv);
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  Object.assign(closeBtn.style, { position: "absolute", top: "5px", right: "8px", border: "none", background: "transparent", fontSize: "16px", cursor: "pointer" });
  closeBtn.onclick = () => container.remove();
  container.appendChild(closeBtn);

  document.body.appendChild(container);
}

/////////////////////////
// Ultra-Stealth Paste //
/////////////////////////
async function silentInsertAtCaret(text) {
  try {
    const activeEl = document.activeElement;
    if (!activeEl) throw new Error("No active element.");
    if (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT") {
      const start = activeEl.selectionStart, end = activeEl.selectionEnd;
      const before = activeEl.value.substring(0, start), after = activeEl.value.substring(end);
      activeEl.value = before + text + after;
      activeEl.selectionStart = activeEl.selectionEnd = start + text.length;
      activeEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else if (activeEl.isContentEditable) {
      const sel = window.getSelection(); if (!sel.rangeCount) throw new Error("No selection range.");
      const range = sel.getRangeAt(0);
      range.deleteContents(); range.insertNode(document.createTextNode(text)); range.collapse(false);
      activeEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else throw new Error("Active element not supported.");
    return true;
  } catch (err) { console.error("silentInsertAtCaret failed:", err); return false; }
}

async function pasteAtCaretUltraStealth(text) {
  const success = await silentInsertAtCaret(text);
  if (!success) try { document.execCommand("insertText", false, text); } catch {}
}

/////////////////////
// Event Handlers  //
/////////////////////
document.addEventListener("keydown", async (e) => {
  const userType = await getUserType();
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const key = e.key.toLowerCase();

  try {
    // Toggle left-click
    if (ctrlOrCmd && shift && alt && key === "x") {
      e.preventDefault();
      leftClickEnabled = !leftClickEnabled;
      console.log(`Left-click auto-copy: ${leftClickEnabled ? "ON" : "OFF"}`);
      return;
    }

    if (ctrlOrCmd && shift && !alt) {
      switch (key) {
        case "x": e.preventDefault(); await processClipboard(); break;
        case "h": e.preventDefault(); showPopupInput(); break;
        case "e": e.preventDefault(); const selectedText = window.getSelection().toString(); if (selectedText) await copyToClipboard(selectedText); break;
        case "v": 
          if (userType === "daily" || userType === "monthly") { 
            e.preventDefault(); 
            const text = await getClipboardText(); 
            await pasteAtCaretUltraStealth(text); 
          } 
          break;
      }
    }
  } catch (err) { console.error("keydown handler error:", err); }
});

document.addEventListener("click", async (event) => {
  if (event.button !== 0 || !leftClickEnabled) return; // Only left-click and enabled

  try {
    const userType = await getUserType();
    if (userType !== "monthly") return; // Only monthly users

    const target = event.target;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;

    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(event.clientX, event.clientY)
      : document.caretPositionFromPoint
      ? (() => {
          const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
          const r = document.createRange();
          r.setStart(pos.offsetNode, pos.offset);
          r.collapse(true);
          return r;
        })()
      : null;

    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return;

    const textNode = range.startContainer;
    const text = textNode.textContent;
    if (!text) return;

    const clickOffset = range.startOffset;
    const before = text.slice(0, clickOffset);
    const after = text.slice(clickOffset);

    const sentenceStart =
      Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1 || 0;
    const sentenceEnd =
      clickOffset +
      Math.min(
        after.indexOf(".") > -1 ? after.indexOf(".") : after.length,
        after.indexOf("!") > -1 ? after.indexOf("!") : after.length,
        after.indexOf("?") > -1 ? after.indexOf("?") : after.length
      );

    const sentence = text.slice(sentenceStart, sentenceEnd).trim();
    if (!sentence) return;

    // Avoid duplicates
    if (!sentenceBuffer.some((s) => s.toLowerCase() === sentence.toLowerCase())) {
      sentenceBuffer.push(sentence);
      console.log("Buffered sentence:", sentence);
    }

    // Reset copy timer
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(async () => {
      const finalText = sentenceBuffer.join(" ");
      await copyToClipboard(finalText);
      console.log("Copied to clipboard:", finalText);
      sentenceBuffer = [];
      copyTimeout = null;
    }, 5000);
  } catch (err) {
    console.error("Click handler error:", err);
  }
});

document.addEventListener("click", async (e) => {
    const flagBtn = e.target.closest("a.aabtn[title='Flag this question for future reference']");
    if (!flagBtn) return;

    console.log("📌 Flag button clicked — extracting question...");

    // Make it visually "disabled" and spinning on hover
    flagBtn.style.opacity = "0.5"; // looks disabled
    flagBtn.style.cursor = "wait";  // spinning cursor
    flagBtn.style.pointerEvents = "none"; // prevent accidental extra clicks

    // Restore pointer events after short delay so action still works
    setTimeout(() => {
        flagBtn.style.pointerEvents = "";
        flagBtn.style.cursor = "";
        flagBtn.style.opacity = "";
    }, 500);

    // Find question wrapper
    const questionDiv = flagBtn.closest(".que");
    if (!questionDiv) {
        console.error("❌ Could not find question wrapper");
        return;
    }

    // Extract question text
    const qTextEl = questionDiv.querySelector(".qtext");
    if (!qTextEl) {
        console.error("❌ No .qtext found");
        return;
    }
    const questionText = qTextEl.innerText.trim();

    const promptText = `Question:\n${questionText}`;
    console.log("📤 Prompt for AI:\n", promptText);

    // Send to AI
    const aiResponse = await getAIResponse(promptText);
    if (!aiResponse?.answer) {
        console.error("❌ AI returned no answer");
        return;
    }
    const finalAnswer = aiResponse.answer.trim();
    console.log("🤖 AI Answer:", finalAnswer);

    // Insert answer into textarea or TinyMCE
    const textarea = questionDiv.querySelector("textarea");
    const tinyMCEArea = questionDiv.querySelector(".tox-tinymce");
    if (tinyMCEArea && textarea?.id) {
        tinymce.get(textarea.id).setContent(finalAnswer);
        console.log("✅ Answer inserted into TinyMCE editor");
    } else if (textarea) {
        textarea.value = finalAnswer;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
        console.log("✅ Answer inserted into textarea");
    } else {
        console.error("❌ No input found to insert answer");
    }
});

// Add spinning cursor on hover
const style = document.createElement("style");
style.innerHTML = `
a.aabtn[title='Flag this question for future reference']:hover {
    cursor: wait !important;
}
`;
document.head.appendChild(style);
