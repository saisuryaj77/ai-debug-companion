# AI Debugging Companion (Chrome DevTools extension)

A DevTools panel that watches the page you are inspecting, collects problems, and explains them with AI.

## Features
- Live capture of `console.error`, uncaught exceptions and unhandled promise rejections
- Failed (4xx/5xx/blocked) and slow (>3 s) network requests
- Instant offline "quick hints" for common errors (undefined access, CORS, 404/500, mixed content, hydration)
- **Explain with AI**: cause, fix snippet and how to verify, using the selected element as extra context
- **Explain selected element**: layout and CSS diagnosis for whatever is selected in Elements
- **Audit page**: accessibility, SEO and performance snapshot turned into the top fixes
- Free-form **Ask** box that already knows your recent issues

## Install (2 minutes)
1. Unzip this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder.
4. Open any website, press F12, and open the **AI Debugger** tab (it may be under the `>>` menu).
5. Click the gear icon, paste your Anthropic API key, Save.

## Demo script for judges
1. Open any page, run in the console: `fetch('/nope')` and `null.x` and `Promise.reject(new Error('demo'))`.
2. Watch them appear with quick hints; click **Explain with AI** on one.
3. Select a broken-looking element and press **Explain selected element**.
4. Press **Audit page**.

## Privacy
The API key is stored only in `chrome.storage.local`. Only the issue text, selected element HTML and page snapshot you trigger are sent to the API, and only when you click a button.

## Files
`manifest.json` (MV3), `devtools.html/js` (registers the panel), `panel.html/css/js` (UI and logic).
