/* ═══════════════════════════════════════════════
   Army Bank Admin — app.js
   ═══════════════════════════════════════════════ */

/* ── UTILS ── */
function fmt(date) {
  if (!date) return '—';
  try {
    return new Date(date).toLocaleString('uk-UA', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return date; }
}

function fmtMoney(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

function badge(cls, label) {
  return `<span class="badge badge-${cls}">${label}</span>`;
}

function roleBadge(role) {
  const map = { soldier: 'Солдат', operator: 'Оператор', admin: 'Адмін', platform_admin: 'Plt Admin' };
  return badge(role, map[role] || role);
}

function txTypeBadge(type) {
  const map = { payout: 'Виплата', donation: 'Донат', transfer: 'Переказ', deposit: 'Депозит', withdrawal: 'Зняття' };
  return badge(type, map[type] || type);
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.add('hidden'), 3500);
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/* ── STATE ── */
let currentPage = 'dashboard';
let modalUserId = null;
let selectedPayoutUser = null;
let txOffset = 0;
let txLimit = 50;
let txCurrentRows = [];
let txDetailTx = null;

/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const section = document.getElementById(`page-${page}`);
  if (section) section.classList.add('active');
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');
  const titles = { dashboard: 'Дешборд', users: 'Користувачі', transactions: 'Транзакції', payouts: 'Виплати', audit: 'Аудит' };
  document.getElementById('topbarTitle').textContent = titles[page] || page;
  closeSidebar();
  loadPage(page);
}

function loadPage(page) {
  switch (page) {
    case 'dashboard':    loadDashboard(); break;
    case 'users':        loadUsers(); break;
    case 'transactions': loadTransactions(); break;
    case 'audit':        loadAuditLogs(); break;
  }
}

/* ── SIDEBAR MOBILE ── */
let overlay = null;
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', closeSidebar);
    document.body.appendChild(overlay);
  }
  overlay.classList.add('visible');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  if (overlay) overlay.classList.remove('visible');
}

/* ══════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════ */
function showAuth() {
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('adminApp').classList.add('hidden');
}
function showApp(user) {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('adminApp').classList.remove('hidden');
  const initials = (user.full_name || 'A').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('sidebarAvatar').textContent = initials;
  document.getElementById('sidebarName').textContent = user.full_name || user.email;
  document.getElementById('sidebarRole').textContent = user.role;
  navigate('dashboard');
}

async function tryAutoLogin() {
  if (!api.token) { showAuth(); return; }
  try {
    const res = await api.me();
    const user = res.data;
    if (!['admin', 'platform_admin'].includes(user?.role)) {
      showToast('Недостатньо прав.', 'error');
      api.setToken('');
      showAuth();
      return;
    }
    showApp(user);
  } catch {
    showAuth();
  }
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const identity = document.getElementById('loginIdentity').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Вхід…';
  try {
    const res = await api.login(identity, password);
    const user = res.data?.user || res.user;
    api.setToken(res.data?.token || res.token);
    if (!['admin', 'platform_admin'].includes(user?.role)) {
      api.setToken('');
      errEl.textContent = 'Доступ лише для адміністраторів.';
      errEl.classList.remove('hidden');
      return;
    }
    showApp(user);
  } catch (err) {
    errEl.textContent = err.message || 'Помилка авторизації.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Увійти';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout();
  api.setToken('');
  showAuth();
});

window.addEventListener('admin:unauthorized', () => showAuth());

