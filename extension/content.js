// Режим выбора: подсветка картинки под курсором, клик = сохранить

let active = false;
let hovered = null;

// Заглушки lazy-load (data:/blob:, прозрачные 1×1) — не настоящая картинка товара
function isRealUrl(url) {
  return !!url && /^https?:/i.test(url);
}

function largestFromSrcset(srcset) {
  let best = null;
  for (const part of srcset.split(",")) {
    const [url, desc] = part.trim().split(/\s+/);
    const size = desc ? parseFloat(desc) : 1;
    if (isRealUrl(url) && (!best || size > best.size)) best = { url, size };
  }
  return best?.url || null;
}

function getImageSrc(el) {
  if (el.tagName === "IMG") {
    // если IMG ещё показывает крошечную заглушку, настоящий адрес лежит в data-атрибутах
    const tiny = el.naturalWidth > 0 && el.naturalWidth < 40 && el.naturalHeight < 40;
    const lazy = [el.dataset.src, el.dataset.original, el.dataset.lazySrc];
    const live = [el.srcset && largestFromSrcset(el.srcset), el.currentSrc, el.src];
    const candidates = tiny ? lazy : [...live, ...lazy];
    for (const c of candidates) {
      if (isRealUrl(c)) return c;
    }
    return null;
  }

  if (el.tagName === "PICTURE") {
    const img = el.querySelector("img");
    return img ? getImageSrc(img) : null;
  }
  const bg = getComputedStyle(el).backgroundImage;
  const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
  return m && isRealUrl(m[1]) ? m[1] : null;
}

function findImageTarget(el) {
  // ищем картинку в самом элементе или в ближайших предках (карточки товаров часто с оверлеями)
  let node = el;
  for (let i = 0; node && i < 4; i++) {
    const src = getImageSrc(node);
    if (src) return { node, src };
    const inner = node.querySelector?.("img");
    if (inner && getImageSrc(inner)) return { node: inner, src: getImageSrc(inner) };
    node = node.parentElement;
  }
  return null;
}

function onMove(e) {
  const target = findImageTarget(e.target);
  const node = target?.node || null;
  if (node !== hovered) {
    hovered?.classList.remove("cp-hover-outline");
    hovered = node;
    hovered?.classList.add("cp-hover-outline");
  }
}

function onClick(e) {
  const target = findImageTarget(e.target);
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  chrome.runtime.sendMessage(
    {
      type: "SAVE_IMAGE",
      payload: {
        src: target.src,
        pageUrl: location.href,
        title: document.title,
        alt: target.node.alt || "",
      },
    },
    (res) => {
      if (res?.ok) toast("Сохранено ✓");
      else if (res?.reason === "duplicate") toast("Уже сохранено");
      else toast("Не удалось сохранить");
    }
  );
}

function onKey(e) {
  if (e.key === "Escape") setActive(false);
}

function setActive(on) {
  active = on;
  if (on) {
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    showBanner();
  } else {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    hovered?.classList.remove("cp-hover-outline");
    hovered = null;
    document.getElementById("cp-banner")?.remove();
  }
}

function showBanner() {
  if (document.getElementById("cp-banner")) return;
  const b = document.createElement("div");
  b.id = "cp-banner";
  b.textContent = "Режим выбора: кликни по картинке, чтобы сохранить. Esc — выйти";
  document.body.appendChild(b);
}

let toastTimer;
function toast(text) {
  let t = document.getElementById("cp-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "cp-toast";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1500);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TOGGLE_PICKER") setActive(!active);
});
