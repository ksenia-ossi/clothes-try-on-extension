// Service worker: контекстное меню, горячая клавиша, сохранение картинок, примерка через Replicate

import {
  toInputUrl,
  reuploadRemoteImage,
  createPrediction,
  waitForPrediction,
  getPrediction,
  firstOutputUrl,
  fetchAsDataUrl,
  verifyToken,
} from "./replicate.js";

const MENU_ID = "clothes-picker-save";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Сохранить картинку в Clothes Picker",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && info.srcUrl) {
    saveImage({ src: info.srcUrl, pageUrl: info.pageUrl || tab?.url, title: tab?.title });
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-picker" && tab?.id) togglePicker(tab.id);
});

// Вкладки, открытые до установки/обновления расширения, не содержат content.js — подгружаем его сами
async function togglePicker(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PICKER" });
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PICKER" });
    } catch {
      // служебные страницы (chrome://, Web Store) — туда скрипты не пускают
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_IMAGE") {
    saveImage(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === "TOGGLE_PICKER_IN_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) togglePicker(tab.id);
    });
  }
  if (msg.type === "START_TRYON") {
    startTryOn(msg.payload).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "VERIFY_TOKEN") {
    verifyToken(msg.token).then(
      (acc) => sendResponse({ ok: true, username: acc.username }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
});

// ---------- сохранение картинок ----------

async function saveImage({ src, pageUrl, title, alt }) {
  if (!src) return { ok: false, reason: "no-src" };
  const { images = [] } = await chrome.storage.local.get("images");
  if (images.some((i) => i.src === src)) return { ok: false, reason: "duplicate" };
  const item = {
    id: crypto.randomUUID(),
    src,
    pageUrl: pageUrl || "",
    title: title || "",
    alt: alt || "",
    savedAt: Date.now(),
  };
  images.unshift(item);
  await chrome.storage.local.set({ images });
  chrome.action.setBadgeText({ text: String(images.length) });
  return { ok: true, item };
}

chrome.storage.local.get("images").then(({ images = [] }) => {
  chrome.action.setBadgeText({ text: images.length ? String(images.length) : "" });
});

// ---------- примерка ----------

// Записи в tryons идут по очереди: параллельные read-modify-write затирали бы друг друга
let jobWrites = Promise.resolve();
function updateJob(id, patch) {
  const write = jobWrites.then(async () => {
    const { tryons = [] } = await chrome.storage.local.get("tryons");
    const idx = tryons.findIndex((t) => t.id === id);
    if (idx === -1) return;
    tryons[idx] = { ...tryons[idx], ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ tryons });
  });
  jobWrites = write.catch(() => {});
  return write;
}

const SLOTS = ["top", "bottom", "shoes"];

async function startTryOn({ slots = {}, prompt, turbo }) {
  const { images = [], profilePhoto, replicateToken, tryons = [] } = await chrome.storage.local.get([
    "images",
    "profilePhoto",
    "replicateToken",
    "tryons",
  ]);
  if (!replicateToken) return { ok: false, error: "Нет API-токена Replicate — добавь его в настройках" };
  if (!profilePhoto?.dataUrl) return { ok: false, error: "Сначала загрузи своё фото" };
  // по одной вещи на слот (Верх / Низ / Обувь), от 1 до 3 вещей
  const garments = [];
  for (const slot of SLOTS) {
    if (!slots[slot]) continue;
    const item = images.find((i) => i.id === slots[slot]);
    if (!item) return { ok: false, error: `Вещь для слота «${slot}» не найдена` };
    if (garments.some((g) => g.id === item.id)) return { ok: false, error: "Одна вещь не может занимать два слота" };
    garments.push({ ...item, slot });
  }
  if (!garments.length) return { ok: false, error: "Выбери хотя бы одну вещь" };

  const job = {
    id: crypto.randomUUID(),
    status: "starting",
    garments: garments.map((g) => ({ id: g.id, src: g.src, slot: g.slot })),
    prompt: prompt || "",
    output: null,
    error: null,
    predictionId: null,
    createdAt: Date.now(),
  };
  tryons.unshift(job);
  await chrome.storage.local.set({ tryons });

  runTryOn(job, { token: replicateToken, personDataUrl: profilePhoto.dataUrl, turbo }).catch((e) =>
    updateJob(job.id, { status: "failed", error: e.message })
  );
  return { ok: true, jobId: job.id };
}

async function runTryOn(job, { token, personDataUrl, turbo }) {
  await updateJob(job.id, { status: "uploading" });
  const personUrl = await toInputUrl(token, personDataUrl, "person.jpg");

  const makeInput = (garmentUrls) => {
    const input = { person_image: personUrl, garment_images: garmentUrls };
    if (job.prompt) input.prompt = job.prompt;
    if (turbo) input.turbo = true;
    return input;
  };

  let prediction;
  try {
    prediction = await runOnce(job, token, makeInput(job.garments.map((g) => g.src)));
  } catch (e) {
    if (!looksLikeFetchProblem(e)) throw e;
    // Магазин не отдал картинку Replicate (hotlink-защита) — скачиваем сами и заливаем
    await updateJob(job.id, { status: "uploading", note: "Перезаливаю картинки вещей…" });
    const urls = [];
    for (const g of job.garments) urls.push(await reuploadRemoteImage(token, g.src));
    prediction = await runOnce(job, token, makeInput(urls));
  }

  await finishJob(job.id, prediction);
}

// Сохраняем результат локально: ссылка Replicate протухает примерно через час
async function finishJob(jobId, prediction) {
  const output = firstOutputUrl(prediction.output);
  if (!output) throw new Error("Модель не вернула картинку");
  await updateJob(jobId, { status: "saving", output, note: null, metrics: prediction.metrics || null });
  let outputDataUrl = null;
  try {
    outputDataUrl = await fetchAsDataUrl(output);
  } catch (e) {
    console.warn("Не удалось сохранить результат локально", e);
  }
  await updateJob(jobId, { status: "succeeded", outputDataUrl });
}

// Service worker могли усыпить посреди примерки — при старте дожидаемся незавершённых предсказаний
async function resumeUnfinished() {
  const { tryons = [], replicateToken } = await chrome.storage.local.get(["tryons", "replicateToken"]);
  for (const job of tryons) {
    const unfinished = ["starting", "uploading", "processing", "saving"].includes(job.status);
    if (!unfinished) continue;
    if (!job.predictionId || !replicateToken) {
      await updateJob(job.id, { status: "failed", error: "Примерка прервалась до отправки — нажми «Повторить»" });
      continue;
    }
    getPrediction(replicateToken, job.predictionId)
      .then((p) => waitForPrediction(replicateToken, p, (u) => updateJob(job.id, { status: u.status })))
      .then((p) => {
        if (p.status !== "succeeded") throw new Error(p.error || `Статус: ${p.status}`);
        return finishJob(job.id, p);
      })
      .catch((e) => updateJob(job.id, { status: "failed", error: e.message }));
  }
}
resumeUnfinished();

async function runOnce(job, token, input) {
  await updateJob(job.id, { status: "processing" });
  let prediction = await createPrediction(token, input);
  await updateJob(job.id, { predictionId: prediction.id });
  prediction = await waitForPrediction(token, prediction, (p) => updateJob(job.id, { status: p.status }));
  if (prediction.status !== "succeeded") {
    throw new Error(prediction.error || `Статус: ${prediction.status}`);
  }
  return prediction;
}

function looksLikeFetchProblem(e) {
  return /download|fetch|403|404|forbidden|not found|timed? ?out|unsupported|could not|invalid image|cannot identify/i.test(
    e.message || ""
  );
}