/* ══════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    const res = await api.stats();
    const d = res.data;

    document.getElementById('statsGrid').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Всього користувачів</div>
        <div class="stat-value">${d.total_users}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Загальний баланс</div>
        <div class="stat-value gold">${fmtMoney(d.total_balance)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Транзакцій</div>
        <div class="stat-value">${d.total_tx}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Виплачено</div>
        <div class="stat-value green">${fmtMoney(d.total_payouts)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Донати</div>
        <div class="stat-value gold">${fmtMoney(d.total_donations)}</div>
      </div>
    `;

    const roleNames = { soldier: 'Солдат', operator: 'Оператор', admin: 'Адмін', platform_admin: 'Platform Admin' };
    document.getElementById('rolesGrid').innerHTML = (d.by_role || []).map(r =>
      `<div class="role-badge">${roleNames[r.role] || r.role} <b>${r.cnt}</b></div>`
    ).join('');

    document.getElementById('recentTxBody').innerHTML = (d.recent_tx || []).map(tx => `
      <tr>
        <td style="font-size:.8rem;color:var(--text-muted)">${fmt(tx.created_at)}</td>
        <td><code style="font-size:.78rem">${escHtml(tx.account_number)}</code></td>
        <td>${txTypeBadge(tx.tx_type)}</td>
        <td>${badge(tx.direction === 'in' ? 'in' : 'out', tx.direction === 'in' ? '↑' : '↓')}</td>
        <td class="${tx.direction === 'in' ? 'amount-in' : 'amount-out'}">${fmtMoney(tx.amount)}</td>
        <td style="color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis">${escHtml(tx.description || '—')}</td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Помилка дешборду: ' + err.message, 'error');
  }
}

document.getElementById('refreshStats').addEventListener('click', loadDashboard);

/* ══════════════════════════════════════════════
   USERS
══════════════════════════════════════════════ */
async function loadUsers() {
  const search = document.getElementById('userSearch').value.trim();
  const role = document.getElementById('userRoleFilter').value;
  try {
    const params = {};
    if (search) params.search = search;
    if (role)   params.role   = role;
    const res = await api.listUsers(params);
    const users = res.data || [];
    const empty = document.getElementById('usersEmpty');
    const tbody = document.getElementById('usersBody');
    if (!users.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    tbody.innerHTML = users.map(u => `
      <tr>
        <td style="color:var(--text-muted);font-size:.8rem">${u.id}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#8a6510);color:#000;font-weight:700;font-size:.7rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              ${escHtml((u.full_name || 'U').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase())}
            </div>
            <b>${escHtml(u.full_name)}</b>
          </div>
        </td>
        <td style="font-size:.82rem">${escHtml(u.phone || '—')}</td>
        <td style="color:var(--text-muted);font-size:.82rem">${escHtml(u.email || '—')}</td>
        <td>${roleBadge(u.role)}</td>
        <td style="color:var(--text-muted);font-size:.78rem">${fmt(u.created_at)}</td>
        <td><button class="btn-table" onclick="openUserModal(${u.id})">Деталі →</button></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Помилка: ' + err.message, 'error');
  }
}

// Debounced search
const debouncedSearch = debounce(loadUsers, 380);
document.getElementById('userSearch').addEventListener('input', debouncedSearch);
document.getElementById('userRoleFilter').addEventListener('change', loadUsers);
document.getElementById('searchUsersBtn').addEventListener('click', loadUsers);

/* ── USER MODAL ── */
function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.modal-tab-content').forEach(c => {
    const show = c.id === `tab-${tab}`;
    c.classList.toggle('active', show);
    c.classList.toggle('hidden', !show);
  });
  if (tab === 'txs' && modalUserId) loadModalTxs(modalUserId);
}

async function openUserModal(userId) {
  modalUserId = userId;
  document.getElementById('userModal').classList.remove('hidden');
  // Reset tabs to info
  switchModalTab('info');
  // Reset action messages
  ['roleChangeMsg', 'payoutMsg'].forEach(id => {
    const el = document.getElementById(id);
    el.className = 'form-msg hidden';
    el.textContent = '';
  });
  document.getElementById('mPayoutAmount').value = '';
  document.getElementById('mPayoutTitle').value  = '';

  try {
    const res = await api.getUser(userId);
    const u = res.data;
    const initials = (u.full_name || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('modalAvatar').textContent = initials;
    document.getElementById('modalUserName').textContent = u.full_name;
    document.getElementById('modalUserRoleBadge').innerHTML = roleBadge(u.role);
    document.getElementById('mUserId').textContent      = u.id;
    document.getElementById('mUserEmail').textContent   = u.email || '—';
    document.getElementById('mUserPhone').textContent   = u.phone || '—';
    document.getElementById('mUserRole').innerHTML      = roleBadge(u.role);
    document.getElementById('mUserStatus').textContent  = u.military_status || '—';
    document.getElementById('mUserCreated').textContent = fmt(u.created_at);
    document.getElementById('mRoleSelect').value        = u.role;
    if (u.account) {
      document.getElementById('mAccNumber').textContent  = u.account.account_number;
      document.getElementById('mAccBalance').textContent = fmtMoney(u.account.balance);
      document.getElementById('mAccountSection').style.display = '';
    } else {
      document.getElementById('mAccountSection').style.display = 'none';
    }
  } catch (err) {
    showToast('Помилка: ' + err.message, 'error');
    closeUserModal();
  }
}
window.openUserModal = openUserModal;

async function loadModalTxs(userId) {
  const loading = document.getElementById('mTxLoading');
  const wrap    = document.getElementById('mTxWrap');
  const empty   = document.getElementById('mTxEmpty');
  loading.style.display = 'block';
  wrap.style.display    = 'none';
  empty.style.display   = 'none';
  try {
    const res = await api.getUserTransactions(userId, 100);
    const txs = res.data || [];
    loading.style.display = 'none';
    if (!txs.length) { empty.style.display = 'block'; return; }
    wrap.style.display = 'block';
    document.getElementById('mTxBody').innerHTML = txs.map(tx => `
      <tr>
        <td style="font-size:.78rem;color:var(--text-muted);white-space:nowrap">${fmt(tx.created_at)}</td>
        <td>${txTypeBadge(tx.tx_type)}</td>
        <td>${badge(tx.direction === 'in' ? 'in' : 'out', tx.direction === 'in' ? '↑' : '↓')}</td>
        <td class="${tx.direction === 'in' ? 'amount-in' : 'amount-out'}">${fmtMoney(tx.amount)}</td>
        <td style="font-size:.78rem;color:var(--text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis">${escHtml(tx.description || '—')}</td>
      </tr>
    `).join('');
  } catch (err) {
    loading.textContent = 'Помилка завантаження.';
  }
}

function closeUserModal() {
  document.getElementById('userModal').classList.add('hidden');
  modalUserId = null;
}

document.getElementById('modalClose').addEventListener('click', closeUserModal);
document.getElementById('userModal').addEventListener('click', e => {
  if (e.target === document.getElementById('userModal')) closeUserModal();
});
document.querySelectorAll('.modal-tab').forEach(btn => {
  btn.addEventListener('click', () => switchModalTab(btn.dataset.tab));
});

document.getElementById('saveRoleBtn').addEventListener('click', async () => {
  if (!modalUserId) return;
  const role  = document.getElementById('mRoleSelect').value;
  const msgEl = document.getElementById('roleChangeMsg');
  try {
    await api.updateRole(modalUserId, role);
    msgEl.textContent  = 'Роль оновлено!';
    msgEl.className    = 'form-msg success';
    document.getElementById('mUserRole').innerHTML        = roleBadge(role);
    document.getElementById('modalUserRoleBadge').innerHTML = roleBadge(role);
    showToast('Роль оновлено', 'success');
    loadUsers();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = 'form-msg error';
  }
});

document.getElementById('mPayoutBtn').addEventListener('click', async () => {
  if (!modalUserId) return;
  const amount = parseFloat(document.getElementById('mPayoutAmount').value);
  const title  = document.getElementById('mPayoutTitle').value.trim() || 'Бойова виплата';
  const msgEl  = document.getElementById('payoutMsg');
  if (!amount || amount <= 0) {
    msgEl.textContent = 'Вкажіть коректну суму.';
    msgEl.className   = 'form-msg error';
    return;
  }
  try {
    const res = await api.createPayout({ user_id: modalUserId, amount, title });
    msgEl.textContent = `✓ Нараховано ${fmtMoney(amount)}. Баланс: ${fmtMoney(res.data.new_balance)}`;
    msgEl.className   = 'form-msg success';
    document.getElementById('mAccBalance').textContent = fmtMoney(res.data.new_balance);
    document.getElementById('mPayoutAmount').value = '';
    document.getElementById('mPayoutTitle').value  = '';
    showToast('Виплату нараховано', 'success');
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = 'form-msg error';
  }
});

/* ══════════════════════════════════════════════
   TRANSACTIONS
══════════════════════════════════════════════ */
async function loadTransactions(offset = 0) {
  txOffset = offset;
  txLimit = Number(document.getElementById('txLimitFilter')?.value || 50);
  const params = { limit: txLimit, offset };
  const txType = document.getElementById('txTypeFilter')?.value || '';
  const dir    = document.getElementById('txDirFilter')?.value || '';
  const from   = document.getElementById('txFromDate')?.value || '';
  const to     = document.getElementById('txToDate')?.value || '';
  const search = document.getElementById('txSearchFilter')?.value.trim() || '';
  const userId = Number(document.getElementById('txUserIdFilter')?.value || 0);
  const minAmountRaw = document.getElementById('txMinAmountFilter')?.value;
  const maxAmountRaw = document.getElementById('txMaxAmountFilter')?.value;
  const sortBy = document.getElementById('txSortFilter')?.value || 'newest';

  if (txType) params.tx_type = txType;
  if (dir) params.direction = dir;
  if (from) params.from_date = from;
  if (to) params.to_date = to;
  if (search) params.search = search;
  if (userId > 0) params.user_id = userId;
  if (minAmountRaw !== '' && Number(minAmountRaw) >= 0) params.min_amount = Number(minAmountRaw);
  if (maxAmountRaw !== '' && Number(maxAmountRaw) >= 0) params.max_amount = Number(maxAmountRaw);

  try {
    const res   = await api.listTransactions(params);
    let rows    = res.data  || [];
    const total = res.total || 0;

    if (sortBy === 'oldest') {
      rows = rows.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    } else if (sortBy === 'amount_desc') {
      rows = rows.slice().sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    } else if (sortBy === 'amount_asc') {
      rows = rows.slice().sort((a, b) => Number(a.amount || 0) - Number(b.amount || 0));
    }

    txCurrentRows = rows;
    document.getElementById('txCount').textContent = `${total} транзакцій`;
    updateTxRegistry(rows);

    document.getElementById('txBody').innerHTML = rows.map(tx => `
      <tr>
        <td style="font-size:.78rem;color:var(--text-muted)">#${tx.id}</td>
        <td style="font-size:.8rem;color:var(--text-muted);white-space:nowrap">${fmt(tx.created_at)}</td>
        <td style="font-size:.82rem">${escHtml(tx.full_name || '—')}</td>
        <td><code style="font-size:.78rem">${escHtml(tx.account_number || '—')}</code></td>
        <td>${txTypeBadge(tx.tx_type)}</td>
        <td>${badge(tx.direction === 'in' ? 'in' : 'out', tx.direction === 'in' ? '↑ Зарах.' : '↓ Спис.')}</td>
        <td class="${tx.direction === 'in' ? 'amount-in' : 'amount-out'}">${fmtMoney(tx.amount)}</td>
        <td class="tx-desc-cell" title="${escHtml(tx.description || '—')}">${escHtml(tx.description || '—')}</td>
        <td>
          <div class="tx-row-actions">
            <button class="tx-mini-btn" onclick="openTxDetailById(${tx.id})">Деталі</button>
            <button class="tx-mini-btn" onclick="openUserModal(${tx.user_id})">User</button>
          </div>
        </td>
      </tr>
    `).join('');

    renderPagination(total, offset, txLimit);
    loadTxChart().catch(() => {});
  } catch (err) {
    showToast('Помилка: ' + err.message, 'error');
  }
}

function renderPagination(total, offset, limit) {
  const bar   = document.getElementById('txPagination');
  const pages = Math.ceil(total / limit);
  const cur   = Math.floor(offset / limit);
  if (pages <= 1) { bar.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${cur === 0 ? 'disabled' : ''} onclick="loadTransactions(${(cur - 1) * limit})">‹</button>`;
  const start = Math.max(0, cur - 2);
  const end   = Math.min(pages - 1, cur + 2);
  if (start > 0) {
    html += `<button class="page-btn" onclick="loadTransactions(0)">1</button>`;
    if (start > 1) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === cur ? 'active' : ''}" onclick="loadTransactions(${i * limit})">${i + 1}</button>`;
  }
  if (end < pages - 1) {
    if (end < pages - 2) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
    html += `<button class="page-btn" onclick="loadTransactions(${(pages - 1) * limit})">${pages}</button>`;
  }
  html += `<button class="page-btn" ${cur >= pages - 1 ? 'disabled' : ''} onclick="loadTransactions(${(cur + 1) * limit})">›</button>`;
  bar.innerHTML = html;
}

function updateTxRegistry(rows) {
  const inTotal = rows
    .filter(tx => tx.direction === 'in')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const outTotal = rows
    .filter(tx => tx.direction === 'out')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const net = inTotal - outTotal;
  const avg = rows.length ? (inTotal + outTotal) / rows.length : 0;

  document.getElementById('txRegPageCount').textContent = `${rows.length}`;
  document.getElementById('txRegIn').textContent = fmtMoney(inTotal);
  document.getElementById('txRegOut').textContent = fmtMoney(outTotal);
  document.getElementById('txRegNet').textContent = fmtMoney(net);
  document.getElementById('txRegAvg').textContent = fmtMoney(avg);
}

function applyTxQuickRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const toIso = to.toISOString().slice(0, 10);
  const fromIso = from.toISOString().slice(0, 10);
  document.getElementById('txFromDate').value = fromIso;
  document.getElementById('txToDate').value = toIso;
  document.querySelectorAll('.tx-period-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.days) === days);
  });
}

