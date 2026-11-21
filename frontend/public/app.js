// Landing page, dashboard and app start. Helpers are in core.js, feature panels in panels.js.
(() => {
  'use strict';
  const {
    h, setKids, svg, icon, toast, store, session, rupees, rupeesCompact, fmtDate, spacedMobile, spacedId, maskMobile,
    normTarget, payLink, copyText, api, avatar, avatarFor, guarded, hooks,
  } = window.PW;
  const P = window.PWPanels;
  const QR = window.QR;

  const app = document.getElementById('app');
  const logoutBtn = document.getElementById('logoutBtn');
  const bellBtn = document.getElementById('bellBtn');
  const bellBadge = document.getElementById('bellBadge');
  const popover = document.getElementById('notifPopover');

  // ------------------------------------------------------------ payment links  (#pay=9876543210)
  let pendingPay = null;
  function readPayHash() {
    const m = /^#pay=([A-Za-z0-9+%-]+)$/.exec(location.hash);
    return m ? normTarget(decodeURIComponent(m[1])) : null;
  }
  pendingPay = readPayHash();
  const showTarget = (t) => (/^\d{10}$/.test(t) ? spacedMobile(t) : spacedId(t));

  // ------------------------------------------------------------ session
  let stopPolling = () => {};
  function startSession(data) {
    session.token = data.token;
    renderDashboard();
  }
  function logout(message) {
    stopPolling();
    session.token = null;
    renderLanding('login');
    if (message) toast(message);
  }
  hooks.onAuthError = () => logout('Session expired, please sign in again');
  logoutBtn.addEventListener('click', () => logout('Signed out'));
  document.getElementById('brandLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0 });
  });

  function setLayout(kind) {
    app.className = `container ${kind}`;
    logoutBtn.classList.toggle('hidden', kind !== 'dash');
    bellBtn.classList.toggle('hidden', kind !== 'dash');
    if (kind !== 'dash') popover.classList.add('hidden');
  }

  // ------------------------------------------------------------ landing page
  function renderLanding(mode = 'register') {
    setLayout('wide');
    const host = h('div', { id: 'auth' });

    function showForm(which, prefillEmail = '') {
      const isRegister = which === 'register';
      const err = h('p', { class: 'error', role: 'alert' });
      const btn = h('button', { type: 'submit', class: 'big' }, isRegister ? 'Create my wallet' : 'Sign in');
      const form = h('form', { class: 'form', novalidate: true },
        isRegister && h('label', {}, 'Full name', h('input', { name: 'fullName', autocomplete: 'name', required: true, minlength: 2, maxlength: 80 })),
        isRegister && h('label', {}, 'Mobile number',
          h('input', { name: 'mobile', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', placeholder: '98765 43210', required: true, maxlength: 20 })),
        h('label', {}, 'Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true, value: prefillEmail })),
        h('label', {}, 'Password', h('input', {
          name: 'password', type: 'password', required: true,
          autocomplete: isRegister ? 'new-password' : 'current-password',
          minlength: isRegister ? 8 : 1, maxlength: 128,
        })),
        isRegister && h('p', { class: 'muted small' }, 'Your mobile number becomes your payment ID: people send you money by it. We confirm your email with a 6 digit code. The number itself is not checked by SMS in this demo, so use your own.'),
        err, btn);

      form.addEventListener('submit', guarded(btn, err, async (fd) => {
        const email = String(fd.get('email')).trim();
        if (isRegister) {
          const mobile = normTarget(fd.get('mobile'));
          if (!mobile || !/^\d{10}$/.test(mobile)) throw new Error('Enter a valid 10 digit mobile number');
          if (String(fd.get('password')).length < 8) throw new Error('Password must be at least 8 characters');
          await api('/auth/register', { method: 'POST', body: { fullName: fd.get('fullName'), mobile, email, password: fd.get('password') } });
          showOtp(email, 'We sent a 6 digit code to your email.');
          return;
        }
        try {
          startSession(await api('/auth/login', { method: 'POST', body: { email, password: fd.get('password') } }));
        } catch (e) {
          if (e.code === 'NOT_VERIFIED') {
            await api('/auth/resend-otp', { method: 'POST', body: { email } }).catch(() => {});
            showOtp(email, 'Your email is not verified yet. We sent you a new code.');
            return;
          }
          throw e;
        }
      }));

      setKids(host,
        h('section', { class: 'card' },
          h('h2', {}, isRegister ? 'Create your wallet' : 'Welcome back'),
          h('p', { class: 'lead' }, isRegister ? 'Free to start. Ready in under a minute.' : 'Sign in to your PayWave wallet.'),
          form,
          h('p', { class: 'switch' }, isRegister ? 'Already have an account? ' : 'New to PayWave? ',
            h('button', { class: 'link', type: 'button', onclick: () => showForm(isRegister ? 'login' : 'register') }, isRegister ? 'Sign in' : 'Create one'))));
    }

    function showOtp(email, notice) {
      const err = h('p', { class: 'error', role: 'alert' });
      const btn = h('button', { type: 'submit', class: 'big' }, 'Verify and continue');
      const resend = h('button', { class: 'link', type: 'button' }, 'Resend code');
      const form = h('form', { class: 'form' },
        h('label', {}, 'Verification code',
          h('input', { class: 'mono', name: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', required: true, placeholder: '000000' })),
        err, btn);
      form.addEventListener('submit', guarded(btn, err, async (fd) => {
        startSession(await api('/auth/verify-otp', { method: 'POST', body: { email, otp: String(fd.get('otp')).trim() } }));
      }));

      let timer;
      function cooldown(seconds) {
        resend.disabled = true;
        let left = seconds;
        resend.textContent = `Resend in ${left}s`;
        clearInterval(timer);
        timer = setInterval(() => {
          left -= 1;
          if (left <= 0 || !resend.isConnected) {
            clearInterval(timer);
            resend.disabled = false;
            resend.textContent = 'Resend code';
          } else resend.textContent = `Resend in ${left}s`;
        }, 1000);
      }
      resend.addEventListener('click', async () => {
        err.textContent = '';
        try {
          await api('/auth/resend-otp', { method: 'POST', body: { email } });
          toast('A new code is on its way');
          cooldown(60);
        } catch (e) { err.textContent = e.message; }
      });
      cooldown(60);

      setKids(host,
        h('section', { class: 'card' },
          h('h2', {}, 'Check your email'),
          h('p', { class: 'lead' }, `Enter the code sent to ${email}.`),
          notice && h('p', { class: 'notice' }, notice),
          form,
          h('p', { class: 'switch' }, resend, ' · ', h('button', { class: 'link', type: 'button', onclick: () => showForm('register') }, 'Use another email'))));
    }

    const focusAuth = (which) => {
      showForm(which);
      host.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const first = host.querySelector('input');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 300);
    };

    const feature = (ic, title, text) =>
      h('div', { class: 'feature' }, h('div', { class: 'fi' }, icon(ic)), h('h3', {}, title), h('p', {}, text));

    const hero = h('section', { class: 'hero' },
      h('div', {},
        h('span', { class: 'eyebrow' }, icon('bolt'), 'Your mobile number is your payment ID'),
        h('h1', {}, 'Pay anyone with just a ', h('em', {}, 'mobile number.')),
        h('p', { class: 'sub' }, 'Add money from your card, send and receive in seconds, scan a QR to pay, recharge your phone and set up AutoPay. Every payment sends a notification to both people.'),
        h('div', { class: 'cta' },
          h('button', { class: 'big', type: 'button', onclick: () => focusAuth('register') }, 'Create free wallet'),
          h('button', { class: 'big secondary', type: 'button', onclick: () => focusAuth('login') }, 'Sign in')),
        h('div', { class: 'trust' },
          h('span', {}, icon('check'), 'Email verified'),
          h('span', {}, icon('check'), 'Encrypted at rest'),
          h('span', {}, icon('check'), 'No double charges')),
        h('div', { class: 'id-demo', 'aria-label': 'Example payment ID' },
          h('small', {}, 'Your payment ID'),
          h('div', { class: 'row' }, h('span', { class: 'pid mono' }, '98765 43210'), h('span', { class: 'tag' }, 'Share to get paid')))),
      h('div', {},
        pendingPay && h('div', { class: 'pay-banner' }, `Sign in or create an account to pay ${showTarget(pendingPay)}.`),
        host));

    const how = h('section', { class: 'band' },
      h('h2', {}, 'How it works'),
      h('p', { class: 'lead2' }, 'Three steps from sign-up to your first payment.'),
      h('div', { class: 'grid3' },
        ...[
          ['1', 'Sign up with your number', 'Enter your name, mobile number and email, then confirm the 6 digit code we email you.'],
          ['2', 'Add money', 'Top up from a credit or debit card, then share your number or QR code to get paid.'],
          ['3', 'Pay, scan, recharge', 'Pay a number, scan a QR, recharge a phone or schedule an AutoPay. Both sides get a notification.'],
        ].map(([n, t, d]) => h('div', { class: 'feature step' }, h('div', { class: 'num' }, n), h('h3', {}, t), h('p', {}, d)))));

    const features = h('section', { class: 'band' },
      h('h2', {}, 'Built for everyday payments'),
      h('p', { class: 'lead2' }, 'Everything you need to move money, nothing you do not.'),
      h('div', { class: 'grid3' },
        feature('phone', 'Pay by mobile number', 'No account numbers or IFSC codes. Enter a number, confirm the name that appears, and pay.'),
        feature('card', 'Credit and debit cards', 'Top up your wallet from a card. Only the card type and last 4 digits ever reach our server.'),
        feature('qr', 'QR code and scanner', 'Show your QR code to get paid and scan other codes with your camera or a photo.'),
        feature('bell', 'Notifications for everyone', 'Sender and receiver get an in-app notification and an email on every payment.'),
        feature('repeat', 'AutoPay and recharge', 'Recharge any prepaid number and schedule daily, weekly or monthly payments.'),
        feature('user', 'Profile photo', 'Add your photo so friends recognise you when they pay.'),
        feature('chart', 'Spending insights', 'A 30 day summary and a 7 day chart show what you spent, received and added.'),
        feature('shield', 'Safe retries', 'If your connection drops mid-payment, retrying never charges you twice.'),
        feature('lock', 'Secure by design', 'Hashed passwords, email verification, login lockout and encrypted storage.')));

    const faq = h('section', { class: 'band faq' },
      h('h2', {}, 'Questions'),
      ...[
        ['Is this real money?', 'No. This is a demo wallet. Card top-ups and recharges are simulated: nothing is charged to a card and no operator is contacted.'],
        ['Is my mobile number verified?', 'Not by SMS in this demo. Your email is verified with a code. Use your own number, because other people pay you by it.'],
        ['Does the scanner work on this site?', 'Taking or uploading a photo of a QR code always works. Live camera scanning needs a secure (HTTPS) address.'],
        ['What if I lose my password?', 'This demo has no password reset yet. Create a new account with another email.'],
      ].map(([q, a]) => h('details', {}, h('summary', {}, q), h('p', {}, a))));

    setKids(app, hero, how, features, faq);
    showForm(mode === 'login' ? 'login' : 'register');
  }

  // ------------------------------------------------------------ dashboard
  async function renderDashboard() {
    stopPolling();
    setLayout('dash');
    setKids(app, h('p', { class: 'muted center' }, 'Loading your wallet…'));

    let me;
    try {
      me = await api('/me');
    } catch (err) {
      if (err.status === 401) return logout();
      setKids(app, h('section', { class: 'card' }, h('p', { class: 'error' }, err.message), h('button', { onclick: renderDashboard }, 'Try again')));
      return;
    }

    let balance = me.balance;
    let balanceHidden = store.get('pw_hide_balance') === '1';
    let openPanel = null;
    let allTx = [];
    let nextBefore = null;
    let filter = 'all';
    let query = '';

    // ---- balance card
    const amountEl = h('p', { class: 'amount' });
    const eyeBtn = h('button', { class: 'eye', type: 'button', 'aria-label': 'Show or hide balance' });
    function paintBalance() {
      amountEl.textContent = balanceHidden ? '₹ ••••••' : rupees(balance);
      setKids(eyeBtn, icon(balanceHidden ? 'eyeoff' : 'eye'));
    }
    eyeBtn.addEventListener('click', () => {
      balanceHidden = !balanceHidden;
      store.set('pw_hide_balance', balanceHidden ? '1' : '0');
      paintBalance();
    });
    paintBalance();

    const panelHost = h('div');
    const ACTIONS = [
      ['add', 'card', 'Add money'], ['send', 'send', 'Send'], ['scan', 'scan', 'Scan'],
      ['qr', 'qr', 'My QR'], ['recharge', 'phone', 'Recharge'], ['autopay', 'repeat', 'AutoPay'],
    ];
    const actionBtns = Object.fromEntries(ACTIONS.map(([kind, ic, label]) =>
      [kind, h('button', { type: 'button', class: 'act', onclick: () => showPanel(kind) }, icon(ic), h('span', {}, label))]));

    const identityHost = h('div', { class: 'identity' });
    const mobileHost = h('div', { class: 'idbox' });
    function paintIdentity() {
      const profileBtn = h('button', { type: 'button', class: 'avatar-btn', 'aria-label': 'Open profile', onclick: () => showPanel('profile') }, avatar(me.fullName, me.mobile || me.email, me.avatar, 'md'));
      setKids(identityHost, profileBtn, h('p', { class: 'hello' }, `Hi ${me.fullName.split(' ')[0]}, your balance`));
      if (me.mobile) {
        const copyNum = h('button', { type: 'button' }, icon('copy'), 'Copy number');
        const copyLink = h('button', { type: 'button' }, icon('link'), 'Copy pay link');
        copyNum.addEventListener('click', async () => toast((await copyText(me.mobile)) ? 'Mobile number copied' : 'Press and hold the number to copy it'));
        copyLink.addEventListener('click', async () => toast((await copyText(payLink(me.mobile))) ? 'Payment link copied' : 'Could not copy the link'));
        setKids(mobileHost,
          h('small', {}, 'Your mobile number. Share it to get paid'),
          h('div', { class: 'idline' },
            h('span', { class: 'pid mono', 'aria-label': `Your payment ID ${me.mobile}` }, spacedMobile(me.mobile)),
            h('div', { class: 'idbtns' }, copyNum, copyLink)));
      } else {
        setKids(mobileHost,
          h('small', {}, 'Add your mobile number to get paid'),
          h('div', { class: 'idline' }, h('span', {}, 'People pay you by your number.'),
            h('div', { class: 'idbtns' }, h('button', { type: 'button', onclick: () => showPanel('profile') }, icon('phone'), 'Add number'))));
      }
    }
    paintIdentity();

    const balanceCard = h('section', { class: 'card balance' },
      identityHost,
      h('div', { class: 'amount-row' }, amountEl, eyeBtn),
      mobileHost,
      h('div', { class: 'actions' }, Object.values(actionBtns)));

    // ---- insights + contacts
    const insightsHost = h('section', { class: 'card' }, h('h3', {}, 'Last 30 days'), h('p', { class: 'muted' }, 'Loading…'));
    const contactsList = h('div', { class: 'contacts' });
    const contactsCard = h('section', { class: 'card hidden' }, h('h3', {}, 'Send again'), contactsList);

    function drawInsights(data) {
      const t = data.last30Days;
      const days = data.daily;
      const max = Math.max(1, ...days.flatMap((d) => [d.sent.paise, d.received.paise]));
      const W = 320, H = 150, base = 120, plot = 100, group = W / days.length;
      const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Money spent and received over the last 7 days' });
      chart.append(svg('line', { class: 'axis', x1: 0, x2: W, y1: base, y2: base }));
      days.forEach((d, i) => {
        const x = i * group;
        [['bar-sent', d.sent, 'Spent'], ['bar-recv', d.received, 'Received']].forEach(([cls, m, label], j) => {
          const hgt = m.paise === 0 ? 0 : Math.max(3, (m.paise / max) * plot);
          const r = svg('rect', { class: cls, x: x + group * 0.14 + j * group * 0.36, y: base - hgt, width: group * 0.32, height: hgt, rx: 3 });
          r.append(svg('title', {}, `${label} ${rupees(m)} on ${d.day}`));
          chart.append(r);
        });
        const wd = new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
        chart.append(svg('text', { class: 'lbl', x: x + group / 2, y: base + 16 }, wd));
      });
      chart.append(svg('text', { class: 'lbl lbl-left', x: 2, y: 10 }, rupeesCompact(max)));

      const empty = days.every((d) => d.sent.paise === 0 && d.received.paise === 0);
      setKids(insightsHost,
        h('h3', {}, 'Last 30 days'),
        h('div', { class: 'stats' },
          h('div', { class: 'stat sent' }, h('small', {}, 'Spent'), h('b', {}, rupees(t.sent))),
          h('div', { class: 'stat recv' }, h('small', {}, 'Received'), h('b', {}, rupees(t.received))),
          h('div', { class: 'stat' }, h('small', {}, 'Added'), h('b', {}, rupees(t.added)))),
        h('div', { class: 'chart-wrap' }, chart),
        h('div', { class: 'legend' }, h('span', {}, h('i', { class: 's' }), 'Spent'), h('span', {}, h('i', { class: 'r' }), 'Received'), h('span', {}, 'Last 7 days (UTC)')),
        empty && h('p', { class: 'muted' }, 'Your chart fills up once you send or receive money.'));
    }
    async function loadInsights() {
      try { drawInsights(await api('/insights')); } catch (err) {
        if (err.status === 401) return logout('Session expired, please sign in again');
        setKids(insightsHost, h('h3', {}, 'Last 30 days'), h('p', { class: 'muted' }, 'Insights are unavailable right now.'));
      }
    }
    async function loadContacts() {
      try {
        const { items } = await api('/contacts');
        contactsCard.classList.toggle('hidden', items.length === 0);
        setKids(contactsList, items.map((c) =>
          h('button', { class: 'contact', type: 'button', title: `${c.fullName} (${spacedMobile(c.mobile)})`, onclick: () => showPanel('send', { to: c.mobile || c.payId }) },
            avatarFor(c), c.fullName.split(' ')[0])));
      } catch { /* optional widget */ }
    }

    // ---- panels
    const BUILDERS = {
      add: P.buildAddPanel, send: P.buildSendPanel, scan: P.buildScanPanel, qr: P.buildQrPanel,
      recharge: P.buildRechargePanel, autopay: P.buildAutopayPanel, profile: P.buildProfilePanel,
    };
    function closePanel() {
      openPanel = null;
      setKids(panelHost);
      Object.values(actionBtns).forEach((b) => b.classList.remove('active'));
    }
    function showPanel(kind, prefill = {}) {
      if (openPanel === kind && !prefill.to) return closePanel();
      closePanel();
      openPanel = kind;
      if (actionBtns[kind]) actionBtns[kind].classList.add('active');
      const node = BUILDERS[kind](ctx, prefill);
      setKids(panelHost, node);
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const first = node.querySelector('input:not([type=file])');
      if (first && kind !== 'scan') first.focus({ preventScroll: true });
    }
    const ctx = {
      me,
      setBalance(money) { balance = money; paintBalance(); },
      refresh() { loadTransactions(true); loadInsights(); loadContacts(); poll(true); },
      closePanel,
      showPanel,
      expired: () => logout('Session expired, please sign in again'),
      onProfileChanged: paintIdentity,
    };

    // ---- notifications (bell + polling)
    let lastSeenId = null;
    let unread = 0;
    let pollTimer = null;
    function paintBell() {
      bellBadge.textContent = unread > 99 ? '99+' : String(unread);
      bellBadge.classList.toggle('hidden', unread === 0);
      bellBtn.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    }
    async function poll(silent = false) {
      try {
        const data = await api('/notifications?limit=20');
        unread = data.unread;
        paintBell();
        const newest = data.items.length ? data.items[0].id : 0;
        if (lastSeenId === null || silent) {
          lastSeenId = Math.max(lastSeenId || 0, newest);
          return;
        }
        if (newest > lastSeenId) {
          const fresh = data.items.filter((n) => n.id > lastSeenId);
          lastSeenId = newest;
          toast(fresh[0].title + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''));
          try { ctx.setBalance((await api('/me')).balance); } catch { /* next poll */ }
          loadTransactions(true); loadInsights();
          if (!popover.classList.contains('hidden')) openBell(true);
        }
      } catch (err) {
        if (err.status === 401) logout('Session expired, please sign in again');
      }
    }
    async function openBell(keepOpen = false) {
      if (!keepOpen && !popover.classList.contains('hidden')) { popover.classList.add('hidden'); return; }
      try {
        const data = await api('/notifications?limit=30');
        const markBtn = h('button', { class: 'link', type: 'button' }, 'Mark all as read');
        markBtn.addEventListener('click', async () => {
          try { await api('/notifications/read', { method: 'POST', body: { all: true } }); unread = 0; paintBell(); openBell(true); } catch (e) { toast(e.message); }
        });
        setKids(popover,
          h('div', { class: 'pop-head' }, h('b', {}, 'Notifications'), data.unread > 0 && markBtn),
          data.items.length ? h('ul', { class: 'notif-list' }, data.items.map(P.notifNode)) : h('p', { class: 'muted center' }, 'Nothing yet. Payments and AutoPay results show up here.'));
        popover.classList.remove('hidden');
        unread = data.unread; paintBell();
        if (data.items.length) lastSeenId = Math.max(lastSeenId || 0, data.items[0].id);
      } catch (e) { if (e.status === 401) logout('Session expired, please sign in again'); else toast(e.message); }
    }
    bellBtn.onclick = (e) => { e.stopPropagation(); openBell(); };
    const closeOnOutside = (e) => { if (!popover.classList.contains('hidden') && !popover.contains(e.target) && !bellBtn.contains(e.target)) popover.classList.add('hidden'); };
    document.addEventListener('click', closeOnOutside);
    poll();
    pollTimer = setInterval(() => { if (!document.hidden) poll(); }, 25000);
    stopPolling = () => {
      clearInterval(pollTimer);
      document.removeEventListener('click', closeOnOutside);
      popover.classList.add('hidden');
      unread = 0; paintBell();
      stopPolling = () => {};
    };

    // ---- history
    const txList = h('ul', { class: 'tx-list' });
    const moreBtn = h('button', { class: 'secondary hidden', type: 'button' }, 'Load more');
    const searchInput = h('input', { class: 'search', type: 'search', placeholder: 'Search by name, number or note', 'aria-label': 'Search transactions' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const FILTERS = [['all', 'All'], ['sent', 'Sent'], ['recv', 'Received'], ['added', 'Added'], ['recharge', 'Recharges']];

    function paintTabs() {
      setKids(tabs, FILTERS.map(([k, label]) =>
        h('button', { class: `chip${filter === k ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(filter === k), onclick: () => { filter = k; paintTabs(); paintTx(); } }, label)));
    }
    function matches(t) {
      if (filter === 'sent' && !(t.type === 'TRANSFER' && t.direction === 'DEBIT')) return false;
      if (filter === 'recv' && !(t.type === 'TRANSFER' && t.direction === 'CREDIT')) return false;
      if (filter === 'added' && t.type !== 'TOPUP') return false;
      if (filter === 'recharge' && t.type !== 'RECHARGE') return false;
      if (!query) return true;
      const d = t.detail || {};
      const hay = [t.counterparty && t.counterparty.fullName, t.counterparty && t.counterparty.mobile, t.note, t.amount.display, d.mobile, d.operator, d.last4].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(query);
    }
    const BRAND = { VISA: 'Visa', MASTERCARD: 'Mastercard', RUPAY: 'RuPay', AMEX: 'Amex', DINERS: 'Diners', DISCOVER: 'Discover', OTHER: 'Card' };
    const OP = { JIO: 'Jio', AIRTEL: 'Airtel', VI: 'Vi', BSNL: 'BSNL' };
    function txRow(t) {
      const credit = t.direction === 'CREDIT';
      const d = t.detail || {};
      let title;
      let ic;
      const extra = [];
      if (t.type === 'TRANSFER') {
        title = credit ? `Received from ${t.counterparty.fullName}` : `Sent to ${t.counterparty.fullName}`;
        ic = credit ? 'down' : 'up';
        extra.push(spacedMobile(t.counterparty.mobile) || spacedId(t.counterparty.payId), t.note);
        if (d.autopay) extra.push('AutoPay');
      } else if (t.type === 'RECHARGE') {
        title = `Recharge · ${OP[d.operator] || ''} ${spacedMobile(d.mobile || '')}`.trim();
        ic = 'phone';
        extra.push(d.plan, d.autopay ? 'AutoPay' : null);
      } else {
        title = d.method === 'CARD' ? `Added from ${BRAND[d.brand] || 'card'} ${d.kind === 'CREDIT' ? 'credit' : 'debit'} •••• ${d.last4}` : 'Added to wallet';
        ic = d.method === 'CARD' ? 'card' : 'wallet';
      }
      const sub = [fmtDate(t.createdAt), ...extra].filter(Boolean).join(' · ');
      return h('li', { class: 'tx' },
        h('div', { class: `ico2 ${credit ? 'credit' : 'debit'}`, 'aria-hidden': 'true' }, icon(ic)),
        h('div', {}, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub)),
        h('div', { class: `amt ${credit ? 'credit' : 'debit'}` }, `${credit ? '+' : '−'}${rupees(t.amount)}`));
    }
    function paintTx() {
      const rows = allTx.filter(matches);
      setKids(txList, rows.map(txRow));
      if (rows.length === 0) {
        txList.append(h('li', { class: 'empty' }, allTx.length === 0 ? 'No transactions yet. Add money to get started.' : 'Nothing matches your filter.'));
      }
      moreBtn.classList.toggle('hidden', !nextBefore);
    }
    async function loadTransactions(reset) {
      try {
        const qs = new URLSearchParams({ limit: '20' });
        if (!reset && nextBefore) qs.set('before', nextBefore);
        const data = await api(`/transactions?${qs}`);
        allTx = reset ? data.items : allTx.concat(data.items);
        nextBefore = data.nextBefore;
        paintTx();
      } catch (err) {
        if (err.status === 401) return logout('Session expired, please sign in again');
        toast(err.message);
      }
    }
    searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); paintTx(); });
    moreBtn.addEventListener('click', () => loadTransactions(false));
    paintTabs();

    const historyCard = h('section', { class: 'card' },
      h('div', { class: 'tx-head' }, h('h3', {}, 'Activity'), tabs),
      searchInput, txList, h('div', { class: 'center' }, moreBtn));

    setKids(app,
      h('div', { class: 'dash-grid' },
        h('div', {}, balanceCard, panelHost, historyCard),
        h('div', {}, insightsHost, contactsCard)));
    loadTransactions(true); loadInsights(); loadContacts();

    // payment link or scanned code: open the send panel with the number filled in
    if (pendingPay) {
      const target = pendingPay;
      pendingPay = null;
      history.replaceState(null, '', location.pathname + location.search);
      if (target === me.mobile || target === me.payId) toast('That is your own number');
      else showPanel('send', { to: target });
    }
  }

  // ------------------------------------------------------------ start
  window.addEventListener('hashchange', () => {
    const t = readPayHash();
    if (!t) return;
    pendingPay = t;
    if (session.token) renderDashboard();
    else renderLanding('login');
  });

  void QR;
  void maskMobile;
  if (session.token) renderDashboard();
  else renderLanding(pendingPay ? 'login' : 'register');
})();
