const $ = (sel) => document.querySelector(sel);

const MAX_PHOTO_SIDE = 1536;

// Try-on slots: at most one item in each, at least one filled
const SLOTS = ["top", "bottom"];
const SLOT_NAMES = { top: "Top", bottom: "Bottom" };
const slotSelection = { top: null, bottom: null }; // slot → image id
let openMenuCardId = null;

// ---------- tabs ----------

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
    chrome.storage.local.set({ activeTab: btn.dataset.tab });
  });
});

function showTab(name) {
  document.querySelector(`.tabs button[data-tab="${name}"]`)?.click();
}

// ---------- items ----------

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function slotOf(id) {
  return SLOTS.find((slot) => slotSelection[slot] === id) || null;
}

async function renderImages() {
  const { images = [] } = await chrome.storage.local.get("images");
  const grid = $("#grid");
  grid.innerHTML = "";
  $("#empty").style.display = images.length ? "none" : "block";
  $("#count").textContent = images.length ? `${images.length} saved` : "";
  for (const slot of SLOTS) if (slotSelection[slot] && !images.some((i) => i.id === slotSelection[slot])) slotSelection[slot] = null;
  if (openMenuCardId && !images.some((i) => i.id === openMenuCardId)) openMenuCardId = null;

  for (const item of images) {
    const inSlot = slotOf(item.id);
    const badgeSlot = inSlot || item.slot;
    const card = document.createElement("div");
    card.className = "card" + (inSlot ? " selected" : "");
    card.dataset.id = item.id;
    card.innerHTML = `
      <img src="${item.src}" alt="" loading="lazy" />
      ${badgeSlot ? `<div class="badge">${SLOT_NAMES[badgeSlot]}</div>` : ""}
      <button class="del" title="Delete">×</button>
      <a href="${item.pageUrl}" target="_blank" title="${item.pageUrl}">${hostOf(item.pageUrl)}</a>`;
    if (openMenuCardId === item.id) card.appendChild(buildSlotMenu(item));
    card.addEventListener("click", (e) => {
      if (e.target.closest(".del, a, .slot-menu")) return;
      onCardClick(item);
    });
    card.querySelector(".del").addEventListener("click", () => removeImage(item.id));
    grid.appendChild(card);
  }
  renderSlots(images);
}

function buildSlotMenu(item) {
  const menu = document.createElement("div");
  menu.className = "slot-menu";
  menu.innerHTML = `<div class="slot-menu-title">Which slot?</div>`;
  for (const slot of SLOTS) {
    const b = document.createElement("button");
    b.textContent = SLOT_NAMES[slot];
    b.dataset.slot = slot;
    if (item.slot === slot) b.classList.add("current");
    b.addEventListener("click", () => assignToSlot(item, slot));
    menu.appendChild(b);
  }
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => { openMenuCardId = null; renderImages(); });
  menu.appendChild(cancel);
  return menu;
}

function onCardClick(item) {
  const inSlot = slotOf(item.id);
  if (inSlot) {
    slotSelection[inSlot] = null; // clicking again deselects
    openMenuCardId = null;
  } else {
    openMenuCardId = openMenuCardId === item.id ? null : item.id;
  }
  renderImages();
}

async function assignToSlot(item, slot) {
  slotSelection[slot] = item.id;
  openMenuCardId = null;
  if (item.slot !== slot) {
    // remember the chosen slot on the item — no auto-recognition, only what the user picked
    const { images = [] } = await chrome.storage.local.get("images");
    const idx = images.findIndex((i) => i.id === item.id);
    if (idx !== -1) {
      images[idx] = { ...images[idx], slot };
      await chrome.storage.local.set({ images });
      return; // storage.onChanged re-renders
    }
  }
  renderImages();
}

function renderSlots(images) {
  let filled = 0;
  for (const el of document.querySelectorAll("#slots .slot")) {
    const slot = el.dataset.slot;
    const item = images.find((i) => i.id === slotSelection[slot]);
    el.classList.toggle("filled", !!item);
    el.querySelector(".slot-thumb").innerHTML = item ? `<img src="${item.src}" alt="" />` : "+";
    if (item) filled++;
  }
  $("#start-tryon").disabled = filled === 0;
  $("#selected-count").textContent = filled
    ? `${filled} of 2 selected`
    : "Select a top and/or a bottom";
}

document.querySelectorAll("#slots .slot-clear").forEach((btn) => {
  btn.addEventListener("click", () => {
    slotSelection[btn.closest(".slot").dataset.slot] = null;
    renderImages();
  });
});

async function removeImage(id) {
  const { images = [] } = await chrome.storage.local.get("images");
  const next = images.filter((i) => i.id !== id);
  await chrome.storage.local.set({ images: next });
  chrome.action.setBadgeText({ text: next.length ? String(next.length) : "" });
}

