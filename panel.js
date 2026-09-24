'use strict';

// Runs in the inspected page (serialized via toString, so it must be
// self-contained). Returns raw page data; the panel does the rendering.
function collectPage() {
  const where = (node) => (node.closest('head') ? 'head' : 'body');
  const tokens = (value) => (value || '').trim().split(/\s+/).filter(Boolean);

  const scripts = [];
  document.querySelectorAll('script[type]').forEach((s) => {
    scripts.push({
      type: (s.getAttribute('type') || '').trim().toLowerCase(),
      text: s.textContent,
      id: s.id || '',
      where: where(s),
    });
  });

  const meta = [];
  document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
    const key = (m.getAttribute('property') || m.getAttribute('name') || '').trim();
    if (/^(og|article|profile|book|music|video|fb|twitter):/i.test(key)) {
      meta.push({ key, content: m.getAttribute('content') || '' });
    }
  });

  const robots = [];
  document.querySelectorAll('meta[name]').forEach((m) => {
    const key = m.getAttribute('name').trim();
    if (/^(robots|google|[\w-]*bot|googlebot-[\w-]+)$/i.test(key)) {
      robots.push({ key, content: m.getAttribute('content') || '' });
    }
  });

  const canonical = [...document.querySelectorAll('link[rel~="canonical" i]')].map((l) => l.href);
  const hreflang = [...document.querySelectorAll('link[rel~="alternate" i][hreflang]')]
    .map((l) => ({ lang: l.getAttribute('hreflang'), href: l.href }));

  // Microdata, following the WHATWG property-value rules.
  const SCHEMA_ORG = /^https?:\/\/schema\.org\//i;
  const propValue = (node) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'meta') return node.getAttribute('content') || '';
    if (['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video'].includes(tag)) return node.src || '';
    if (['a', 'area', 'link'].includes(tag)) return node.href || '';
    if (tag === 'object') return node.data || '';
    if (tag === 'data' || tag === 'meter') return node.getAttribute('value') || '';
    if (tag === 'time' && node.hasAttribute('datetime')) return node.getAttribute('datetime');
    return node.textContent.trim().replace(/\s+/g, ' ');
  };
  const readItem = (root, ancestors) => {
    ancestors.add(root);
    const item = {};
    const types = tokens(root.getAttribute('itemtype')).map((t) => t.replace(SCHEMA_ORG, ''));
    if (types.length) item['@type'] = types.length === 1 ? types[0] : types;
    if (root.hasAttribute('itemid')) item['@id'] = root.getAttribute('itemid');

    const props = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.hasAttribute('itemprop')) props.push(child);
        if (!child.hasAttribute('itemscope')) walk(child);
      }
    };
    walk(root);
    for (const id of tokens(root.getAttribute('itemref'))) {
      const ref = document.getElementById(id);
      if (!ref) continue;
      if (ref.hasAttribute('itemprop')) props.push(ref);
      if (!ref.hasAttribute('itemscope')) walk(ref);
    }

    for (const p of props) {
      let value;
      if (!p.hasAttribute('itemscope')) value = propValue(p);
      else if (ancestors.has(p)) value = '[circular reference]';
      else value = readItem(p, ancestors);
      for (const name of tokens(p.getAttribute('itemprop'))) {
        item[name] = name in item ? [].concat(item[name], [value]) : value;
      }
    }
    ancestors.delete(root);
    return item;
  };
  const microdata = [...document.querySelectorAll('[itemscope]:not([itemprop])')].map((node) => {
    const data = readItem(node, new Set());
    if (tokens(node.getAttribute('itemtype')).some((t) => SCHEMA_ORG.test(t))) {
      return { data: { '@context': 'https://schema.org', ...data }, tag: node.tagName.toLowerCase(), id: node.id || '', where: where(node) };
    }
    return { data, tag: node.tagName.toLowerCase(), id: node.id || '', where: where(node) };
  });

  return {
    url: location.href,
    ready: document.readyState,
    scripts,
    meta,
    robots,
    canonical,
    hreflang,
    microdata,
  };
}

const COLLECT = `(${collectPage.toString()})()`;

const OG_REQUIRED = ['og:title', 'og:type', 'og:image', 'og:url'];

const DEFAULT_OPEN_DEPTH = 2;

