// Replicate API client (used in the service worker)

const API = "https://api.replicate.com/v1";
export const MODEL = "prunaai/p-image-try-on";
const DATA_URL_LIMIT = 256 * 1024; // Replicate accepts data URLs only up to 256 KB

function headers(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function parseError(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = j.detail || j.title || JSON.stringify(j);
  } catch {
    detail = await res.text().catch(() => "");
  }
  return new Error(`Replicate ${res.status}: ${detail || res.statusText}`);
}

export async function uploadFile(token, blob, filename = "image.jpg") {
  const form = new FormData();
  form.append("content", blob, filename);
  form.append("type", blob.type || "application/octet-stream");
  const res = await fetch(`${API}/files`, { method: "POST", headers: headers(token), body: form });
  if (!res.ok) throw await parseError(res);
  const file = await res.json();
  return file.urls.get;
}

export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// data URL → URL usable as model input (small ones stay data URLs, large ones go to the Files API)
export async function toInputUrl(token, dataUrl, filename) {
  const approxBytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
  if (approxBytes <= DATA_URL_LIMIT) return dataUrl;
  return uploadFile(token, await dataUrlToBlob(dataUrl), filename);
}

// Download the shop image ourselves and upload it to Replicate — for hotlink-protected shops
export async function reuploadRemoteImage(token, url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Could not download ${url}: ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`Not an image: ${url}`);
  return uploadFile(token, blob, "garment." + (blob.type.split("/")[1] || "jpg"));
}

export async function createPrediction(token, input) {
  const res = await fetch(`${API}/models/${MODEL}/predictions`, {
    method: "POST",
    // no Prefer: wait — a long request could outlive the service worker idle timer, so we poll the status ourselves
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getPrediction(token, id) {
  const res = await fetch(`${API}/predictions/${id}`, { headers: headers(token) });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function waitForPrediction(token, prediction, onUpdate, { intervalMs = 2500, timeoutMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  let p = prediction;
  while (!["succeeded", "failed", "canceled"].includes(p.status)) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the result");
    await new Promise((r) => setTimeout(r, intervalMs));
    p = await getPrediction(token, p.id);
    onUpdate?.(p);
  }
  return p;
}

export function firstOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.find((o) => typeof o === "string") || null;
  if (typeof output === "object") return output.url || output.image || null;
  return null;
}

// Download the result into a data URL — replicate.delivery links live about an hour
export async function fetchAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the result: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function verifyToken(token) {
  const res = await fetch(`${API}/account`, { headers: headers(token) });
  if (!res.ok) throw await parseError(res);
  return res.json();
}