function clearTxFilters() {
  const defaults = [
    ['txSearchFilter', ''],
    ['txTypeFilter', ''],
    ['txDirFilter', ''],
    ['txUserIdFilter', ''],
    ['txMinAmountFilter', ''],
    ['txMaxAmountFilter', ''],
    ['txFromDate', ''],
    ['txToDate', ''],
    ['txSortFilter', 'newest'],
    ['txLimitFilter', '50'],
  ];
  defaults.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  document.querySelectorAll('.tx-period-btn').forEach(btn => btn.classList.remove('active'));
}

function csvEscape(value) {
  const v = String(value ?? '');
  if (!/[,"\n]/.test(v)) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

function exportTransactionsCsv() {
  if (!txCurrentRows.length) {
    showToast('Немає даних для експорту.', 'error');
    return;
  }
  const header = ['id', 'created_at', 'user_id', 'full_name', 'account_number', 'tx_type', 'direction', 'amount', 'description'];
  const lines = [
    header.join(','),
    ...txCurrentRows.map(tx => [
      tx.id, tx.created_at, tx.user_id, tx.full_name, tx.account_number,
      tx.tx_type, tx.direction, tx.amount, tx.description || '',
    ].map(csvEscape).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transactions_registry_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildLocalDailyStats(rows = []) {
  const map = new Map();
  rows.forEach(tx => {
    const d = new Date(tx.created_at);
    if (Number.isNaN(d.getTime())) return;
    const key = d.toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, { day: key, vol_in: 0, vol_out: 0 });
    const slot = map.get(key);
    if (tx.direction === 'in') slot.vol_in += Number(tx.amount || 0);
    else slot.vol_out += Number(tx.amount || 0);
  });
  return Array.from(map.values()).sort((a, b) => new Date(a.day) - new Date(b.day));
}

function renderTxChart(daily = [], source = 'api') {
  const wrap = document.getElementById('txChartWrap');
  if (!wrap) return;
  if (!daily.length) {
    wrap.innerHTML = '<div class="mini-chart-empty">Недостатньо даних для графіка.</div>';
    return;
  }

  const width = Math.max(wrap.clientWidth - 12, 320);
  const height = 148;
  const pad = 16;
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  const maxVal = Math.max(
    1,
    ...daily.map(d => Number(d.vol_in || 0)),
    ...daily.map(d => Number(d.vol_out || 0))
  );
  const pointAt = (idx, val) => {
    const x = pad + (daily.length === 1 ? usableW / 2 : (idx * usableW) / (daily.length - 1));
    const y = pad + usableH - (Number(val || 0) / maxVal) * usableH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const lineIn = daily.map((d, i) => pointAt(i, d.vol_in)).join(' ');
  const lineOut = daily.map((d, i) => pointAt(i, d.vol_out)).join(' ');
  const totalIn = daily.reduce((s, d) => s + Number(d.vol_in || 0), 0);
  const totalOut = daily.reduce((s, d) => s + Number(d.vol_out || 0), 0);
  const marks = [0.25, 0.5, 0.75].map(p => (pad + usableH * p).toFixed(1));

  wrap.innerHTML = `
    <div style="width:100%">
      <svg class="mini-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
        ${marks.map(y => `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="rgba(255,255,255,.08)" stroke-width="1"/>`).join('')}
        <polyline points="${lineOut}" fill="none" stroke="#f87171" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
        <polyline points="${lineIn}" fill="none" stroke="#3ecf8e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
      </svg>
      <div class="mini-chart-legend">
        <span><span class="legend-dot in"></span>IN ${fmtMoney(totalIn)}</span>
        <span><span class="legend-dot out"></span>OUT ${fmtMoney(totalOut)}</span>
        ${source === 'local' ? '<span>локально (поточна стор.)</span>' : ''}
      </div>
    </div>
  `;
}

async function loadTxChart() {
  const days = Number(document.getElementById('txChartDays')?.value || 30);
  try {
    const res = await api.chartStats(days);
    renderTxChart((res.data && res.data.daily) || [], 'api');
  } catch (_err) {
    renderTxChart(buildLocalDailyStats(txCurrentRows), 'local');
  }
}

function openTxDetailById(id) {
  const tx = txCurrentRows.find(row => Number(row.id) === Number(id));
  if (!tx) {
    showToast('Транзакцію не знайдено.', 'error');
    return;
  }
  txDetailTx = tx;
  document.getElementById('txDetailTitle').textContent = `Транзакція #${tx.id}`;
  document.getElementById('txDetailBadge').innerHTML = txTypeBadge(tx.tx_type);
  document.getElementById('txDetailId').textContent = tx.id;
  document.getElementById('txDetailDate').textContent = fmt(tx.created_at);
  document.getElementById('txDetailUser').textContent = tx.full_name || '—';
  document.getElementById('txDetailUserId').textContent = tx.user_id || '—';
  document.getElementById('txDetailAccount').textContent = tx.account_number || '—';
  document.getElementById('txDetailType').innerHTML = txTypeBadge(tx.tx_type);
  document.getElementById('txDetailDir').innerHTML = badge(tx.direction === 'in' ? 'in' : 'out', tx.direction === 'in' ? '↑ Зарахування' : '↓ Списання');
  document.getElementById('txDetailAmount').textContent = fmtMoney(tx.amount);
  document.getElementById('txDetailDesc').textContent = tx.description || '—';
  const msgEl = document.getElementById('txAdjustMsg');
  msgEl.className = 'form-msg hidden';
  msgEl.textContent = '';
  document.getElementById('txAdjustAmount').value = '';
  document.getElementById('txAdjustReason').value = tx.description || 'Коригування адміністратором';
  document.getElementById('txDetailModal').classList.remove('hidden');
}
window.openTxDetailById = openTxDetailById;

function closeTxDetail() {
  document.getElementById('txDetailModal').classList.add('hidden');
  txDetailTx = null;
}

async function submitTxAdjustment(type) {
  if (!txDetailTx || !txDetailTx.user_id) return;
  const amount = Number(document.getElementById('txAdjustAmount').value || 0);
  const reason = (document.getElementById('txAdjustReason').value || '').trim() || 'Коригування адміністратором';
  const msgEl = document.getElementById('txAdjustMsg');
  if (!(amount > 0)) {
    msgEl.textContent = 'Вкажіть коректну суму.';
    msgEl.className = 'form-msg error';
    return;
  }
  try {
    const res = await api.adjustUserBalance(txDetailTx.user_id, { amount, reason, type });
    msgEl.textContent = `✓ Застосовано ${type === 'credit' ? 'зарахування' : 'списання'} ${fmtMoney(amount)}. Новий баланс: ${fmtMoney(res.data.new_balance)}.`;
    msgEl.className = 'form-msg success';
    showToast('Баланс скориговано', 'success');
    loadTransactions(txOffset);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'form-msg error';
  }
}

document.getElementById('filterTxBtn').addEventListener('click', () => loadTransactions(0));
document.getElementById('clearTxBtn').addEventListener('click', () => {
  clearTxFilters();
  loadTransactions(0);
});
document.getElementById('exportTxCsvBtn').addEventListener('click', exportTransactionsCsv);
document.getElementById('txChartDays').addEventListener('change', loadTxChart);
document.getElementById('txLimitFilter').addEventListener('change', () => loadTransactions(0));
document.querySelectorAll('.tx-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyTxQuickRange(Number(btn.dataset.days));
    loadTransactions(0);
  });
});
['txFromDate', 'txToDate'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    document.querySelectorAll('.tx-period-btn').forEach(btn => btn.classList.remove('active'));
  });
});
document.getElementById('txDetailClose').addEventListener('click', closeTxDetail);
document.getElementById('txDetailModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('txDetailModal')) closeTxDetail();
});
document.getElementById('txAdjustCreditBtn').addEventListener('click', () => submitTxAdjustment('credit'));
document.getElementById('txAdjustDebitBtn').addEventListener('click', () => submitTxAdjustment('debit'));
document.getElementById('txOpenUserBtn').addEventListener('click', () => {
  if (!txDetailTx || !txDetailTx.user_id) return;
  closeTxDetail();
  navigate('users');
  openUserModal(txDetailTx.user_id);
});
document.getElementById('txSearchFilter').addEventListener('input', debounce(() => loadTransactions(0), 420));