const stripHash = (u) => u.split('#')[0];

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

  let parsed = script.data;
  let error = null;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(script.text);
    } catch (e) {
      error = e.message;
    }
  }

  if (!error) {
    for (const t of typesOf(parsed)) head.appendChild(el('span', 'type-badge', t));
  }

  const meta = [script.tag ? `<${script.tag}> in <${script.where}>` : `in <${script.where}>`];
  if (script.id) meta.push(`id="${script.id}"`);
  if (script.text !== undefined) meta.push(`${script.text.length.toLocaleString()} chars`);
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

// ---------- Robots meta ----------

// Directives that stop a page being indexed or its links followed.
const ROBOTS_BLOCKING = ['noindex', 'nofollow', 'none'];

function parseDirectives(content) {
  return content.split(',').map((d) => d.trim()).filter(Boolean);
}

// Directives whose value contains a colon, so aren't mistaken for a
// "useragent: directives" prefix in X-Robots-Tag.
const ROBOTS_VALUED = ['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after'];

// X-Robots-Tag values may be scoped to a crawler: "googlebot: noindex, nofollow".
function parseXRobotsTag(value) {
  const groups = [];
  let current = null;
  for (let token of parseDirectives(value)) {
    const m = token.match(/^([a-z][\w-]*)\s*:\s*(.*)$/i);
    if (m && !ROBOTS_VALUED.includes(m[1].toLowerCase())) {
      current = { ua: m[1], directives: [] };
      groups.push(current);
      token = m[2].trim();
      if (!token) continue;
    }
    if (!current) {
      current = { ua: null, directives: [] };
      groups.push(current);
    }
    current.directives.push(token);
  }
  return groups;
}

function renderRobots(robots, headerInfo) {
  const block = el('section', 'block meta-block');
  const head = el('div', 'block-head');
  const body = el('div', 'block-body');
  const table = el('table', 'meta-table');

  head.appendChild(el('span', 'title', 'Robots'));

  const rows = robots.map(({ key, content }) => ({ label: key, directives: parseDirectives(content) }));
  const headerValues = headerInfo?.values || [];
  for (const value of headerValues) {
    for (const { ua, directives } of parseXRobotsTag(value)) {
      rows.push({ label: ua ? `X-Robots-Tag (${ua})` : 'X-Robots-Tag', directives });
    }
  }

  const blocking = new Set();
  for (const { label, directives } of rows) {
    const tr = el('tr');
    tr.dataset.search = (label + ' ' + directives.join(' ')).toLowerCase();
    tr.appendChild(el('td', 'k', label));
    const td = el('td');
    for (const d of directives) {
      const isBlocking = ROBOTS_BLOCKING.includes(d.toLowerCase());
      if (isBlocking) blocking.add(`${label.toLowerCase()}: ${d.toLowerCase()}`);
      td.appendChild(el('span', isBlocking ? 'directive blocking' : 'directive', d));
    }
    tr.appendChild(td);
    table.appendChild(tr);
  }

  // Header status row when there's nothing to list for X-Robots-Tag.
  if (!headerValues.length) {
    const tr = el('tr');
    tr.dataset.search = 'x-robots-tag';
    tr.appendChild(el('td', 'k', 'X-Robots-Tag'));
    const td = el('td');
    if (headerInfo?.error) {
      td.appendChild(el('span', 'hint', `Couldn't fetch headers: ${headerInfo.error} `));
      td.appendChild(fetchHeadersButton('Retry'));
    } else if (headerInfo) {
      td.appendChild(el('span', 'hint', 'Not sent'));
    } else {
      td.appendChild(el('span', 'hint', 'Not captured: DevTools wasn’t open when this page loaded. '));
      const reload = el('button', 'inline', 'Reload page');
      reload.addEventListener('click', () => chrome.devtools.inspectedWindow.reload({}));
      td.appendChild(reload);
      td.appendChild(fetchHeadersButton('Fetch headers'));
    }
    tr.appendChild(td);
    table.appendChild(tr);
  }

  const metaCount = robots.length;
  head.appendChild(el('span', 'meta',
    `${metaCount} meta tag${metaCount === 1 ? '' : 's'}`
    + (headerValues.length ? ' + X-Robots-Tag header' : '')));
  if (blocking.size) head.appendChild(el('span', 'warn', [...blocking].join(', ')));

  body.appendChild(table);
  if (!robots.length && !headerValues.length && headerInfo && !headerInfo.error) {
    body.appendChild(el('div', 'hint', 'No robots meta tags or X-Robots-Tag header. Crawlers default to index, follow.'));
  }

  let note = 'robots.txt can also block crawling and isn’t checked here.';
  if (headerInfo?.source === 'har') {
    note = `Headers from the original page load (HTTP ${headerInfo.status}). ` + note;
  } else if (headerInfo?.source === 'fetch' && !headerInfo.error) {
    note = `Headers from a new ${headerInfo.method} request at ${headerInfo.time} (HTTP ${headerInfo.status}), `
      + 'which may differ from the original response. ' + note;
  }
  body.appendChild(el('div', 'hint robots-note', note));

  block.appendChild(head);
  block.appendChild(body);
  output.appendChild(block);
  return { count: rows.length, blocking: [...blocking] };
}

