// AI Debugging Companion - DevTools panel logic
const $ = (s) => document.querySelector(s);
const issues = [];
const seen = new Set();
const MAX_ISSUES = 100;

if (chrome.devtools.panels.themeName === 'dark') document.body.classList.add('dark');

// ---------- Page hook: captures console.error, exceptions, rejected promises ----------
const HOOK = `(function(){
  if (window.__aiDbg) return;
  var s = window.__aiDbg = { q: [] };
  function push(type, message, stack) {
    s.q.push({ type: type, message: String(message).slice(0, 1000), stack: stack ? String(stack).slice(0, 1500) : '', page: location.href });
  }
  var oe = console.error;
  console.error = function () {
    try {
      push('console.error', Array.prototype.map.call(arguments, function (a) {
        try { return a && a.stack ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a)); } catch (e) { return String(a); }
      }).join(' '));
    } catch (e) {}
    return oe.apply(console, arguments);
  };
  window.addEventListener('error', function (e) {
    push('exception', e.message + ' at ' + e.filename + ':' + e.lineno + ':' + e.colno, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    push('promise', (r && r.message) || r, r && r.stack);
  });
})()`;

function installHook() {
  chrome.devtools.inspectedWindow.eval(HOOK, () => {});
}

function drain() {
  chrome.devtools.inspectedWindow.eval(
    '(function(){return window.__aiDbg ? window.__aiDbg.q.splice(0) : null})()',
    (result, exc) => {
      if (exc || result === undefined) return;
      if (result === null) { installHook(); return; }
      result.forEach(addIssue);
    }
  );
}

// ---------- Network failures and slow requests ----------
chrome.devtools.network.onRequestFinished.addListener((req) => {
  const st = req.response.status;
  const url = req.request.url;
  if (st >= 400 || st === 0) {
    addIssue({
      type: 'network',
      message: `${req.request.method} ${url} -> ${st} ${req.response.statusText || ''}`.trim(),
      status: st,
      page: ''
    });
  } else if (req.time > 3000) {
    addIssue({ type: 'perf', message: `Slow request (${Math.round(req.time)} ms): ${url}`, page: '' });
  }
});

chrome.devtools.network.onNavigated.addListener(() => { setTimeout(installHook, 100); });

// ---------- Issues list ----------
function addIssue(i) {
  const key = i.type + '|' + i.message;
  if (seen.has(key)) return;
  seen.add(key);
  if (issues.length >= MAX_ISSUES) return;
  issues.push(i);
  renderIssue(i, issues.length - 1);
  $('#count').textContent = `${issues.length} issue${issues.length === 1 ? '' : 's'}`;
}

function renderIssue(i, idx) {
  const ul = $('#issues');
  if (idx === 0) ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'issue';
  const hint = quickHint(i);
  li.innerHTML =
    `<span class="badge ${esc(i.type)}">${esc(i.type)}</span><span class="msg">${esc(i.message)}</span>` +
    (hint ? `<div class="hint">Quick hint: ${esc(hint)}</div>` : '') +
    `<div class="row"><button class="primary">Explain with AI</button></div>`;
  li.querySelector('button').addEventListener('click', () => explainIssue(i));
  ul.appendChild(li);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Offline rule-based hints (work without an API key) ----------
function quickHint(i) {
  const m = i.message;
  if (/Cannot read propert(y|ies) of (undefined|null)/i.test(m)) return 'Something is undefined/null before you access a property. Guard with optional chaining (obj?.prop) or check the data has loaded.';
  if (/is not a function/i.test(m)) return 'You are calling something that is not a function. Check the import/spelling and what the value actually is.';
  if (/is not defined/i.test(m)) return 'Variable used before it exists. Check spelling, scope, and script load order.';
  if (/CORS|Access-Control-Allow-Origin/i.test(m)) return 'The server must send Access-Control-Allow-Origin for your origin, or call it through your own backend/proxy.';
  if (/Mixed Content/i.test(m)) return 'An https page is loading an http resource. Switch that URL to https.';
  if (/Unexpected token '?<'?/i.test(m)) return 'You received HTML (often a 404/500 page) where JS or JSON was expected. Check the URL and the response.';
  if (/Failed to fetch|NetworkError|net::ERR/i.test(m)) return 'Request never completed: offline, blocked by CORS/adblock, DNS or server down.';
  if (/Hydration|did not match/i.test(m)) return 'Server-rendered HTML differs from client render. Avoid Date/random/window-dependent output during first render.';
  if (i.type === 'network') {
    const s = i.status;
    if (s === 404) return '404: wrong URL or missing file. Check the path and base URL.';
    if (s === 401 || s === 403) return `${s}: missing or invalid credentials or permissions.`;
    if (s >= 500) return `${s}: the server crashed. Check server logs for this request.`;
    if (s === 0) return 'Blocked or failed before a response (CORS, offline, extension, mixed content).';
  }
  return '';
}

// ---------- AI ----------
const SYSTEM = 'You are an expert web debugging assistant inside Chrome DevTools. Be concise and practical. Format: 1) Cause (1-2 sentences) 2) Fix (a short code snippet in a fenced block if useful) 3) How to verify. Do not invent facts about code you cannot see; say what to check instead.';

async function askAI(prompt) {
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  if (!apiKey) throw new Error('No API key yet. Open settings (gear icon), paste your key, and save.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-5-5',
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return data.content.map((c) => c.text || '').join('');
}

function evalInPage(expr) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expr, (r, exc) => resolve(exc ? null : r));
  });
}

