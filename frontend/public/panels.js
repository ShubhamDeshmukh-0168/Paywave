// Dashboard panels: add money (card), send, scan, my QR, recharge, AutoPay, profile, notifications.
// Each builder gets `ctx` from app.js: { me, setBalance(money), refresh(), closePanel(), showPanel(kind, prefill), expired() }.
(() => {
  'use strict';
  const {
    h, setKids, svg, icon, toast, rupees, rupeesText, fmtDate, spacedId, spacedMobile, maskMobile, normTarget, isMobile,
    parsePayload, payLink, randomKey, copyText, api, avatar, avatarFor, avatarCache, guarded, showReceipt, resizeToAvatar,
    loadBitmap, sizeOfBitmap, session,
  } = window.PW;
  const QR = window.QR;

  const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
  const amountInputProps = { name: 'amount', inputmode: 'decimal', required: true, placeholder: '0.00', autocomplete: 'off' };
  const OPERATORS = [['JIO', 'Jio'], ['AIRTEL', 'Airtel'], ['VI', 'Vi'], ['BSNL', 'BSNL']];
  const OPERATOR_NAME = Object.fromEntries(OPERATORS);
  const SAMPLE_PLANS = [
    [19, '1 day · 1 GB'], [149, '20 days · 1 GB/day'], [239, '28 days · 1.5 GB/day'],
    [299, '28 days · 2 GB/day'], [479, '56 days · 1.5 GB/day'], [749, '90 days · 2 GB/day'],
  ];

  /** Replaces a form with a "review and confirm" view; `back()` restores it. */
  function reviewView({ title, rows, confirmLabel, onConfirm, back, ctx }) {
    const err = h('p', { class: 'error', role: 'alert' });
    const confirmBtn = h('button', { type: 'button', class: 'big' }, confirmLabel);
    const backBtn = h('button', { type: 'button', class: 'secondary big' }, 'Edit');
    backBtn.addEventListener('click', back);
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      err.textContent = '';
      try {
        await onConfirm();
      } catch (e) {
        if (e.status === 401) return ctx.expired();
        err.textContent = e.message;
        confirmBtn.disabled = false;
      }
    });
    return h('div', { class: 'review' },
      h('h3', {}, title),
      h('dl', {}, rows.filter(Boolean).flatMap(([k, v, mono]) => [h('dt', {}, k), h('dd', { class: mono ? 'mono' : '' }, v)])),
      err,
      h('div', { class: 'btns' }, backBtn, confirmBtn));
  }

  const validAmount = (text, min, max) => AMOUNT_RE.test(text) && Number(text) >= min && Number(text) <= max;

  // ================================================================== add money by card
  const luhn = (num) => {
    let sum = 0;
    let dbl = false;
    for (let i = num.length - 1; i >= 0; i -= 1) {
      let d = Number(num[i]);
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      dbl = !dbl;
    }
    return num.length > 0 && sum % 10 === 0;
  };
  function cardBrand(num) {
    if (/^4/.test(num)) return 'VISA';
    if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]|[3-6]|7[01]|720))/.test(num)) return 'MASTERCARD';
    if (/^3[47]/.test(num)) return 'AMEX';
    if (/^(60|65|81|82|508)/.test(num) && !/^6011/.test(num)) return 'RUPAY';
    if (/^(6011|64[4-9])/.test(num)) return 'DISCOVER';
    if (/^3(0[0-5]|[68])/.test(num)) return 'DINERS';
    return 'OTHER';
  }
  const BRAND_LABEL = { VISA: 'Visa', MASTERCARD: 'Mastercard', RUPAY: 'RuPay', AMEX: 'American Express', DINERS: 'Diners Club', DISCOVER: 'Discover', OTHER: 'Card' };
  const groupCard = (digits, brand) =>
    (brand === 'AMEX' ? [4, 6, 5] : [4, 4, 4, 4, 4]).reduce((acc, n) => {
      const used = acc.used;
      const part = digits.slice(used, used + n);
      if (part) acc.parts.push(part);
      acc.used += n;
      return acc;
    }, { parts: [], used: 0 }).parts.join(' ');

  function buildAddPanel(ctx) {
    const err = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'big' }, 'Continue');
    const amount = h('input', { ...amountInputProps, pattern: '^\\d{1,9}(\\.\\d{1,2})?$' });
    const number = h('input', { name: 'number', class: 'mono', inputmode: 'numeric', autocomplete: 'cc-number', placeholder: '1234 5678 9012 3456', maxlength: 23, required: true });
    const expiry = h('input', { name: 'expiry', class: 'mono', inputmode: 'numeric', autocomplete: 'cc-exp', placeholder: 'MM/YY', maxlength: 5, required: true });
    const cvv = h('input', { name: 'cvv', class: 'mono', type: 'password', inputmode: 'numeric', autocomplete: 'cc-csc', placeholder: '•••', maxlength: 4, required: true });
    const holder = h('input', { name: 'holder', autocomplete: 'cc-name', placeholder: 'Name on card', maxlength: 60, required: true });
    const brandTag = h('span', { class: 'brand-tag', 'aria-live': 'polite' });
    let kind = 'CREDIT';
    const kindBtns = [['CREDIT', 'Credit card'], ['DEBIT', 'Debit card']].map(([k, label]) =>
      h('button', { type: 'button', class: `chip${k === kind ? ' on' : ''}`, 'data-kind': k, onclick: () => { kind = k; kindBtns.forEach((b) => b.classList.toggle('on', b.dataset.kind === k)); } }, label));
    let key = randomKey();

    number.addEventListener('input', () => {
      const digits = number.value.replace(/\D/g, '').slice(0, 19);
      const brand = cardBrand(digits);
      number.value = groupCard(digits, brand);
      brandTag.textContent = digits.length >= 1 ? BRAND_LABEL[brand] : '';
      cvv.maxLength = brand === 'AMEX' ? 4 : 3;
    });
    expiry.addEventListener('input', () => {
      let d = expiry.value.replace(/\D/g, '').slice(0, 4);
      if (d.length >= 3) d = `${d.slice(0, 2)}/${d.slice(2)}`;
      else if (d.length === 2 && expiry.value.length === 2 && !expiry.value.includes('/')) d = `${d}/`;
      expiry.value = d;
    });
    cvv.addEventListener('input', () => { cvv.value = cvv.value.replace(/\D/g, ''); });

    const chips = [500, 1000, 2000, 5000].map((v) =>
      h('button', { class: 'chip', type: 'button', onclick: () => { amount.value = String(v); amount.focus(); } }, `₹${v}`));
    const testBtn = h('button', { class: 'link', type: 'button' }, 'Fill test card');
    testBtn.addEventListener('click', () => {
      number.value = '4111 1111 1111 1111'; number.dispatchEvent(new Event('input'));
      expiry.value = '12/34'; cvv.value = '123'; holder.value = ctx.me.fullName;
    });

    const form = h('form', { class: 'form', novalidate: true },
      h('label', {}, 'Amount (₹)', amount),
      h('div', { class: 'chips' }, chips),
      h('div', { class: 'seg' }, kindBtns),
      h('label', {}, h('span', { class: 'lab-row' }, 'Card number', brandTag), number),
      h('div', { class: 'row2' }, h('label', {}, 'Expiry', expiry), h('label', {}, 'CVV', cvv)),
      h('label', {}, 'Name on card', holder),
      err, submit,
      h('p', { class: 'muted small' }, 'Demo: no money is charged. Only the card type and last 4 digits are sent to our server, never the full number or CVV. ', testBtn,
        '. Card 4000 0000 0000 0002 simulates a declined card.'));
    const review = h('div', { class: 'hidden' });
    const title = h('h3', {}, 'Add money from a card');
    const host = h('section', { class: 'card panel' }, title, form, review);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      err.textContent = '';
      const digits = number.value.replace(/\D/g, '');
      const amt = amount.value.trim();
      const m = /^(\d{2})\/(\d{2})$/.exec(expiry.value);
      const brand = cardBrand(digits);
      if (!validAmount(amt, 1, 50000)) { err.textContent = 'Enter an amount between ₹1 and ₹50,000'; return; }
      if (digits.length < 13 || !luhn(digits)) { err.textContent = 'That card number is not valid'; return; }
      const now = new Date();
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 ||
          new Date(2000 + Number(m[2]), Number(m[1]), 1) <= new Date(now.getFullYear(), now.getMonth(), 1)) {
        err.textContent = 'Check the card expiry date'; return;
      }
      if (cvv.value.length !== (brand === 'AMEX' ? 4 : 3)) { err.textContent = 'Check the CVV'; return; }
      if (holder.value.trim().length < 2) { err.textContent = 'Enter the name on the card'; return; }

      const last4 = digits.slice(-4);
      const cardLabel = `${BRAND_LABEL[brand]} ${kind === 'CREDIT' ? 'credit' : 'debit'} •••• ${last4}`;
      const showForm = () => { review.classList.add('hidden'); form.classList.remove('hidden'); title.classList.remove('hidden'); };
      setKids(review, reviewView({
        title: 'Confirm top-up', ctx, back: showForm, confirmLabel: `Pay ${rupeesText(amt)}`,
        rows: [['Card', cardLabel], ['Amount', rupeesText(amt)], ['Added to', 'PayWave wallet']],
        onConfirm: async () => {
          // A real card network would be called here. We only simulate a bank decline for one test number.
          if (digits === '4000000000000002') {
            await new Promise((r) => setTimeout(r, 600));
            throw new Error('Your bank declined this card. Try another card.');
          }
          const result = await api('/wallet/add-money', {
            payments: true,
            method: 'POST',
            body: { amount: amt, card: { brand, kind, last4 } },
            headers: { 'Idempotency-Key': key },
          });
          key = randomKey();
          ctx.setBalance(result.balance);
          ctx.closePanel();
          showReceipt({
            title: 'Money added', amount: rupees(result.amount), line: `Paid with ${cardLabel}`,
            rows: [['Date', fmtDate(result.createdAt)], ['Reference', result.transactionId.slice(0, 8).toUpperCase(), true], ['New balance', rupees(result.balance)]],
          });
          ctx.refresh();
        },
      }));
      form.classList.add('hidden'); title.classList.add('hidden'); review.classList.remove('hidden');
    });
    return host;
  }

  // ================================================================== send money (by mobile number)
  function buildSendPanel(ctx, prefill = {}) {
    const err = h('p', { class: 'error', role: 'alert' });
    const toInput = h('input', { name: 'to', class: 'mono', type: 'tel', inputmode: 'tel', placeholder: '98765 43210', autocomplete: 'off', spellcheck: 'false', required: true, maxlength: 20 });
    const status = h('div', { class: 'recipient', 'aria-live': 'polite' });
    const amountInput = h('input', amountInputProps);
    const noteInput = h('input', { name: 'note', maxlength: 100, placeholder: 'What is it for?', autocomplete: 'off' });
    const reviewBtn = h('button', { type: 'submit', class: 'big' }, 'Review payment');
    const scanBtn = h('button', { type: 'button', class: 'secondary' }, icon('scan'), 'Scan QR');
    scanBtn.addEventListener('click', () => ctx.showPanel('scan'));
    let key = randomKey();
    let recipient = null;
    let seq = 0;
    let timer;

    const form = h('form', { class: 'form', novalidate: true },
      h('label', {}, "Recipient's mobile number", h('div', { class: 'with-btn' }, toInput, scanBtn)), status,
      h('label', {}, 'Amount (₹)', amountInput),
      h('label', {}, 'Note (optional)', noteInput),
      err, reviewBtn);
    const review = h('div', { class: 'hidden' });
    const title = h('h3', {}, 'Send money');

    function setStatus(kind, ...kids) {
      status.className = `recipient ${kind}`;
      setKids(status, ...kids);
    }
    async function resolve() {
      recipient = null;
      const raw = toInput.value.trim();
      if (!raw) return setStatus('');
      const target = normTarget(raw);
      if (!target) return setStatus('', raw.replace(/\D/g, '').length >= 10 ? 'Enter a valid 10 digit mobile number' : '');
      const mine = seq + 1;
      seq = mine;
      setStatus('', 'Checking…');
      try {
        const found = await api(`/lookup?to=${target}`);
        if (mine !== seq) return;
        if (found.isSelf) return setStatus('bad', 'That is your own number');
        recipient = found;
        setStatus('ok', avatarFor(found, 'sm'), h('span', {}, h('b', {}, found.fullName), ' ', h('span', { class: 'muted' }, spacedMobile(found.mobile) || spacedId(found.payId))));
      } catch (e) {
        if (mine !== seq) return;
        if (e.status === 401) return ctx.expired();
        setStatus('bad', e.status === 404 ? 'No PayWave account found for this number' : e.message);
      }
    }
    toInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(resolve, 350); });
    if (prefill.to) { toInput.value = prefill.to; resolve(); }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      err.textContent = '';
      if (!recipient) { await resolve(); if (!recipient) { err.textContent = 'Enter a registered mobile number first'; return; } }
      const amt = amountInput.value.trim();
      if (!validAmount(amt, 1, 100000)) { err.textContent = 'Enter an amount between ₹1 and ₹1,00,000 (max 2 decimals)'; return; }
      const note = noteInput.value.trim();
      const showForm = () => { review.classList.add('hidden'); form.classList.remove('hidden'); title.classList.remove('hidden'); };
      setKids(review, reviewView({
        title: 'Review payment', ctx, back: showForm, confirmLabel: `Pay ${rupeesText(amt)}`,
        rows: [['To', recipient.fullName], ['Mobile', spacedMobile(recipient.mobile) || spacedId(recipient.payId), true], ['Amount', rupeesText(amt)], note && ['Note', note]],
        onConfirm: async () => {
          const result = await api('/wallet/transfer', {
            payments: true,
            method: 'POST', body: { to: recipient.mobile || recipient.payId, amount: amt, note },
            headers: { 'Idempotency-Key': key },
          });
          key = randomKey();
          ctx.setBalance(result.balance);
          ctx.closePanel();
          showReceipt({
            amount: rupees(result.amount), who: avatarFor(recipient, 'lg'), line: `Sent to ${recipient.fullName}`,
            rows: [['Mobile', spacedMobile(recipient.mobile), true], result.note && ['Note', result.note], ['Date', fmtDate(result.createdAt)],
              ['Reference', result.transactionId.slice(0, 8).toUpperCase(), true], ['New balance', rupees(result.balance)]],
          });
          ctx.refresh();
        },
      }));
      form.classList.add('hidden'); title.classList.add('hidden'); review.classList.remove('hidden');
    });
    return h('section', { class: 'card panel' }, title, form, review);
  }

  // ================================================================== my QR
  function qrSvg(text, px = 240) {
    const q = QR.encode(text, 'M');
    const { size, d } = QR.toPath(q.modules, 3);
    const el = svg('svg', { class: 'qr', viewBox: `0 0 ${size} ${size}`, width: px, height: px, role: 'img', 'aria-label': 'QR code to pay you', 'shape-rendering': 'crispEdges' });
    el.append(svg('rect', { width: size, height: size, fill: '#ffffff' }), svg('path', { d, fill: '#000000' }));
    return { el, modules: q.modules };
  }
  function qrPngDataUrl(modules, name, mobile) {
    const scale = 10;
    const border = 4;
    const n = modules.length;
    const qrPx = (n + border * 2) * scale;
    const canvas = h('canvas', { width: qrPx, height: qrPx + 90 });
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#000';
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (modules[y][x]) g.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    g.fillStyle = '#002e6e';
    g.textAlign = 'center';
    g.font = 'bold 30px sans-serif';
    g.fillText(name, qrPx / 2, qrPx + 8);
    g.font = '26px monospace';
    g.fillText(spacedMobile(mobile), qrPx / 2, qrPx + 50);
    return canvas.toDataURL('image/png');
  }

  function buildQrPanel(ctx) {
    const { me } = ctx;
    if (!me.mobile) {
      return h('section', { class: 'card panel' }, h('h3', {}, 'My QR code'),
        h('p', { class: 'muted' }, 'Add your mobile number first. Your QR code is built from it, so people can scan it to pay you.'),
        h('button', { type: 'button', onclick: () => ctx.showPanel('profile') }, 'Add mobile number'));
    }
    const link = payLink(me.mobile);
    const { el, modules } = qrSvg(link);
    const dl = h('button', { type: 'button' }, icon('download'), 'Download PNG');
    dl.addEventListener('click', () => {
      const a = h('a', { href: qrPngDataUrl(modules, me.fullName, me.mobile), download: `paywave-${me.mobile}.png` });
      document.body.append(a); a.click(); a.remove();
    });
    const cp = h('button', { type: 'button', class: 'secondary' }, icon('link'), 'Copy link');
    cp.addEventListener('click', async () => toast((await copyText(link)) ? 'Payment link copied' : 'Could not copy the link'));
    const share = navigator.share ? h('button', { type: 'button', class: 'secondary' }, icon('send'), 'Share') : null;
    if (share) share.addEventListener('click', () => navigator.share({ title: 'Pay me on PayWave', text: `Pay ${me.fullName} on PayWave`, url: link }).catch(() => {}));
    return h('section', { class: 'card panel center' },
      h('h3', {}, 'My QR code'),
      h('p', { class: 'muted' }, 'Anyone can scan this with the PayWave scanner, or with a phone camera, to pay you.'),
      h('div', { class: 'qrbox' }, el),
      h('p', { class: 'qr-name' }, h('b', {}, me.fullName), h('br'), h('span', { class: 'mono' }, spacedMobile(me.mobile))),
      h('div', { class: 'btn-row' }, dl, cp, share));
  }

  // ================================================================== scanner
  function buildScanPanel(ctx) {
    const err = h('p', { class: 'error', role: 'alert' });
    const info = h('p', { class: 'muted' });
    const video = h('video', { class: 'cam', playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    const stage = h('div', { class: 'cam-wrap hidden' }, video, h('div', { class: 'cam-frame', 'aria-hidden': 'true' }));
    const canvas = h('canvas', { class: 'hidden' });
    let stream = null;
    let running = false;
    let detector = null;

    const secure = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    const startBtn = h('button', { type: 'button' }, icon('camera'), 'Start camera');
    const stopBtn = h('button', { type: 'button', class: 'secondary hidden' }, icon('x'), 'Stop camera');
    const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only', id: 'qrfile' });
    const uploadBtn = h('button', { type: 'button', class: 'secondary' }, icon('image'), 'Take photo / upload image');
    uploadBtn.addEventListener('click', () => fileInput.click());

    function stop() {
      running = false;
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      video.srcObject = null;
      stage.classList.add('hidden'); stopBtn.classList.add('hidden'); startBtn.classList.remove('hidden');
    }
    function found(text) {
      const target = parsePayload(text);
      if (!target) { err.textContent = 'That QR code is not a PayWave payment code.'; return false; }
      stop();
      toast('QR code read');
      ctx.showPanel('send', { to: target });
      return true;
    }

    async function loop() {
      const g = canvas.getContext('2d', { willReadFrequently: true });
      while (running && video.isConnected) {
        if (video.readyState >= 2 && video.videoWidth) {
          let text = null;
          try {
            if (detector) {
              const res = await detector.detect(video);
              if (res[0]) text = res[0].rawValue;
            } else {
              const scale = Math.min(1, 640 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              g.drawImage(video, 0, 0, canvas.width, canvas.height);
              text = QR.decodeImageData(g.getImageData(0, 0, canvas.width, canvas.height));
            }
          } catch { /* keep scanning */ }
          if (text && found(text)) return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!video.isConnected) stop();
    }

    startBtn.addEventListener('click', async () => {
      err.textContent = '';
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        err.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser, or upload a photo instead.' : 'Could not open the camera. Upload a photo instead.';
        return;
      }
      video.srcObject = stream;
      try { await video.play(); } catch { /* autoplay attribute covers it */ }
      detector = null;
      if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
      stage.classList.remove('hidden'); stopBtn.classList.remove('hidden'); startBtn.classList.add('hidden');
      running = true;
      loop();
    });
    stopBtn.addEventListener('click', stop);

    async function decodeFile(file) {
      err.textContent = '';
      info.textContent = 'Reading…';
      try {
        const bmp = await loadBitmap(file);
        const [w, hh] = sizeOfBitmap(bmp);
        const g = canvas.getContext('2d', { willReadFrequently: true });
        for (const max of [1000, 640, 1600, 420]) {
          const scale = Math.min(1, max / Math.max(w, hh));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(hh * scale));
          g.fillStyle = '#fff';
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          let text = null;
          if (window.BarcodeDetector) {
            try { const res = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(canvas); if (res[0]) text = res[0].rawValue; } catch { /* use the built-in decoder */ }
          }
          if (!text) text = QR.decodeImageData(g.getImageData(0, 0, canvas.width, canvas.height));
          if (text) { info.textContent = ''; found(text); return; }
        }
        info.textContent = '';
        err.textContent = 'No QR code found in that photo. Keep the whole code in frame and try again.';
      } catch (e) {
        info.textContent = '';
        err.textContent = e.message;
      }
    }
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) decodeFile(f); });

    const manual = h('input', { class: 'mono', type: 'tel', inputmode: 'tel', placeholder: '98765 43210', 'aria-label': 'Mobile number' });
    const manualForm = h('form', { class: 'with-btn', novalidate: true }, manual, h('button', { type: 'submit', class: 'secondary' }, 'Continue'));
    manualForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = normTarget(manual.value);
      if (!t) { err.textContent = 'Enter a valid 10 digit mobile number'; return; }
      stop();
      ctx.showPanel('send', { to: t });
    });

    const node = h('section', { class: 'card panel' },
      h('h3', {}, 'Scan & pay'),
      h('p', { class: 'muted' }, secure
        ? 'Point the camera at a PayWave QR code.'
        : 'Live camera scanning needs a secure (HTTPS) page, which this address is not. Use "Take photo / upload image" instead, it works everywhere.'),
      stage, canvas,
      h('div', { class: 'btn-row' }, secure && startBtn, stopBtn, uploadBtn, fileInput),
      info, err,
      h('p', { class: 'muted small' }, 'Or type the mobile number'), manualForm);
    // Release the camera when the panel is replaced
    new MutationObserver((_m, obs) => { if (!node.isConnected) { stop(); obs.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
    return node;
  }

  // ================================================================== mobile recharge
  function buildRechargePanel(ctx) {
    const err = h('p', { class: 'error', role: 'alert' });
    const mobileInput = h('input', { name: 'mobile', class: 'mono', type: 'tel', inputmode: 'tel', placeholder: '98765 43210', required: true, maxlength: 20, autocomplete: 'off' });
    if (ctx.me.mobile) mobileInput.value = spacedMobile(ctx.me.mobile);
    const amount = h('input', amountInputProps);
    let operator = 'JIO';
    let plan = null;
    const opBtns = OPERATORS.map(([k, label]) =>
      h('button', { type: 'button', class: `chip${k === operator ? ' on' : ''}`, 'data-op': k, onclick: () => { operator = k; opBtns.forEach((b) => b.classList.toggle('on', b.dataset.op === k)); } }, label));
    const planBtns = SAMPLE_PLANS.map(([price, label]) =>
      h('button', { type: 'button', class: 'plan', onclick: () => {
        amount.value = String(price); plan = label;
        planBtns.forEach((b) => b.classList.toggle('on', b === planBtns[SAMPLE_PLANS.findIndex(([p]) => p === price)]));
      } }, h('b', {}, `₹${price}`), h('span', { class: 'muted small' }, label)));
    amount.addEventListener('input', () => { plan = null; planBtns.forEach((b) => b.classList.remove('on')); });
    const selfBtn = ctx.me.mobile ? h('button', { type: 'button', class: 'link', onclick: () => { mobileInput.value = spacedMobile(ctx.me.mobile); } }, 'My number') : null;
    const submit = h('button', { type: 'submit', class: 'big' }, 'Review recharge');
    let key = randomKey();

    const form = h('form', { class: 'form', novalidate: true },
      h('label', {}, h('span', { class: 'lab-row' }, 'Mobile number to recharge', selfBtn), mobileInput),
      h('div', {}, h('div', { class: 'field-label' }, 'Operator'), h('div', { class: 'chips' }, opBtns)),
      h('div', {}, h('div', { class: 'field-label' }, 'Sample plans'), h('div', { class: 'plans' }, planBtns)),
      h('label', {}, 'Amount (₹10 to ₹3,000)', amount),
      err, submit,
      h('p', { class: 'muted small' }, 'Demo: the recharge is simulated. Your wallet is debited, but no operator is contacted and no real balance is added.'));
    const review = h('div', { class: 'hidden' });
    const title = h('h3', {}, 'Mobile recharge');

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      err.textContent = '';
      const mobile = normTarget(mobileInput.value);
      const amt = amount.value.trim();
      if (!mobile || !isMobile(mobile)) { err.textContent = 'Enter a valid 10 digit mobile number'; return; }
      if (!validAmount(amt, 10, 3000)) { err.textContent = 'Enter an amount between ₹10 and ₹3,000'; return; }
      const showForm = () => { review.classList.add('hidden'); form.classList.remove('hidden'); title.classList.remove('hidden'); };
      const thisPlan = plan;
      setKids(review, reviewView({
        title: 'Confirm recharge', ctx, back: showForm, confirmLabel: `Pay ${rupeesText(amt)}`,
        rows: [['Mobile', spacedMobile(mobile), true], ['Operator', OPERATOR_NAME[operator]], thisPlan && ['Plan', thisPlan], ['Amount', rupeesText(amt)]],
        onConfirm: async () => {
          const result = await api('/wallet/recharge', {
            payments: true,
            method: 'POST', body: { mobile, operator, amount: amt, plan: thisPlan || undefined },
            headers: { 'Idempotency-Key': key },
          });
          key = randomKey();
          ctx.setBalance(result.balance);
          ctx.closePanel();
          showReceipt({
            title: 'Recharge successful', amount: rupees(result.amount), line: `${OPERATOR_NAME[operator]} ${spacedMobile(mobile)}`,
            rows: [thisPlan && ['Plan', thisPlan], ['Date', fmtDate(result.createdAt)], ['Reference', result.transactionId.slice(0, 8).toUpperCase(), true], ['New balance', rupees(result.balance)]],
          });
          ctx.refresh();
        },
      }));
      form.classList.add('hidden'); title.classList.add('hidden'); review.classList.remove('hidden');
    });
    return h('section', { class: 'card panel' }, title, form, review);
  }

  // ================================================================== AutoPay
  const FREQ_LABEL = { DAILY: 'Every day', WEEKLY: 'Every week', MONTHLY: 'Every month' };
  function localInputValue(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function buildAutopayPanel(ctx) {
    const listHost = h('div', { class: 'ap-list' }, h('p', { class: 'muted' }, 'Loading…'));
    const err = h('p', { class: 'error', role: 'alert' });
    let kind = 'TRANSFER';
    let freq = 'MONTHLY';

    const kindBtns = [['TRANSFER', 'Send money'], ['RECHARGE', 'Mobile recharge']].map(([k, label]) =>
      h('button', { type: 'button', class: `chip${k === kind ? ' on' : ''}`, 'data-k': k, onclick: () => { kind = k; kindBtns.forEach((b) => b.classList.toggle('on', b.dataset.k === k)); paintKind(); } }, label));
    const freqBtns = Object.entries(FREQ_LABEL).map(([k, label]) =>
      h('button', { type: 'button', class: `chip${k === freq ? ' on' : ''}`, 'data-f': k, onclick: () => { freq = k; freqBtns.forEach((b) => b.classList.toggle('on', b.dataset.f === k)); } }, label));

    const toInput = h('input', { class: 'mono', type: 'tel', inputmode: 'tel', placeholder: '98765 43210', maxlength: 20, autocomplete: 'off' });
    const opSelect = h('select', {}, OPERATORS.map(([k, label]) => h('option', { value: k }, label)));
    const rechargeMobile = h('input', { class: 'mono', type: 'tel', inputmode: 'tel', placeholder: '98765 43210', maxlength: 20, autocomplete: 'off' });
    if (ctx.me.mobile) rechargeMobile.value = spacedMobile(ctx.me.mobile);
    const amount = h('input', amountInputProps);
    const note = h('input', { maxlength: 100, placeholder: 'e.g. Rent', autocomplete: 'off' });
    const tomorrow = new Date(Date.now() + 86400000);
    tomorrow.setHours(9, 0, 0, 0);
    const start = h('input', { type: 'datetime-local', required: true, value: localInputValue(tomorrow), min: localInputValue(new Date()) });
    const submit = h('button', { type: 'submit', class: 'big' }, 'Set up AutoPay');

    const transferFields = h('div', { class: 'form' }, h('label', {}, "Recipient's mobile number", toInput), h('label', {}, 'Note (optional)', note));
    const rechargeFields = h('div', { class: 'form hidden' }, h('label', {}, 'Mobile number to recharge', rechargeMobile), h('label', {}, 'Operator', opSelect));
    function paintKind() {
      transferFields.classList.toggle('hidden', kind !== 'TRANSFER');
      rechargeFields.classList.toggle('hidden', kind !== 'RECHARGE');
    }

    const form = h('form', { class: 'form', novalidate: true },
      h('div', { class: 'chips' }, kindBtns), transferFields, rechargeFields,
      h('label', {}, 'Amount (₹)', amount),
      h('div', {}, h('div', { class: 'field-label' }, 'Repeat'), h('div', { class: 'chips' }, freqBtns)),
      h('label', {}, 'First payment on', start),
      err, submit,
      h('p', { class: 'muted small' }, 'AutoPay runs from your wallet balance and is checked every 5 minutes, so a payment can arrive a few minutes after the set time. If your balance is too low, that run is skipped and you are notified. Up to 10 AutoPays.'));

    form.addEventListener('submit', guarded(submit, err, async () => {
      const amt = amount.value.trim();
      const when = new Date(start.value);
      if (Number.isNaN(when.getTime())) throw new Error('Pick a start date and time');
      const body = { kind, frequency: freq, amount: amt, startAt: when.toISOString() };
      if (kind === 'TRANSFER') {
        const t = normTarget(toInput.value);
        if (!t) throw new Error('Enter the recipient\'s 10 digit mobile number');
        body.to = t;
        body.note = note.value.trim();
      } else {
        const t = normTarget(rechargeMobile.value);
        if (!t || !isMobile(t)) throw new Error('Enter a valid 10 digit mobile number');
        body.mobile = t;
        body.operator = opSelect.value;
      }
      await api('/autopay', { method: 'POST', body });
      toast('AutoPay is set up');
      amount.value = ''; toInput.value = ''; note.value = '';
      load();
    }));

    async function act(id, action) {
      try {
        await api('/autopay/action', { method: 'POST', body: { id, action } });
        toast(action === 'cancel' ? 'AutoPay cancelled' : action === 'pause' ? 'AutoPay paused' : 'AutoPay resumed');
        load();
      } catch (e) { if (e.status === 401) ctx.expired(); else toast(e.message); }
    }
    function itemNode(a) {
      const what = a.kind === 'TRANSFER' ? `Pay ${a.to ? a.to.fullName : 'someone'}` : `Recharge ${OPERATOR_NAME[a.recharge.operator] || ''} ${spacedMobile(a.recharge.mobile)}`;
      const active = a.status === 'ACTIVE';
      const lastLine = a.lastStatus === 'FAILED' ? `Last run failed: ${a.lastError || 'unknown error'}` : a.lastStatus === 'PAID' ? `Last paid ${fmtDate(a.lastRunAt)}` : 'Not run yet';
      return h('div', { class: 'ap-item' },
        h('div', { class: 'ap-main' },
          h('div', { class: 'ap-title' }, what, ' ', h('span', { class: `badge ${active ? 'ok' : 'warn'}` }, active ? 'Active' : 'Paused')),
          h('div', { class: 'sub' }, `${rupees(a.amount)} · ${FREQ_LABEL[a.frequency].toLowerCase()}${a.note ? ` · ${a.note}` : ''}`),
          h('div', { class: 'sub' }, active ? `Next: ${fmtDate(a.nextRunAt)}` : 'Paused'),
          h('div', { class: `sub ${a.lastStatus === 'FAILED' ? 'bad' : ''}` }, lastLine)),
        h('div', { class: 'ap-btns' },
          h('button', { type: 'button', class: 'secondary icon-only', 'aria-label': active ? 'Pause' : 'Resume', title: active ? 'Pause' : 'Resume', onclick: () => act(a.id, active ? 'pause' : 'resume') }, icon(active ? 'pause' : 'play')),
          h('button', { type: 'button', class: 'secondary icon-only', 'aria-label': 'Cancel AutoPay', title: 'Cancel', onclick: () => { if (window.confirm('Cancel this AutoPay?')) act(a.id, 'cancel'); } }, icon('trash'))));
    }
    async function load() {
      try {
        const { items } = await api('/autopay');
        setKids(listHost, items.length ? items.map(itemNode) : h('p', { class: 'muted' }, 'No AutoPay yet. Set one up below.'));
      } catch (e) {
        if (e.status === 401) return ctx.expired();
        setKids(listHost, h('p', { class: 'error' }, e.message));
      }
    }
    load();
    return h('section', { class: 'card panel' }, h('h3', {}, 'AutoPay'), listHost, h('h4', {}, 'New AutoPay'), form);
  }

  // ================================================================== profile
  function buildProfilePanel(ctx) {
    const { me } = ctx;
    const err = h('p', { class: 'error', role: 'alert' });
    const photoHost = h('div', { class: 'photo-host' });
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', id: 'avatarfile' });
    const changeBtn = h('button', { type: 'button' }, icon('camera'), me.avatar ? 'Change photo' : 'Add photo');
    const removeBtn = h('button', { type: 'button', class: 'secondary' }, icon('trash'), 'Remove');
    changeBtn.addEventListener('click', () => fileInput.click());

    function paint() {
      setKids(photoHost, avatar(me.fullName, me.mobile || me.email, me.avatar, 'xl'));
      changeBtn.lastChild.textContent = me.avatar ? 'Change photo' : 'Add photo';
      removeBtn.classList.toggle('hidden', !me.avatar);
      ctx.onProfileChanged();
    }
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      err.textContent = '';
      changeBtn.disabled = true;
      try {
        const image = await resizeToAvatar(file);
        await api('/profile/avatar', { method: 'POST', body: { image } });
        me.avatar = image;
        avatarCache.delete(me.mobile);
        toast('Profile photo updated');
        paint();
      } catch (e) {
        if (e.status === 401) return ctx.expired();
        err.textContent = e.message;
      } finally { changeBtn.disabled = false; }
    });
    removeBtn.addEventListener('click', async () => {
      err.textContent = '';
      try {
        await api('/profile/avatar/remove', { method: 'POST' });
        me.avatar = null;
        avatarCache.delete(me.mobile);
        toast('Photo removed');
        paint();
      } catch (e) { if (e.status === 401) ctx.expired(); else err.textContent = e.message; }
    });

    // Mobile number: shown once set; accounts created before this feature can add it here
    const mobileHost = h('div');
    function paintMobile() {
      if (me.mobile) {
        setKids(mobileHost, h('dl', { class: 'kv' }, h('dt', {}, 'Mobile number'), h('dd', { class: 'mono' }, spacedMobile(me.mobile))),
          h('p', { class: 'muted small' }, 'This is your payment ID: people send money to this number. It cannot be changed here.'));
        return;
      }
      const e2 = h('p', { class: 'error', role: 'alert' });
      const input = h('input', { name: 'mobile', class: 'mono', type: 'tel', inputmode: 'tel', placeholder: '98765 43210', required: true, maxlength: 20 });
      const btn = h('button', { type: 'submit' }, 'Save number');
      const f = h('form', { class: 'form', novalidate: true },
        h('label', {}, 'Add your mobile number to receive payments', input), e2, btn,
        h('p', { class: 'muted small' }, 'You can set this once. It is not verified by SMS in this demo, so use your own number.'));
      f.addEventListener('submit', guarded(btn, e2, async () => {
        const t = normTarget(input.value);
        if (!t || !isMobile(t)) throw new Error('Enter a valid 10 digit mobile number');
        await api('/profile/mobile', { method: 'POST', body: { mobile: t } });
        me.mobile = t;
        toast('Mobile number saved');
        paintMobile();
        ctx.onProfileChanged();
      }));
      setKids(mobileHost, f);
    }
    paint();
    paintMobile();

    return h('section', { class: 'card panel' },
      h('h3', {}, 'My profile'),
      h('div', { class: 'profile-top' }, photoHost,
        h('div', {}, h('div', { class: 'p-name' }, me.fullName), h('div', { class: 'muted' }, me.email),
          h('div', { class: 'btn-row' }, changeBtn, removeBtn, fileInput))),
      err,
      mobileHost,
      h('dl', { class: 'kv' }, h('dt', {}, 'Account ID'), h('dd', { class: 'mono' }, spacedId(me.payId))));
  }

  // ================================================================== notifications
  const NOTIF_ICON = { PAYMENT_SENT: 'up', PAYMENT_RECEIVED: 'down', WALLET_TOPUP: 'wallet', RECHARGE: 'phone', AUTOPAY_FAILED: 'repeat' };
  function notifNode(n) {
    const tone = n.kind === 'PAYMENT_RECEIVED' || n.kind === 'WALLET_TOPUP' ? 'credit' : n.kind === 'AUTOPAY_FAILED' ? 'warn' : 'debit';
    return h('li', { class: `notif${n.read ? '' : ' unread'}` },
      h('div', { class: `ico2 ${tone}`, 'aria-hidden': 'true' }, icon(NOTIF_ICON[n.kind] || 'bell')),
      h('div', {}, h('div', { class: 'title' }, n.title), n.body && h('div', { class: 'sub' }, n.body), h('div', { class: 'sub' }, fmtDate(n.createdAt))));
  }

  window.PWPanels = {
    buildAddPanel, buildSendPanel, buildQrPanel, buildScanPanel, buildRechargePanel, buildAutopayPanel, buildProfilePanel, notifNode,
    // exposed for tests
    luhn, cardBrand, groupCard,
  };
  void session;
})();