// ---------- Response headers ----------

// Fetched-header results, keyed by URL, for pages with no HAR entry.
const fetchedHeaders = new Map();

function getHar() {
  return new Promise((resolve) => {
    try {
      chrome.devtools.network.getHAR((har) => resolve(har));
    } catch (_) {
      resolve(null);
    }
  });
}

// The original document response, if DevTools was open when it loaded.
async function headersFromHar(url) {
  const har = await getHar();
  const entries = (har?.entries || []).filter((e) => stripHash(e.request.url) === stripHash(url)
    && (e._resourceType === 'document' || /html/.test(e.response?.content?.mimeType || '')));
  const entry = entries[entries.length - 1];
  if (!entry || !entry.response.status) return null;
  const values = entry.response.headers
    .filter((h) => h.name.toLowerCase() === 'x-robots-tag')
    .flatMap((h) => h.value.split('\n'))
    .map((v) => v.trim())
    .filter(Boolean);
  return { source: 'har', status: entry.response.status, values };
}

// Runs in the page so the request carries the page's cookies and origin.
function startHeaderFetch() {
  const key = '__schemaViewerHeaders';
  window[key] = null;
  const opts = { credentials: 'include', cache: 'no-store' };
  let method = 'HEAD';
  fetch(location.href, { ...opts, method })
    .then((r) => {
      if (r.status !== 405) return r;
      method = 'GET';
      return fetch(location.href, { ...opts, method });
    })
    .then((r) => {
      if (r.body) r.body.cancel();
      window[key] = { method, status: r.status, value: r.headers.get('x-robots-tag') };
    })
    .catch((e) => { window[key] = { error: String(e) }; });
}

function evalInPage(expr) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expr, (result, err) => (err ? reject(err) : resolve(result)));
  });
}

async function fetchHeaders(url) {
  await evalInPage(`(${startHeaderFetch.toString()})()`);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const res = await evalInPage('window.__schemaViewerHeaders');
    if (!res) continue;
    await evalInPage('delete window.__schemaViewerHeaders');
    if (res.error) return { source: 'fetch', error: res.error };
    return {
      source: 'fetch',
      method: res.method,
      status: res.status,
      time: new Date().toLocaleTimeString(),
      values: res.value ? [res.value] : [],
    };
  }
  return { source: 'fetch', error: 'timed out' };
}

function fetchHeadersButton(label) {
  const btn = el('button', 'inline', label);
  btn.addEventListener('click', async () => {
    if (!lastResult) return;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    const url = lastResult.url;
    let info;
    try {
      info = await fetchHeaders(url);
    } catch (err) {
      info = { source: 'fetch', error: err.value || err.description || String(err) };
    }
    fetchedHeaders.set(stripHash(url), info);
    if (lastResult?.url === url) {
      lastResult.headerInfo = info;
      render();
    }
  });
  return btn;
}

// ---------- Canonical / hreflang ----------