$("#toggle").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_PICKER_IN_TAB" });
  window.close();
});

$("#clear").addEventListener("click", async () => {
  if (!confirm("Delete all saved images?")) return;
  await chrome.storage.local.set({ images: [] });
  chrome.action.setBadgeText({ text: "" });
});

$("#export").addEventListener("click", async () => {
  const { images = [] } = await chrome.storage.local.get("images");
  downloadBlob(new Blob([JSON.stringify(images, null, 2)], { type: "application/json" }), "clothes-picker.json");
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- starting a try-on ----------

$("#start-tryon").addEventListener("click", async () => {
  const { profilePhoto, replicateToken } = await chrome.storage.local.get(["profilePhoto", "replicateToken"]);
  if (!replicateToken) { showTab("settings"); setTokenStatus("Add your Replicate API token first", "err"); return; }
  if (!profilePhoto?.dataUrl) { showTab("tryon"); $("#photo-pick").focus(); return; }

  openConfirm({
    slots: { ...slotSelection },
    prompt: $("#prompt").value.trim(),
    turbo: $("#turbo").checked,
    onStarted: () => { for (const slot of SLOTS) slotSelection[slot] = null; renderImages(); showTab("tryon"); },
  });
});

// ---------- try-on confirmation ----------
// The request goes to Replicate only after pressing "Try on" in this dialog; "Cancel" sends nothing.

const PRICE_FIRST = 0.015;
const PRICE_EXTRA = 0.008;
let pendingTryOn = null;

function estimateCost(n) {
  return n ? PRICE_FIRST + PRICE_EXTRA * (n - 1) : 0;
}

async function openConfirm(payload) {
  const { images = [], profilePhoto } = await chrome.storage.local.get(["images", "profilePhoto"]);
  const garments = SLOTS.map((slot) => {
    const item = images.find((i) => i.id === payload.slots[slot]);
    return item ? { ...item, slot } : null;
  }).filter(Boolean);
  if (!garments.length) { alert("Select at least one item"); return; }

  pendingTryOn = payload;
  $("#confirm-photo").innerHTML = profilePhoto?.dataUrl ? `<img src="${profilePhoto.dataUrl}" alt="My photo" />` : "";
  $("#confirm-garments").innerHTML = garments
    .map((g) => `<div class="confirm-garment"><img src="${g.src}" alt="" title="${g.src}" /><span>${SLOT_NAMES[g.slot]}</span></div>`)
    .join("");
  const n = garments.length;
  $("#confirm-cost").innerHTML =
    `${n} ${n === 1 ? "item" : "items"}${payload.turbo ? " · Turbo" : ""} · ≈ <strong>$${estimateCost(n).toFixed(3)}</strong>`;
  $("#confirm").classList.remove("hidden");
  $("#confirm-ok").focus();
}

function closeConfirm() {
  pendingTryOn = null;
  $("#confirm").classList.add("hidden");
}

$("#confirm-cancel").addEventListener("click", closeConfirm);
$("#confirm").addEventListener("click", (e) => { if (e.target === $("#confirm")) closeConfirm(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#confirm").classList.contains("hidden")) closeConfirm();
});

$("#confirm-ok").addEventListener("click", async () => {
  if (!pendingTryOn) return;
  const { slots, prompt, turbo, onStarted } = pendingTryOn;
  const btn = $("#confirm-ok");
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "START_TRYON", payload: { slots, prompt, turbo } });
  btn.disabled = false;
  closeConfirm();
  if (!res?.ok) { alert(res?.error || "Could not start the try-on"); return; }
  onStarted?.();
});


// ---------- my photo ----------

$("#photo-pick").addEventListener("click", () => $("#photo-input").click());
$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, MAX_PHOTO_SIDE);
    await chrome.storage.local.set({ profilePhoto: { dataUrl, name: file.name, updatedAt: Date.now() } });
  } catch (err) {
    alert("Could not process the photo: " + err.message);
  }
});
$("#photo-remove").addEventListener("click", () => chrome.storage.local.remove("profilePhoto"));

async function resizeImage(file, maxSide) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function renderPhoto() {
  const { profilePhoto } = await chrome.storage.local.get("profilePhoto");
  const preview = $("#photo-preview");
  if (profilePhoto?.dataUrl) {
    preview.innerHTML = `<img src="${profilePhoto.dataUrl}" alt="My photo" />`;
    $("#photo-pick").textContent = "Replace photo";
    $("#photo-remove").classList.remove("hidden");
  } else {
    preview.innerHTML = `<span class="photo-placeholder">No photo</span>`;
    $("#photo-pick").textContent = "Upload photo";
    $("#photo-remove").classList.add("hidden");
  }
}

