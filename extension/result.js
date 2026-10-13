// Full-page view of a result from local storage (Replicate links are temporary)
(async () => {
  const id = new URLSearchParams(location.search).get("id");
  const { tryons = [] } = await chrome.storage.local.get("tryons");
  const job = tryons.find((t) => t.id === id);
  const msg = document.getElementById("msg");
  const src = job?.outputDataUrl || job?.output;
  if (!src) {
    msg.textContent = "Result not found — the try-on may have been deleted";
    return;
  }
  const img = document.getElementById("img");
  img.src = src;
  img.hidden = false;
  msg.hidden = true;
  const btn = document.getElementById("download");
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    const blob = await (await fetch(src)).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tryon-${id.slice(0, 8)}.${(blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
})();
