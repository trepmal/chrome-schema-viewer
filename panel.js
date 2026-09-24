'use strict';

// Runs in the inspected page. Returns every <script type=...> so the panel
// can decide what to show; parsing happens here in the panel, not the page.
const COLLECT = `(() => {
  const scripts = [];
  document.querySelectorAll('script[type]').forEach((s) => {
    scripts.push({
      type: (s.getAttribute('type') || '').trim().toLowerCase(),
      text: s.textContent,
      id: s.id || '',
      where: s.closest('head') ? 'head' : 'body',
    });
  });
  const meta = [];
  document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
    const key = (m.getAttribute('property') || m.getAttribute('name') || '').trim();
    if (/^(og|article|profile|book|music|video|fb|twitter):/i.test(key)) {
      meta.push({ key, content: m.getAttribute('content') || '' });
    }
  });
  return { url: location.href, ready: document.readyState, scripts, meta };
})()`;

const OG_REQUIRED = ['og:title', 'og:type', 'og:image', 'og:url'];

const DEFAULT_OPEN_DEPTH = 2;

const $ = (id) => document.getElementById(id);
const output = $('output');
const summary = $('summary');

let lastResult = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isLdJson(type) {
  return type === 'application/ld+json';
}

function isOtherJson(type) {
  return !isLdJson(type) && /json/.test(type);
}

function inspect() {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(COLLECT, (result, err) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// ---------- @type summary ----------

function typesOf(value) {
  const types = [];
  const add = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(add);
    const t = node['@type'];
    if (t) types.push(...(Array.isArray(t) ? t : [t]).map(String));
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(add);
  };
  add(value);
  return types;
}

// ---------- Tree rendering ----------

function renderPrimitive(value) {
  if (value === null) return el('span', 'nl', 'null');
  switch (typeof value) {
    case 'string': {
      const span = el('span', 's');
      if (/^https?:\/\//i.test(value)) {
        const a = el('a', '', JSON.stringify(value));
        a.href = value;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        span.appendChild(a);
      } else {
        span.textContent = JSON.stringify(value);
      }
      return span;
    }
    case 'number': return el('span', 'n', String(value));
    case 'boolean': return el('span', 'b', String(value));
    default: return el('span', '', String(value));
  }
}

function renderKey(key) {
  if (key === null) return null;
  const isAt = typeof key === 'string' && key.startsWith('@');
  const frag = document.createDocumentFragment();
  frag.appendChild(el('span', isAt ? 'k at' : 'k', typeof key === 'number' ? String(key) : key));
  frag.appendChild(document.createTextNode(': '));
  return frag;
}

function renderNode(key, value, depth) {
  const li = el('li');
  li.dataset.search = (key === null ? '' : String(key)).toLowerCase();

  if (value === null || typeof value !== 'object') {
    li.classList.add('leaf');
    const k = renderKey(key);
    if (k) li.appendChild(k);
    li.appendChild(renderPrimitive(value));
    li.dataset.search += ' ' + String(value).toLowerCase();
    return li;
  }

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);

  const details = el('details');
  details.open = depth < DEFAULT_OPEN_DEPTH;
  const sum = el('summary');
  const k = renderKey(key);
  if (k) sum.appendChild(k);

  if (!isArr && value['@type']) {
    const t = Array.isArray(value['@type']) ? value['@type'].join(', ') : String(value['@type']);
    sum.appendChild(el('span', 'type-badge', t));
    sum.appendChild(document.createTextNode(' '));
  }
  sum.appendChild(el('span', 'hint',
    isArr ? `[${entries.length}]` : `{${entries.length}}`));
  details.appendChild(sum);

  const ul = el('ul');
  for (const [ck, cv] of entries) ul.appendChild(renderNode(ck, cv, depth + 1));
  details.appendChild(ul);
  li.appendChild(details);
  return li;
}

function renderTree(value) {
  const ul = el('ul', 'tree');
  ul.appendChild(renderNode(null, value, 0));
  return ul;
}

// ---------- Blocks ----------

