# Clothes Picker — Chrome extension with virtual try-on

Pick clothing images on any online shop, save them into the extension, then try them on your own photo
through the [Replicate API](https://replicate.com) (model [prunaai/p-image-try-on](https://replicate.com/prunaai/p-image-try-on)).

Side project built to learn Chrome extension development (Manifest V3) and third-party ML APIs.
Vanilla JavaScript, no build step, no backend — everything runs in the browser.

**Stack:** JavaScript (ES modules), Chrome Extensions API (Manifest V3: service worker, content script, popup, `chrome.storage`), Replicate REST API.

## Features

| | Feature | Status |
|---|---|---|
| 1 | Pick images on any website and save them into the extension (3 ways: pick mode, hotkey, context menu) | ✅ done |
| 2 | Upload your own photo and run a virtual try-on through Replicate | ✅ done |
| 3 | Try-on history inside the extension (open / download / repeat / delete) | ✅ done |

The popup UI is in Russian (tabs **«Вещи»** = Items, **«Примерки»** = Try-ons, **«Настройки»** = Settings).

## Install (developer mode)

1. Clone the repository:
   ```bash
   git clone https://github.com/ksenia-ossi/try.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin the extension icon to the toolbar (puzzle icon → pin).

After changing the code, click ↻ on the extension card in `chrome://extensions` and reload the shop page.

## Usage

Three ways to save an image:

1. **Pick mode** — click the extension icon → "Pick images on this page".
   The image under the cursor gets a pink outline; click saves it, `Esc` exits.
2. **Hotkey** — `Alt+Shift+P` toggles pick mode.
3. **Context menu** — right-click any image → "Save image to Clothes Picker".

The **Items** tab of the popup lists every saved image (no limit): delete (×), export to JSON, clear all.
The badge on the icon shows how many images are saved.

## Virtual try-on (Replicate)

1. Get an API token: https://replicate.com/account/api-tokens
2. Popup → **Settings** tab → paste the token → "Save and check". The token is stored only in this browser.
3. **Try-ons** tab → "Upload photo" — a full-body photo of yourself (resized to 1536 px and kept in the extension).
4. **Items** tab → click a card and choose a slot: **Top**, **Bottom** or **Shoes** (at most one item per slot;
   you pick the slot yourself, there is no automatic recognition). Fill one, two or three slots — at least one
   item is required → "Try on". Clicking a selected card again, or × on the slot, clears the selection.
5. A confirmation dialog shows your photo, the selected items and the estimated cost. The request is sent to
   Replicate **only** after you press "Try on" in this dialog; "Cancel" (or Esc) sends nothing.
6. The result appears on the Try-ons tab: open in a new tab, download, repeat, delete.

Extras: a "Model hint" field (e.g. `the red dress from image 1` when a photo contains several garments) and a Turbo mode (faster).

Cost: $0.015 for the first garment + $0.008 for each additional one (charged to your Replicate account).

### How it works

```
popup.js  ──START_TRYON──▶  background.js  ──▶  replicate.js
                              │  1. photo → data URL (≤256 KB) or POST /v1/files
                              │  2. POST /v1/models/prunaai/p-image-try-on/predictions
                              │     { person_image, garment_images: [url, …], prompt?, turbo? }
                              │     header Prefer: wait=60
                              │  3. GET /v1/predictions/{id} every 2.5 s until succeeded/failed
                              │  4. if the shop blocks the image (hotlink protection) — download it
                              │     ourselves, upload to /v1/files and retry
                              ▼
                 chrome.storage.local.tryons[] → popup re-renders the results
```

## Project structure

```
extension/
├── manifest.json   # Manifest V3: permissions, content script, popup, hotkey
├── background.js   # service worker (ES module): context menu, saving, launching try-ons
├── replicate.js    # Replicate API client: files, predictions, polling
├── content.js      # pick mode on the page: highlight and click an image
├── content.css     # styles for the outline / banner / toast on the page
├── popup.html/css/js  # tabs Items / Try-ons / Settings
└── icons/
```

## Where the data lives

`chrome.storage.local`, key `images`:

```json
[
  {
    "id": "uuid",
    "src": "https://shop.example/img/dress.jpg",
    "pageUrl": "https://shop.example/item/123",
    "title": "Dress — Shop",
    "alt": "Red dress",
    "savedAt": 1700000000000,
    "slot": "top"
  }
]
```

`src` is the image URL passed to the model as `garment_images`. `slot` (`top` / `bottom` / `shoes`) appears
once you assign the item to a slot — it only remembers your choice, there is no recognition.

Other keys in `chrome.storage.local`:

| Key | What |
|---|---|
| `profilePhoto` | `{ dataUrl, name, updatedAt }` — your photo (JPEG, ≤1536 px) |
| `replicateToken` | Replicate API token |
| `tryons` | `[{ id, status, garments: [{id, src, slot}], prompt, output, error, predictionId, createdAt }]` — try-on history |

## Known limitations

- The extension stores a link to the image, not the file itself. If the shop blocks direct links (hotlink
  protection) the preview in the popup may not show; for a try-on the extension downloads the image itself
  and uploads it to Replicate.
- Replicate result URLs expire after a limited time (about an hour) — download the results you like with the "Download" button.
- The token is stored in `chrome.storage.local` in plain text — the extension is meant for personal use, do not publish it with a token inside.
- Pick mode does not work on Chrome internal pages (`chrome://…`) and in the Chrome Web Store.
