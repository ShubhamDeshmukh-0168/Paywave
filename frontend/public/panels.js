// Dashboard panels: add money, my cards, send, scan, my QR, recharge, AutoPay, profile, notifications.
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

  // ================================================================== add money (own wallet, no card)
  const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

  function buildAddPanel(ctx) {
    const err = h('p', { class: 'error', role: 'alert' });
    const amount = h('input', { ...amountInputProps, pattern: '^\\d{1,9}(\\.\\d{1,2})?$' });
    const submit = h('button', { type: 'submit', class: 'big' }, 'Add money');
    const chips = QUICK_AMOUNTS.map((n) => {
      const b = h('button', { type: 'button', class: 'chip' }, `+ ₹${n.toLocaleString('en-IN')}`);
      b.addEventListener('click', () => { amount.value = String(n); amount.focus(); err.textContent = ''; });
      return b;
    });
    let key = randomKey();

    const form = h('form', { class: 'form', novalidate: true },
      h('p', { class: 'muted small' }, 'Add money straight to your PayWave wallet. No card needed.'),
      h('label', {}, 'Amount (₹)', amount),
      h('div', { class: 'chips' }, chips),
      err, submit,
      h('p', { class: 'muted small' }, 'Demo wallet: the money is simulated, nothing is charged to anyone.'));
    const review = h('div', { class: 'hidden' });
    const title = h('h3', {}, 'Add money to your wallet');
    const host = h('section', { class: 'card panel' }, title, form, review);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      err.textContent = '';
      const amt = amount.value.trim();
      if (!validAmount(amt, 1, 50000)) { err.textContent = 'Enter an amount between ₹1 and ₹50,000 (max 2 decimals)'; return; }
      const showForm = () => { review.classList.add('hidden'); form.classList.remove('hidden'); title.classList.remove('hidden'); };
      setKids(review, reviewView({
        title: 'Review', ctx, back: showForm, confirmLabel: `Add ${rupeesText(amt)}`,
        rows: [['Amount', rupeesText(amt)], ['Added to', 'Your PayWave wallet']],
        onConfirm: async () => {
          const result = await api('/wallet/add-money', {
            payments: true, method: 'POST', body: { amount: amt }, headers: { 'Idempotency-Key': key },
          });
          key = randomKey();
          ctx.setBalance(result.balance);
          ctx.closePanel();
          showReceipt({
            title: 'Money added', amount: rupees(result.amount), line: 'Added to your wallet',
            rows: [['Date', fmtDate(result.createdAt)], ['Reference', result.transactionId.slice(0, 8).toUpperCase(), true], ['New balance', rupees(result.balance)]],
          });
          ctx.refresh();
        },
      }));
      form.classList.add('hidden'); title.classList.add('hidden'); review.classList.remove('hidden');
    });
    return host;
  }

  // ================================================================== my cards (virtual debit + credit)
  function buildCardsPanel(ctx) {
    const listHost = h('div', { class: 'cards-list' }, h('p', { class: 'muted' }, 'Loading your cards…'));
    const host = h('section', { class: 'card panel' }, h('h3', {}, 'My cards'),
      h('p', { class: 'muted small' }, 'Your PayWave virtual cards. Use them only when you choose to pay a person with a card; adding money to your wallet never needs one. Demo cards: no real card network is involved.'),
      listHost);
    let walletBalance = null;

    function cardNode(c) {
      const credit = c.kind === 'CREDIT';
      const mm = String(c.expMonth).padStart(2, '0');
      const yy = String(c.expYear).slice(-2);
      const numEl = h('div', { class: 'vc-num mono' }, c.masked);
      const cvvEl = h('b', { class: 'mono' }, '•••');
      const face = h('div', { class: `vcard ${credit ? 'credit' : 'debit'}${c.status === 'FROZEN' ? ' frozen' : ''}` },
        h('div', { class: 'vc-top' }, h('span', { class: 'vc-brand' }, 'PayWave'), h('span', { class: 'vc-kind' }, credit ? 'CREDIT' : 'DEBIT')),
        numEl,
        h('div', { class: 'vc-bottom' },
          h('div', {}, h('small', {}, 'CARD HOLDER'), h('b', {}, c.holder)),
          h('div', {}, h('small', {}, 'VALID THRU'), h('b', { class: 'mono' }, `${mm}/${yy}`)),
          h('div', {}, h('small', {}, 'CVV'), cvvEl)),
        c.status === 'FROZEN' && h('span', { class: 'vc-frozen' }, 'FROZEN'));

      const info = credit
        ? h('div', { class: 'limit' },
          h('div', { class: 'limit-row' }, h('span', {}, 'Used ', h('b', {}, rupees(c.outstanding))), h('span', {}, 'Available ', h('b', {}, rupees(c.available)))),
          h('progress', { max: c.creditLimit.paise, value: c.outstanding.paise, 'aria-label': 'Credit used' }),
          h('small', { class: 'muted' }, `Limit ${rupees(c.creditLimit)}. Pay the bill from your wallet.`))
        : h('p', { class: 'muted small' }, 'Spends your wallet balance', walletBalance ? ` (${rupees(walletBalance)})` : '', '.');

      const tools = h('div', { class: 'card-tools' });
      const msg = h('p', { class: 'error', role: 'alert' });
      let hideTimer;

      // password prompt shared by "Show details" and "Unfreeze"
      function askPassword(label, run) {
        const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your password', maxlength: 128, required: true });
        const go = h('button', { type: 'submit' }, label);
        const cancel = h('button', { type: 'button', class: 'secondary' }, 'Cancel');
        const f = h('form', { class: 'inline-form' }, pw, go, cancel);
        cancel.addEventListener('click', paintTools);
        f.addEventListener('submit', async (e) => {
          e.preventDefault(); msg.textContent = ''; go.disabled = true;
          try { await run(pw.value); } catch (er) {
            if (er.status === 401) return ctx.expired();
            msg.textContent = er.message; go.disabled = false;
          }
        });
        setKids(tools, h('p', { class: 'muted small' }, 'Enter your password to continue.'), f);
        pw.focus();
      }
      function hideDetails() {
        clearTimeout(hideTimer);
        numEl.textContent = c.masked; cvvEl.textContent = '•••';
        paintTools();
      }
      function paintTools() {
        const showBtn = h('button', { type: 'button', class: 'secondary' }, icon('eye'), 'Show details');
        showBtn.addEventListener('click', () => askPassword('Show', async (password) => {
          const d = await api('/cards/reveal', { method: 'POST', body: { kind: c.kind, password } });
          numEl.textContent = d.number; cvvEl.textContent = d.cvv;
          const copy = h('button', { type: 'button', class: 'secondary' }, icon('copy'), 'Copy number');
          copy.addEventListener('click', async () => toast((await copyText(d.number.replace(/ /g, ''))) ? 'Card number copied' : 'Could not copy'));
          const hide = h('button', { type: 'button', class: 'secondary' }, icon('eyeoff'), 'Hide');
          hide.addEventListener('click', hideDetails);
          setKids(tools, h('p', { class: 'muted small' }, 'Details hide again in 30 seconds.'), h('div', { class: 'btns' }, copy, hide));
          clearTimeout(hideTimer); hideTimer = setTimeout(hideDetails, 30000);
        }));
        const frozen = c.status === 'FROZEN';
        const freezeBtn = h('button', { type: 'button', class: 'secondary' }, icon(frozen ? 'play' : 'pause'), frozen ? 'Unfreeze' : 'Freeze');
        freezeBtn.addEventListener('click', async () => {
          msg.textContent = '';
          const apply = async (password) => {
            await api('/cards/status', { method: 'POST', body: { kind: c.kind, frozen: !frozen, ...(frozen ? { password } : {}) } });
            toast(frozen ? 'Card unfrozen' : 'Card frozen');
            load();
          };
          if (frozen) askPassword('Unfreeze', apply);
          else { freezeBtn.disabled = true; try { await apply(); } catch (er) { if (er.status === 401) return ctx.expired(); msg.textContent = er.message; freezeBtn.disabled = false; } }
        });
        const buttons = [showBtn, freezeBtn];
        if (credit && Number(c.outstanding.paise) > 0) {
          const payBtn = h('button', { type: 'button' }, icon('wallet'), 'Pay bill');
          payBtn.addEventListener('click', () => billForm());
          buttons.push(payBtn);
        }
        setKids(tools, h('div', { class: 'btns' }, buttons));
      }
      function billForm() {
        const due = c.outstanding.paise / 100;
        const amt = h('input', { ...amountInputProps, value: due.toFixed(2) });
        const go = h('button', { type: 'submit' }, 'Pay from wallet');
        const cancel = h('button', { type: 'button', class: 'secondary' }, 'Cancel');
        const f = h('form', { class: 'inline-form' }, amt, go, cancel);
        let key = randomKey();
        cancel.addEventListener('click', paintTools);
        f.addEventListener('submit', async (e) => {
          e.preventDefault(); msg.textContent = '';
          const text = amt.value.trim();
          if (!validAmount(text, 1, due)) { msg.textContent = `Enter an amount between ₹1 and ${rupees(c.outstanding)}`; return; }
          go.disabled = true;
          try {
            const r = await api('/cards/repay', { payments: true, method: 'POST', body: { amount: text }, headers: { 'Idempotency-Key': key } });
            key = randomKey();
            ctx.setBalance(r.balance);
            toast(`Paid ${rupees(r.amount)} towards your credit card`);
            ctx.refresh();
            load();
          } catch (er) {
            if (er.status === 401) return ctx.expired();
            msg.textContent = er.message; go.disabled = false;
          }
        });
        setKids(tools, h('p', { class: 'muted small' }, `You owe ${rupees(c.outstanding)}. It is paid from your wallet balance.`), f);
        amt.focus();
      }
      paintTools();
      return h('div', { class: 'card-block' }, face, info, tools, msg);
    }

    async function load() {
      try {
        const data = await api('/cards');
        walletBalance = data.walletBalance;
        setKids(listHost, data.items.map(cardNode));
      } catch (e) {
        if (e.status === 401) return ctx.expired();
        setKids(listHost, h('p', { class: 'error' }, e.message));
      }
    }
    load();
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

    // ---- how to pay: the wallet by default (nothing to enter). A card is only asked for if chosen.
    let myCards = [];
    let pick = 'WALLET'; // 'WALLET' | 'DEBIT' | 'CREDIT'
    const payHost = h('div', { class: 'paywith', role: 'radiogroup', 'aria-label': 'Pay with' });
    const cvvInput = h('input', { name: 'cvv', class: 'mono', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 3, placeholder: '•••' });
    const cvvHint = h('span', { class: 'muted small' });
    const cvvLabel = h('label', { class: 'hidden' }, h('span', { class: 'lab-row' }, 'CVV'), cvvInput, cvvHint);
    const cardOf = (kind) => myCards.find((c) => c.kind === kind);
    const cardName = (c) => `${c.kind === 'CREDIT' ? 'Credit' : 'Debit'} card •••• ${c.last4}`;
    function paintPay() {
      const opts = [['WALLET', 'Wallet', rupees(ctx.getBalance())]];
      for (const c of myCards) {
        opts.push([c.kind, cardName(c), c.status === 'FROZEN' ? 'Frozen' : c.kind === 'CREDIT' ? `${rupees(c.available)} available` : 'Uses wallet balance']);
      }
      setKids(payHost, opts.map(([id, label, sub]) => {
        const c = cardOf(id);
        const disabled = c && c.status === 'FROZEN';
        const btn = h('button', { type: 'button', class: `src${pick === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(pick === id), disabled },
          icon(id === 'WALLET' ? 'wallet' : 'card'), h('span', {}, h('b', {}, label), h('small', {}, sub)));
        btn.addEventListener('click', () => { pick = id; cvvInput.value = ''; paintPay(); });
        return btn;
      }));
      const chosen = cardOf(pick);
      cvvLabel.classList.toggle('hidden', !chosen);
      if (chosen) setKids(cvvHint, `3 digit CVV of your ${cardName(chosen).toLowerCase()}. `, h('button', { type: 'button', class: 'link', onclick: () => ctx.showPanel('cards') }, 'Show my cards'));
    }
    paintPay();
    api('/cards').then((data) => { myCards = data.items; paintPay(); }).catch((e) => { if (e.status === 401) ctx.expired(); });

    const form = h('form', { class: 'form', novalidate: true },
      h('label', {}, "Recipient's mobile number", h('div', { class: 'with-btn' }, toInput, scanBtn)), status,
      h('label', {}, 'Amount (₹)', amountInput),
      h('label', {}, 'Note (optional)', noteInput),
      h('div', {}, h('span', { class: 'lab-row' }, 'Pay with'), payHost),
      cvvLabel,
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
      const chosen = cardOf(pick);
      let source;
      if (chosen) {
        const cvv = cvvInput.value.trim();
        if (!/^\d{3}$/.test(cvv)) { err.textContent = `Enter the 3 digit CVV of your ${cardName(chosen).toLowerCase()}`; return; }
        if (chosen.kind === 'CREDIT' && Number(amt) * 100 > chosen.available.paise) { err.textContent = `Your credit card has only ${rupees(chosen.available)} available`; return; }
        source = { type: 'CARD', kind: chosen.kind, cvv };
      }
      const showForm = () => { review.classList.add('hidden'); form.classList.remove('hidden'); title.classList.remove('hidden'); };
      setKids(review, reviewView({
        title: 'Review payment', ctx, back: showForm, confirmLabel: `Pay ${rupeesText(amt)}`,
        rows: [['To', recipient.fullName], ['Mobile', spacedMobile(recipient.mobile) || spacedId(recipient.payId), true], ['Amount', rupeesText(amt)], note && ['Note', note],
          ['Pay with', chosen ? cardName(chosen) : 'Wallet']],
        onConfirm: async () => {
          const result = await api('/wallet/transfer', {
            payments: true,
            method: 'POST', body: { to: recipient.mobile || recipient.payId, amount: amt, note, ...(source ? { source } : {}) },
            headers: { 'Idempotency-Key': key },
          });
          key = randomKey();
          ctx.setBalance(result.balance);
          ctx.closePanel();
          const pw = result.paidWith || {};
          showReceipt({
            amount: rupees(result.amount), who: avatarFor(recipient, 'lg'), line: `Sent to ${recipient.fullName}`,
            rows: [['Mobile', spacedMobile(recipient.mobile), true], result.note && ['Note', result.note], ['Date', fmtDate(result.createdAt)],
              ['Reference', result.transactionId.slice(0, 8).toUpperCase(), true],
              ['Paid with', pw.last4 ? `${pw.kind === 'CREDIT' ? 'Credit' : 'Debit'} card •••• ${pw.last4}` : 'Wallet'],
              pw.creditAvailable ? ['Credit available', rupees(pw.creditAvailable)] : ['New balance', rupees(result.balance)]],
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
  const NOTIF_ICON = { PAYMENT_SENT: 'up', PAYMENT_RECEIVED: 'down', WALLET_TOPUP: 'wallet', CARD_BILL: 'card', RECHARGE: 'phone', AUTOPAY_FAILED: 'repeat' };
  function notifNode(n) {
    const tone = n.kind === 'PAYMENT_RECEIVED' || n.kind === 'WALLET_TOPUP' ? 'credit' : n.kind === 'AUTOPAY_FAILED' ? 'warn' : 'debit';
    return h('li', { class: `notif${n.read ? '' : ' unread'}` },
      h('div', { class: `ico2 ${tone}`, 'aria-hidden': 'true' }, icon(NOTIF_ICON[n.kind] || 'bell')),
      h('div', {}, h('div', { class: 'title' }, n.title), n.body && h('div', { class: 'sub' }, n.body), h('div', { class: 'sub' }, fmtDate(n.createdAt))));
  }

  window.PWPanels = {
    buildAddPanel, buildCardsPanel, buildSendPanel, buildQrPanel, buildScanPanel, buildRechargePanel, buildAutopayPanel, buildProfilePanel, notifNode,
  };
  void session;
})();