/* ══════════════════════════════════════════════
   PAYOUTS PAGE
══════════════════════════════════════════════ */
const debouncedPayoutSearch = debounce(async (q) => {
  if (q.length < 2) { document.getElementById('payoutUserDropdown').classList.add('hidden'); return; }
  try {
    const res   = await api.listUsers({ search: q });
    const users = (res.data || []).slice(0, 8);
    const dd    = document.getElementById('payoutUserDropdown');
    if (!users.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = users.map(u => `
      <div class="dropdown-item" onclick="selectPayoutUser(${u.id}, '${escHtml(u.full_name)}', '${escHtml(u.phone || u.email || '')}')">
        <div class="d-name">${escHtml(u.full_name)}</div>
        <div class="d-sub">${escHtml(u.phone || '')} ${escHtml(u.email || '')}</div>
      </div>
    `).join('');
    dd.classList.remove('hidden');
  } catch {}
}, 350);

document.getElementById('payoutUserSearch').addEventListener('input', e => debouncedPayoutSearch(e.target.value.trim()));

function selectPayoutUser(id, name, sub) {
  selectedPayoutUser = id;
  document.getElementById('payoutUserSearch').value = '';
  document.getElementById('payoutUserDropdown').classList.add('hidden');
  document.getElementById('selectedUserChip').classList.remove('hidden');
  document.getElementById('selectedUserName').textContent = `${name}${sub ? ' — ' + sub : ''}`;
  document.getElementById('submitPayoutBtn').disabled = false;
}
window.selectPayoutUser = selectPayoutUser;

document.getElementById('clearSelectedUser').addEventListener('click', () => {
  selectedPayoutUser = null;
  document.getElementById('selectedUserChip').classList.add('hidden');
  document.getElementById('submitPayoutBtn').disabled = true;
});

document.getElementById('submitPayoutBtn').addEventListener('click', async () => {
  if (!selectedPayoutUser) return;
  const amount      = parseFloat(document.getElementById('payoutAmount').value);
  const title       = document.getElementById('payoutTitle').value.trim() || 'Бойова виплата';
  const payout_type = document.getElementById('payoutType').value;
  const msgEl       = document.getElementById('payoutFormMsg');
  if (!amount || amount <= 0) {
    msgEl.textContent = 'Вкажіть коректну суму.';
    msgEl.className   = 'form-msg error';
    return;
  }
  try {
    const res = await api.createPayout({ user_id: selectedPayoutUser, amount, title, payout_type });
    msgEl.textContent = `✓ Виплату ${fmtMoney(amount)} нараховано успішно.`;
    msgEl.className   = 'form-msg success';
    document.getElementById('payoutAmount').value = '';
    document.getElementById('payoutTitle').value  = '';
    showToast('Виплату нараховано', 'success');
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = 'form-msg error';
  }
});

/* ══════════════════════════════════════════════
   AUDIT LOG
══════════════════════════════════════════════ */
async function loadAuditLogs() {
  try {
    const res  = await api.listAuditLogs({ limit: 200 });
    const logs = res.data || [];
    const eventLabels = {
      login: 'Вхід', logout: 'Вихід', register: 'Реєстрація',
      payout_received: 'Виплата', admin_payout: 'Адмін: виплата',
      admin_role_change: 'Зміна ролі', donation: 'Донат',
      transfer_out: 'Переказ (вих.)', transfer_in: 'Переказ (вх.)',
      withdrawal: 'Зняття', deposit: 'Депозит',
    };
    document.getElementById('auditBody').innerHTML = logs.map(l => `
      <tr>
        <td style="color:var(--text-muted);font-size:.8rem;white-space:nowrap">${fmt(l.created_at)}</td>
        <td style="color:var(--text-muted);font-size:.82rem">${l.user_id || '—'}</td>
        <td><span class="badge" style="background:rgba(255,255,255,.06);color:var(--text)">${eventLabels[l.action] || escHtml(l.action)}</span></td>
        <td style="font-size:.82rem;color:var(--text-muted);max-width:350px;overflow:hidden;text-overflow:ellipsis">${escHtml(l.details || '—')}</td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Помилка: ' + err.message, 'error');
  }
}

document.getElementById('refreshAudit').addEventListener('click', loadAuditLogs);

/* ══════════════════════════════════════════════
   NAV BINDINGS
══════════════════════════════════════════════ */
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => { e.preventDefault(); navigate(item.dataset.page); });
});

document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
});

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
tryAutoLogin();