async function run(prompt) {
  const out = $('#out');
  out.classList.remove('muted');
  out.textContent = 'Thinking...';
  try {
    out.innerHTML = renderMd(await askAI(prompt));
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

function renderMd(t) {
  const parts = String(t).split(/```[a-z]*\n?/i);
  return parts.map((p, n) => (n % 2 ? `<pre><code>${esc(p)}</code></pre>` : esc(p).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'))).join('');
}

async function explainIssue(i) {
  const el = await evalInPage('(function(){var e=$0;return e?e.outerHTML.slice(0,800):null})()');
  await run(
    `Explain and fix this browser issue.\nType: ${i.type}\nMessage: ${i.message}\nStack: ${i.stack || 'n/a'}\nPage: ${i.page || 'n/a'}\n` +
    (el ? `Currently selected element:\n${el}\n` : '')
  );
}

$('#elBtn').addEventListener('click', async () => {
  const info = await evalInPage(`(function(){
    var e=$0; if(!e) return null; var c=getComputedStyle(e);
    return { html:e.outerHTML.slice(0,1500), box:e.getBoundingClientRect().toJSON(),
      css:{display:c.display,position:c.position,width:c.width,height:c.height,overflow:c.overflow,zIndex:c.zIndex,color:c.color,background:c.backgroundColor,fontSize:c.fontSize} };
  })()`);
  if (!info) { $('#out').textContent = 'Select an element in the Elements panel first.'; return; }
  run(`Explain how this element is laid out and list likely reasons it may look wrong (overflow, clipping, z-index, contrast, spacing). Suggest CSS fixes.\n${JSON.stringify(info, null, 1)}`);
});

$('#auditBtn').addEventListener('click', async () => {
  const data = await evalInPage(`(function(){
    var q=function(s){return document.querySelectorAll(s)};
    var nav=performance.getEntriesByType('navigation')[0]||{};
    return {
      url:location.href, title:document.title, lang:document.documentElement.lang||null,
      hasViewportMeta:!!document.querySelector('meta[name=viewport]'),
      hasH1:q('h1').length, imagesNoAlt:q('img:not([alt])').length,
      buttonsNoText:Array.prototype.filter.call(q('button'),function(b){return !b.textContent.trim()&&!b.getAttribute('aria-label')}).length,
      inputsNoLabel:Array.prototype.filter.call(q('input:not([type=hidden])'),function(i){return !i.labels||!i.labels.length}).length - Array.prototype.filter.call(q('input[aria-label]'),function(){return true}).length,
      domNodes:q('*').length, scripts:q('script').length, stylesheets:q('link[rel=stylesheet]').length,
      loadMs:Math.round(nav.loadEventEnd||0), domReadyMs:Math.round(nav.domContentLoadedEventEnd||0)
    };
  })()`);
  if (!data) { $('#out').textContent = 'Could not read the page (restricted page?).'; return; }
  run(`Audit this page snapshot for accessibility, SEO basics, and performance. Give the top 5 fixes in priority order, each one line plus a tiny snippet when helpful.\n${JSON.stringify(data, null, 1)}\nIssues captured so far: ${issues.slice(0, 10).map((x) => x.message).join(' | ') || 'none'}`);
});

$('#askBtn').addEventListener('click', () => {
  const q = $('#ask').value.trim();
  if (!q) return;
  run(`Question from a developer debugging a page.\nQuestion: ${q}\nRecent issues: ${issues.slice(-8).map((x) => `[${x.type}] ${x.message}`).join('\n') || 'none'}`);
});
$('#ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#askBtn').click(); });

$('#clearBtn').addEventListener('click', () => {
  issues.length = 0;
  seen.clear();
  $('#issues').innerHTML = '<li class="muted">Cleared.</li>';
  $('#count').textContent = '';
});

// ---------- Settings ----------
$('#settingsBtn').addEventListener('click', () => { $('#settings').hidden = !$('#settings').hidden; });
chrome.storage.local.get(['apiKey', 'model'], (v) => {
  $('#apiKey').value = v.apiKey || '';
  $('#model').value = v.model || '';
  if (!v.apiKey) $('#settings').hidden = false;
});
$('#saveBtn').addEventListener('click', () => {
  chrome.storage.local.set({ apiKey: $('#apiKey').value.trim(), model: $('#model').value.trim() }, () => { $('#settings').hidden = true; });
});

installHook();
setInterval(drain, 1500);
