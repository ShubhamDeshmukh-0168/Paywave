// Shared helpers: DOM builder, API client, session, theme, formatting. Exposed as window.PW.
(() => {
  'use strict';

  // API_BASE_URL: the Kubernetes API service (same origin, "/api"). PAYMENTS_API_URL: API Gateway + Lambda,
  // which handles every request that moves money. Without PAYMENTS_API_URL (local dev) one API does both.
  const CFG = window.APP_CONFIG || {};
  const API = (CFG.API_BASE_URL || '').replace(/\/$/, '');
  const PAY_API = (CFG.PAYMENTS_API_URL || CFG.API_BASE_URL || '').replace(/\/$/, '');
  const PAYID_RE = /^PW[A-Z0-9]{8}$/;
  const toastEl = document.getElementById('toast');
  const themeBtn = document.getElementById('themeBtn');

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
  };
  const session = {
    get token() { try { return sessionStorage.getItem('pw_token'); } catch { return null; } },
    set token(value) {
      try {
        if (value) sessionStorage.setItem('pw_token', value);
        else sessionStorage.removeItem('pw_token');
      } catch { /* blocked */ }
    },
  };

  // Builds DOM nodes. Text is always added as text nodes, never as HTML (no XSS).
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // Like el.replaceChildren(...) but skips false/null/undefined (the native one prints them as text)
  function setKids(el, ...kids) {
    el.replaceChildren(...kids.flat().filter((k) => k !== false && k !== null && k !== undefined));
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    children.flat().forEach((c) => el.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return el;
  }

  const ICONS = {
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
    shield: 'M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z',
    id: 'M3 6h18v12H3z M7 11h4 M7 14h6 M15 10h3',
    mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
    chart: 'M4 20v-8 M10 20V4 M16 20v-6 M2 20h20',
    lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
    copy: 'M9 9h11v11H9z M5 15V4h11',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    eyeoff: 'M3 3l18 18 M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8 M6.3 6.8A16 16 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4-.9',
    send: 'M22 2 11 13 M22 2l-7 20-4-9-9-4z',
    plus: 'M12 5v14 M5 12h14',
    moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5',
    repeat: 'M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5',
    check: 'M5 13l4 4L19 7',
    down: 'M12 5v14 M6 13l6 6 6-6',
    up: 'M12 19V5 M6 11l6-6 6 6',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l12-4v4 M17 14h2',
    card: 'M3 6h18v12H3z M3 10h18 M7 15h4',
    qr: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 14h2v2 M14 18h2v2 M18 18h2v2',
    scan: 'M4 8V5a1 1 0 0 1 1-1h3 M16 4h3a1 1 0 0 1 1 1v3 M20 16v3a1 1 0 0 1-1 1h-3 M8 20H5a1 1 0 0 1-1-1v-3 M4 12h16',
    phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 21h4',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
    camera: 'M3 8h4l2-3h6l2 3h4v12H3z M12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    image: 'M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M9 9a1 1 0 1 0 0 .01',
    download: 'M12 4v12 M6 11l6 6 6-6 M4 20h16',
    pause: 'M8 5v14 M16 5v14',
    play: 'M7 4l13 8-13 8z',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
    x: 'M6 6l12 12 M18 6 6 18',
  };
  function icon(name) {
    const el = svg('svg', { class: 'ico', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    el.append(svg('path', { d: ICONS[name] }));
    return el;
  }

  let toastTimer;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4200);
  }

  // ------------------------------------------------------------ formatting
  const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rupees = (money) => `₹${inr.format(Number(money.display))}`;
  const rupeesText = (amountText) => `₹${inr.format(Number(amountText))}`;
  const rupeesCompact = (paise) => {
    const r = paise / 100;
    return r >= 100000 ? `₹${(r / 100000).toFixed(1)}L` : r >= 1000 ? `₹${(r / 1000).toFixed(1)}k` : `₹${Math.round(r)}`;
  };
  const fmtDate = (iso) =>
    new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  const avatarClass = (text) => `avatar c${(String(text).charCodeAt(String(text).length - 1) + String(text).length) % 6}`;
  const spacedId = (id) => id.replace(/^(PW)(.{4})(.{4})$/, '$1 $2 $3');
  const cleanId = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const spacedMobile = (m) => (m ? `${m.slice(0, 5)} ${m.slice(5)}` : '');
  const maskMobile = (m) => `${m.slice(0, 2)}XXXXX${m.slice(-3)}`;

  /**
   * Turns whatever the person typed or scanned into a payment target:
   * a 10 digit Indian mobile number or a PayWave ID. Returns null if it is neither.
   */
  function normTarget(value) {
    const text = String(value || '').trim();
    if (/^pw/i.test(text)) {
      const id = cleanId(text);
      return PAYID_RE.test(id) ? id : null;
    }
    let d = text.replace(/[\s\-()]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : null;
  }
  const isMobile = (v) => /^[6-9]\d{9}$/.test(String(v));

  /** Reads a mobile/ID out of a scanned QR text: a PayWave link, a bare number, or a bare ID. */
  function parsePayload(text) {
    const s = String(text || '').trim();
    const m = /[#?&]pay=([A-Za-z0-9+%-]+)/.exec(s);
    return normTarget(m ? decodeURIComponent(m[1]) : s);
  }
  const payLink = (target) => `${location.origin}${location.pathname}#pay=${target}`;

  function randomKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Works on plain http pages too (navigator.clipboard needs https)
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    const ta = h('textarea', { 'aria-hidden': 'true', readonly: true, class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  async function api(path, { method = 'GET', body, headers = {}, payments = false } = {}) {
    const finalHeaders = { 'Content-Type': 'application/json', ...headers };
    if (session.token) finalHeaders.Authorization = `Bearer ${session.token}`;
    let res;
    try {
      res = await fetch((payments ? PAY_API : API) + path, { method, headers: finalHeaders, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { code: 'NETWORK' });
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || 'Something went wrong');
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------ avatars
  const avatarCache = new Map(); // mobile -> data URL | null
  /** A round avatar: the photo if there is one, otherwise coloured initials. */
  function avatar(name, seed, image, size = '') {
    const box = h('span', { class: `${avatarClass(seed || name)} ${size}`.trim(), 'aria-hidden': 'true' }, initials(name));
    if (image) setKids(box, h('img', { src: image, alt: '' }));
    box.classList.toggle('has-img', Boolean(image));
    return box;
  }
  /** Like avatar() but fetches another person's photo (once) when they have one. */
  function avatarFor(person, size = '') {
    const node = avatar(person.fullName, person.mobile || person.payId, null, size);
    if (person.hasAvatar && person.mobile) {
      const apply = (img) => { if (img) { setKids(node, h('img', { src: img, alt: '' })); node.classList.add('has-img'); } };
      if (avatarCache.has(person.mobile)) apply(avatarCache.get(person.mobile));
      else {
        api(`/avatar?to=${person.mobile}`).then((r) => { avatarCache.set(person.mobile, r.image); apply(r.image); }).catch(() => {});
      }
    }
    return node;
  }

  // ------------------------------------------------------------ theme
  const icons = { icon };
  function effectiveTheme() {
    const set = document.documentElement.dataset.theme;
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintThemeButton() {
    themeBtn.replaceChildren(icons.icon(effectiveTheme() === 'dark' ? 'sun' : 'moon'));
  }
  const savedTheme = store.get('pw_theme');
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
  paintThemeButton();
  themeBtn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('pw_theme', next);
    paintThemeButton();
  });

  // ------------------------------------------------------------ forms
  /** Wraps a submit handler: disables the button, shows errors in `errEl`. onAuthError is set by app.js. */
  const hooks = { onAuthError: () => {} };
  function guarded(button, errEl, fn) {
    return async (event) => {
      event.preventDefault();
      errEl.textContent = '';
      button.disabled = true;
      try {
        await fn(new FormData(event.target), event.target);
      } catch (err) {
        if (err.status === 401 && session.token) return hooks.onAuthError();
        errEl.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
  }

  /** Full screen success sheet. rows = [[label, value, mono?], ...] */
  function showReceipt({ title = 'Payment successful', amount, line, rows = [], who }) {
    const done = h('button', { type: 'button', class: 'big' }, 'Done');
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'receipt' },
        h('div', { class: 'tick' }, icon('check')),
        h('div', { class: 'muted' }, title),
        h('div', { class: 'rcpt-amount' }, amount),
        who,
        line && h('div', { class: 'muted' }, line),
        h('dl', {}, rows.filter(Boolean).flatMap(([k, v, mono]) => [h('dt', {}, k), h('dd', { class: mono ? 'mono' : '' }, v)])),
        done));
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    done.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    done.focus();
  }

  /** Decodes an image file to something drawImage() accepts. Uses createImageBitmap (not blocked by the CSP), else a data URL. */
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch { /* fall back below */ }
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Could not read the file'));
      fr.readAsDataURL(file);
    });
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not a usable image'));
      img.src = dataUrl;
    });
  }
  const sizeOfBitmap = (b) => [b.width || b.naturalWidth, b.height || b.naturalHeight];

  /** Reads an image file, crops it to a square and returns a small JPEG data URL. */
  async function resizeToAvatar(file, size = 256) {
    const bmp = await loadBitmap(file);
    const [w, hgt] = sizeOfBitmap(bmp);
    const side = Math.min(w, hgt);
    const canvas = h('canvas', { width: size, height: size });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bmp, (w - side) / 2, (hgt - side) / 2, side, side, 0, 0, size, size);
    if (bmp.close) bmp.close();
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  window.PW = {
    API, PAY_API, PAYID_RE, store, session, h, setKids, svg, icon, toast, inr, rupees, rupeesText, rupeesCompact, fmtDate,
    initials, avatarClass, spacedId, cleanId, spacedMobile, maskMobile, normTarget, isMobile, parsePayload, payLink,
    randomKey, copyText, api, avatar, avatarFor, avatarCache, guarded, hooks, showReceipt, resizeToAvatar, loadBitmap, sizeOfBitmap,
  };
})();