function renderLinks(pageUrl, canonical, hreflang) {
  const block = el('section', 'block meta-block');
  const head = el('div', 'block-head');
  const body = el('div', 'block-body');
  const warnings = [];

  head.appendChild(el('span', 'title', 'Canonical & hreflang'));
  head.appendChild(el('span', 'meta',
    `${hreflang.length} alternate${hreflang.length === 1 ? '' : 's'}`));

  const table = el('table', 'meta-table');
  const addRow = (label, url, chips = []) => {
    const tr = el('tr');
    tr.dataset.search = (label + ' ' + url + ' ' + chips.map((c) => c[0]).join(' ')).toLowerCase();
    tr.appendChild(el('td', 'k', label));
    const td = el('td', 's');
    td.appendChild(renderValue(url));
    for (const [text, cls] of chips) td.appendChild(el('span', `directive ${cls}`, text));
    tr.appendChild(td);
    table.appendChild(tr);
  };

  const canonicalPointsElsewhere = canonical.length === 1
    && stripHash(canonical[0]) !== stripHash(pageUrl);
  if (!canonical.length) warnings.push('No canonical');
  if (canonical.length > 1) warnings.push(`${canonical.length} canonicals`);
  for (const url of canonical) {
    addRow('canonical', url, canonicalPointsElsewhere ? [['not this URL', 'info']] : [['self', 'ok']]);
  }

  // hreflang alternates should include one pointing back at this page.
  const self = stripHash(canonical[0] || pageUrl);
  const seen = {};
  for (const { lang } of hreflang) seen[lang.toLowerCase()] = (seen[lang.toLowerCase()] || 0) + 1;
  for (const { lang, href } of hreflang) {
    const chips = [];
    if (stripHash(href) === self) chips.push(['self', 'ok']);
    if (seen[lang.toLowerCase()] > 1) chips.push(['duplicate', 'blocking']);
    addRow(`hreflang="${lang}"`, href, chips);
  }
  if (hreflang.length) {
    if (!hreflang.some(({ href }) => stripHash(href) === self)) warnings.push('No self-referencing hreflang');
    if (Object.values(seen).some((c) => c > 1)) warnings.push('Duplicate hreflang values');
  }

  if (warnings.length) head.appendChild(el('span', 'warn', warnings.join(' · ')));
  if (table.children.length) body.appendChild(table);
  if (!hreflang.length) body.appendChild(el('div', 'hint', 'No hreflang alternates.'));
  else if (!('x-default' in seen)) body.appendChild(el('div', 'hint', 'No x-default alternate (optional, but recommended).'));

  block.appendChild(head);
  block.appendChild(body);
  output.appendChild(block);
  return { warnings, canonicalPointsElsewhere, hreflang: hreflang.length };
}

function render() {
  output.replaceChildren();
  if (!lastResult) return;

  const {
    url, scripts, meta = [], robots = [], canonical = [], hreflang = [], microdata = [],
  } = lastResult;
  const includeOther = $('allJson').checked;
  const raw = $('raw').checked;
  const showMeta = $('showMeta').checked;
  const showMicrodata = $('showMicrodata').checked;

  $('validate').href = 'https://validator.schema.org/#url=' + encodeURIComponent(url);
  $('richResults').href = 'https://search.google.com/test/rich-results?url=' + encodeURIComponent(url);

  const shown = scripts.filter((s) => isLdJson(s.type) || (includeOther && isOtherJson(s.type)));
  if (showMicrodata) {
    for (const item of microdata) shown.push({ ...item, type: 'microdata' });
  }

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
      `No ${[includeOther ? 'JSON script tags' : 'JSON-LD', showMicrodata ? 'microdata' : '']
        .filter(Boolean).join(' or ')} found on this page.`));
  }

  const metaCounts = showMeta ? renderMeta(meta) : { og: 0, tw: 0 };
  const robotsInfo = showMeta ? renderRobots(robots, lastResult.headerInfo) : null;
  const linksInfo = showMeta ? renderLinks(url, canonical, hreflang) : null;

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
  if (robotsInfo?.blocking.length) parts.push(robotsInfo.blocking.join(', '));
  if (linksInfo?.canonicalPointsElsewhere) parts.push('canonical points elsewhere');
  if (linksInfo?.hreflang) parts.push(`${linksInfo.hreflang} hreflang`);
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
    const result = await inspect();
    result.headerInfo = await headersFromHar(result.url) || fetchedHeaders.get(stripHash(result.url)) || null;
    lastResult = result;
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
$('showMicrodata').addEventListener('change', render);
$('filter').addEventListener('input', applyFilter);

chrome.devtools.network.onNavigated.addListener(scanAfterNavigation);

scan();