// ---------- results ----------

const STATUS_TEXT = {
  starting: "Starting…",
  uploading: "Uploading photo…",
  processing: "Model is running…",
  saving: "Saving result…",
  succeeded: "Done",
  failed: "Error",
  canceled: "Canceled",
};

async function renderResults() {
  const { tryons = [], images = [] } = await chrome.storage.local.get(["tryons", "images"]);
  const box = $("#results");
  box.innerHTML = "";
  $("#results-empty").style.display = tryons.length ? "none" : "block";
  for (const job of tryons) {
    const el = document.createElement("div");
    el.className = "result";
    const done = job.status === "succeeded";
    const failed = job.status === "failed" || job.status === "canceled";
    const busy = !done && !failed;
    el.innerHTML = `
      <div class="out">${done ? `<img src="${resultSrc(job)}" alt="Result" />` : failed ? "✕" : `<span class="spinner"></span>`}</div>
      <div class="meta">
        <div class="garments">${job.garments.map((g) => `<img src="${g.src}" alt="" title="${g.slot ? SLOT_NAMES[g.slot] + ": " : ""}${g.src}" />`).join("")}</div>
        <div class="status-line ${failed ? "err" : ""}">
          ${busy ? `<span class="spinner"></span>` : ""}${STATUS_TEXT[job.status] || job.status}${job.note ? ` · ${job.note}` : ""}
          ${failed && job.error ? `<br>${escapeHtml(job.error)}` : ""}
        </div>
        <div class="hint">${new Date(job.createdAt).toLocaleString()}</div>
        <div class="links"></div>
      </div>`;
    const links = el.querySelector(".links");
    if (done) {
      links.append(
        button("Open", () => chrome.tabs.create({ url: chrome.runtime.getURL(`result.html?id=${job.id}`) })),
        button("Download", () => downloadResult(job)),
      );
    }
    if (failed) links.append(button("Retry", () => retry(job, images)));
    links.append(button("Delete", () => removeJob(job.id), "danger"));
    box.appendChild(el);
  }
}

function button(text, onClick, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Local copy of the result if it was stored; otherwise the temporary Replicate link
function resultSrc(job) {
  return job.outputDataUrl || job.output;
}

async function downloadResult(job) {
  try {
    const res = await fetch(resultSrc(job));
    const blob = await res.blob();
    downloadBlob(blob, `tryon-${job.id.slice(0, 8)}.${(blob.type.split("/")[1] || "png").replace("jpeg", "jpg")}`);
  } catch {
    chrome.tabs.create({ url: job.output });
  }
}

async function retry(job, images) {
  const slots = { top: null, bottom: null };
  for (const g of job.garments) {
    if (g.slot && images.some((i) => i.id === g.id)) slots[g.slot] = g.id;
  }
  if (!Object.values(slots).some(Boolean)) { alert("The items of this try-on have been deleted"); return; }
  openConfirm({ slots, prompt: job.prompt, turbo: $("#turbo").checked });
}

async function removeJob(id) {
  const { tryons = [] } = await chrome.storage.local.get("tryons");
  await chrome.storage.local.set({ tryons: tryons.filter((t) => t.id !== id) });
}

// ---------- settings ----------

function setTokenStatus(text, cls = "") {
  const s = $("#token-status");
  s.textContent = text;
  s.className = "status " + cls;
}

$("#token-save").addEventListener("click", async () => {
  const token = $("#token").value.trim();
  if (!token) {
    await chrome.storage.local.remove("replicateToken");
    setTokenStatus("Token removed");
    return;
  }
  setTokenStatus("Checking…");
  const res = await chrome.runtime.sendMessage({ type: "VERIFY_TOKEN", token });
  if (res?.ok) {
    await chrome.storage.local.set({ replicateToken: token });
    setTokenStatus(`Saved · account ${res.username}`, "ok");
  } else {
    setTokenStatus(res?.error || "Token was rejected", "err");
  }
});

async function renderSettings() {
  const { replicateToken } = await chrome.storage.local.get("replicateToken");
  if (replicateToken) {
    $("#token").value = replicateToken;
    setTokenStatus("Token saved", "ok");
  }
}

// ---------- init ----------

chrome.storage.onChanged.addListener((changes) => {
  if (changes.images) renderImages();
  if (changes.profilePhoto) renderPhoto();
  if (changes.tryons || changes.images) renderResults();
});

(async () => {
  const { activeTab } = await chrome.storage.local.get("activeTab");
  if (activeTab) showTab(activeTab);
  renderImages();
  renderPhoto();
  renderResults();
  renderSettings();
})();