function copyText(text) {
  const ta = el('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function renderBlock(script, n, raw) {
  const block = el('section', 'block');
  const head = el('div', 'block-head');
  const body = el('div', 'block-body');

  head.appendChild(el('span', 'title', `#${n}`));
  head.appendChild(el('span', 'meta', script.type));

  let parsed;
  let error = null;
  try {
    parsed = JSON.parse(script.text);
  } catch (e) {
    error = e.message;
  }

  if (!error) {
    for (const t of typesOf(parsed)) head.appendChild(el('span', 'type-badge', t));
  }

  const meta = [`in <${script.where}>`];
  if (script.id) meta.push(`id="${script.id}"`);
  meta.push(`${script.text.length.toLocaleString()} chars`);
  head.appendChild(el('span', 'meta', meta.join(' · ')));
  head.appendChild(el('span', 'spacer'));

  const copyBtn = el('button', '', 'Copy');
  copyBtn.addEventListener('click', () => {
    copyText(error ? script.text : JSON.stringify(parsed, null, 2));
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  });
  head.appendChild(copyBtn);

  if (error) {
    block.classList.add('error');
    body.appendChild(el('div', 'error-msg', `Invalid JSON: ${error}`));
    body.appendChild(el('pre', 'raw', script.text));
  } else if (raw) {
    body.appendChild(el('pre', 'raw', JSON.stringify(parsed, null, 2)));
  } else {
    body.appendChild(renderTree(parsed));
  }

  block.appendChild(head);
  block.appendChild(body);
  return { block, types: error ? [] : typesOf(parsed), error: !!error };
}

// ---------- Open Graph / Twitter meta ----------

function renderValue(value) {
  if (/^https?:\/\//i.test(value)) {
    const a = el('a', '', value);
    a.href = value;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  return document.createTextNode(value);
}

function renderPreview(tags, prefix) {
  const get = (k) => (tags.find((t) => t.key.toLowerCase() === prefix + k) || {}).content;
  const title = get('title');
  const desc = get('description');
  const image = get('image') || get('image:src') || get('image:url');
  const site = get('site_name') || get('site');
  if (!title && !image) return null;

  const card = el('div', 'og-card');
  if (image && /^https?:\/\//i.test(image)) {
    const img = el('img');
    img.src = image;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }
  const text = el('div', 'og-card-text');
  if (site) text.appendChild(el('div', 'og-site', site));
  if (title) text.appendChild(el('div', 'og-title', title));
  if (desc) text.appendChild(el('div', 'og-desc', desc));
  card.appendChild(text);
  return card;
}

function renderMetaBlock(title, tags, prefix, required) {
  const block = el('section', 'block meta-block');
  const head = el('div', 'block-head');
  const body = el('div', 'block-body');

  head.appendChild(el('span', 'title', title));
  head.appendChild(el('span', 'meta', `${tags.length} tag${tags.length === 1 ? '' : 's'}`));

  const keys = new Set(tags.map((t) => t.key.toLowerCase()));
  const missing = required.filter((k) => !keys.has(k));
  if (missing.length) {
    head.appendChild(el('span', 'warn', `Missing: ${missing.join(', ')}`));
  }
  head.appendChild(el('span', 'spacer'));

  const copyBtn = el('button', '', 'Copy');
  copyBtn.addEventListener('click', () => {
    copyText(tags.map((t) => `${t.key}\t${t.content}`).join('\n'));
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  });
  head.appendChild(copyBtn);

  const preview = renderPreview(tags, prefix);
  if (preview) body.appendChild(preview);

  const table = el('table', 'meta-table');
  for (const { key, content } of tags) {
    const tr = el('tr');
    tr.dataset.search = (key + ' ' + content).toLowerCase();
    tr.appendChild(el('td', 'k', key));
    const td = el('td', 's');
    td.appendChild(renderValue(content));
    tr.appendChild(td);
    table.appendChild(tr);
  }
  body.appendChild(table);

  block.appendChild(head);
  block.appendChild(body);
  return block;
}

function renderMeta(meta) {
  const og = meta.filter((m) => !/^twitter:/i.test(m.key));
  const tw = meta.filter((m) => /^twitter:/i.test(m.key));
  if (og.length) output.appendChild(renderMetaBlock('Open Graph', og, 'og:', OG_REQUIRED));
  if (tw.length) output.appendChild(renderMetaBlock('Twitter / X Card', tw, 'twitter:', ['twitter:card']));
  return { og: og.length, tw: tw.length };
}

function render() {
  output.replaceChildren();
  if (!lastResult) return;

  const { url, scripts, meta = [] } = lastResult;
  const includeOther = $('allJson').checked;
  const raw = $('raw').checked;
  const showMeta = $('showMeta').checked;

  $('validate').href = 'https://validator.schema.org/#url=' + encodeURIComponent(url);
  $('richResults').href = 'https://search.google.com/test/rich-results?url=' + encodeURIComponent(url);

  const shown = scripts.filter((s) => isLdJson(s.type) || (includeOther && isOtherJson(s.type)));

  const allTypes = [];
  let errors = 0;
  shown.forEach((s, i) => {
    const { block, types, error } = renderBlock(s, i + 1, raw);
    allTypes.push(...types);
    if (error) errors++;
    output.appendChild(block);
  });

  if (!shown.length) {
    output.appendChild(el('div', 'empty',
      includeOther ? 'No JSON script tags found on this page.' : 'No application/ld+json found on this page.'));
  }

  const metaCounts = showMeta ? renderMeta(meta) : { og: 0, tw: 0 };

  const counts = {};
  for (const t of allTypes) counts[t] = (counts[t] || 0) + 1;
  const typeList = Object.entries(counts)
    .map(([t, c]) => (c > 1 ? `${t} ×${c}` : t))
    .join(', ');

  const parts = [];
  if (shown.length) {
    parts.push(`${shown.length} block${shown.length === 1 ? '' : 's'}`
      + (errors ? ` (${errors} invalid)` : '')
      + (typeList ? `: ${typeList}` : ''));
  }
  if (metaCounts.og) parts.push(`${metaCounts.og} Open Graph tag${metaCounts.og === 1 ? '' : 's'}`);
  if (metaCounts.tw) parts.push(`${metaCounts.tw} Twitter tag${metaCounts.tw === 1 ? '' : 's'}`);
  parts.push(url);
  summary.textContent = parts.join(' — ');

  applyFilter();
}

// ---------- Filter / expand ----------

function applyFilter() {
  const q = $('filter').value.trim().toLowerCase();
  document.querySelectorAll('.tree').forEach((tree) => filterLi(tree.firstElementChild, q));
  document.querySelectorAll('.meta-table tr').forEach((tr) => {
    tr.classList.toggle('hidden', !!q && !tr.dataset.search.includes(q));
  });
}

// Returns true if this node or any descendant matches.
function filterLi(li, q) {
  if (!q) {
    li.classList.remove('hidden');
    li.querySelectorAll('li.hidden').forEach((n) => n.classList.remove('hidden'));
    return true;
  }
  const selfMatch = li.dataset.search.includes(q);
  const ul = li.querySelector(':scope > details > ul');
  let childMatch = false;
  if (ul) {
    for (const child of ul.children) {
      // A matching parent shows all its children.
      if (selfMatch) { filterLi(child, ''); childMatch = true; } else if (filterLi(child, q)) childMatch = true;
    }
    if (childMatch && !selfMatch) li.firstElementChild.open = true;
  }
  const visible = selfMatch || childMatch;
  li.classList.toggle('hidden', !visible);
  return visible;
}

function setAllOpen(open) {
  document.querySelectorAll('.tree details').forEach((d) => { d.open = open; });
}

// ---------- Scanning ----------

async function scan() {
  try {
    lastResult = await inspect();
    render();
  } catch (err) {
    lastResult = null;
    output.replaceChildren(el('div', 'empty', 'Unable to inspect this page. ' + (err.value || err.description || '')));
    summary.textContent = '';
  }
}

let navToken = 0;
async function scanAfterNavigation() {
  const token = ++navToken;
  output.replaceChildren(el('div', 'empty', 'Loading…'));
  // Wait for the new document to finish loading (up to ~10s).
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (token !== navToken) return;
    try {
      const res = await inspect();
      if (res.ready === 'complete') break;
    } catch (_) { /* page not ready yet */ }
  }
  if (token === navToken) scan();
}

// ---------- Wiring ----------

if (chrome.devtools.panels.themeName === 'dark') document.body.classList.add('dark');

$('refresh').addEventListener('click', scan);
$('expand').addEventListener('click', () => setAllOpen(true));
$('collapse').addEventListener('click', () => setAllOpen(false));
$('raw').addEventListener('change', render);
$('allJson').addEventListener('change', render);
$('showMeta').addEventListener('change', render);
$('filter').addEventListener('input', applyFilter);

chrome.devtools.network.onNavigated.addListener(scanAfterNavigation);

scan();
