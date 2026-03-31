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

function txTypeLabel(type) {
  const map = { payout: 'Виплата', donation: 'Донат', transfer: 'Переказ', deposit: 'Депозит', withdrawal: 'Зняття' };
  return map[type] || (type || '—');
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
let currentAdminUser = null;
let modalUserId = null;
let selectedPayoutUser = null;
let txOffset = 0;
let txLimit = 50;
let txCurrentRows = [];
let txReqSeq = 0;
let txChartReqSeq = 0;
let txDetailTx = null;
let procOrderOffset = 0;
let procRiskOffset = 0;
let procSlaOffset = 0;
let procInboxOffset = 0;
const PROC_LIMIT = 30;
const PROC_SLA_LIMIT = 20;
const PROC_INBOX_LIMIT = 12;
let procLastRiskCount = 0;
let procModalOrderId = null;
let procSlaSelectedIds = new Set();
let cardsOffset = 0;
const CARDS_LIMIT = 50;
let cmpOffset = 0;
const CMP_LIMIT = 50;
let cmpModalUserId = null;
let issueCardSelectedUserId = null;
const procRequestSeq = {
  fraud: 0,
  orders: 0,
  sla: 0,
  workload: 0,
  inbox: 0,
  risk: 0,
};
const PROCESSING_ROLES = new Set(['operator', 'admin', 'platform_admin']);
const ADMIN_ROLES = new Set(['admin', 'platform_admin']);
const OPERATOR_BULK_ACTIONS = new Set(['assign', 'escalate', 'note']);
const FULL_ACCESS_PAGES = ['dashboard', 'users', 'transactions', 'processing', 'payouts', 'cards', 'compliance', 'audit'];
const SLA_MINUTES_BY_RISK = { critical: 15, high: 60, medium: 240, low: 720 };
const SLA_RISK_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };
const SLA_PRIORITY_WEIGHT = { critical: 4, high: 3, medium: 2, normal: 1 };

async function refreshProcessingViews({
  fraud = false,
  orders = false,
  sla = false,
  workload = false,
  inbox = false,
  risk = false,
  caseModal = false,
  ordersOffset = procOrderOffset,
  slaOffset = procSlaOffset,
  inboxOffset = procInboxOffset,
  riskOffset = procRiskOffset,
} = {}) {
  const jobs = [];
  if (fraud) jobs.push(loadFraudStats());
  if (orders) jobs.push(loadPaymentOrders(ordersOffset));
  if (sla) jobs.push(loadPaymentSlaQueue(slaOffset));
  if (workload) jobs.push(loadProcessingWorkload());
  if (inbox) jobs.push(loadApprovalInbox(inboxOffset));
  if (risk) jobs.push(loadPaymentRiskEvents(riskOffset));
  if (caseModal && procModalOrderId) jobs.push(refreshPaymentOrderCase());
  if (!jobs.length) return;
  await Promise.all(jobs);
}

function normalizedRole(role) {
  return String(role || '').trim().toLowerCase();
}

function isProcessingRole(role = currentAdminUser?.role) {
  return PROCESSING_ROLES.has(normalizedRole(role));
}

function isAdminRole(role = currentAdminUser?.role) {
  return ADMIN_ROLES.has(normalizedRole(role));
}

function isOperatorRole(role = currentAdminUser?.role) {
  return normalizedRole(role) === 'operator';
}

function allowedPagesForRole(role = currentAdminUser?.role) {
  if (isOperatorRole(role)) return ['processing'];
  if (isAdminRole(role)) return FULL_ACCESS_PAGES;
  return [];
}

function defaultPageForRole(role = currentAdminUser?.role) {
  const pages = allowedPagesForRole(role);
  return pages[0] || 'processing';
}

function canAccessPage(page, role = currentAdminUser?.role) {
  return allowedPagesForRole(role).includes(page);
}

function configureBulkActionsByRole() {
  const bulkActionSelect = document.getElementById('procSlaBulkAction');
  if (!bulkActionSelect) return;
  const admin = isAdminRole();

  Array.from(bulkActionSelect.options || []).forEach(option => {
    const value = String(option.value || '').trim().toLowerCase();
    if (!value) {
      option.disabled = false;
      option.hidden = false;
      return;
    }
    const allowed = admin || OPERATOR_BULK_ACTIONS.has(value);
    option.disabled = !allowed;
    option.hidden = !allowed;
  });

  const selected = String(bulkActionSelect.value || '').trim().toLowerCase();
  if (selected && !admin && !OPERATOR_BULK_ACTIONS.has(selected)) {
    bulkActionSelect.value = '';
  }

  const assigneeInput = document.getElementById('procSlaBulkAssignee');
  if (assigneeInput) {
    assigneeInput.disabled = !admin;
    if (!admin) assigneeInput.value = `${currentAdminUser?.id || ''}`;
  }
}

function applyRoleUi() {
  const allowed = new Set(allowedPagesForRole());
  document.querySelectorAll('.nav-item').forEach(item => {
    const page = item.dataset.page;
    item.classList.toggle('hidden', !allowed.has(page));
  });

  const operatorHint = document.getElementById('procRoleModeHint');
  if (operatorHint) {
    const operatorMode = isOperatorRole();
    operatorHint.classList.toggle('hidden', !operatorMode);
    if (operatorMode) {
      operatorHint.textContent = 'Operator mode: only processing actions are available.';
    }
  }

  const autoEsc = document.getElementById('procSlaAutoEscalateBtn');
  if (autoEsc) autoEsc.classList.toggle('hidden', !isAdminRole());

  configureBulkActionsByRole();
}

/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
function navigate(page) {
  if (!canAccessPage(page)) {
    page = defaultPageForRole();
  }
  currentPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const section = document.getElementById(`page-${page}`);
  if (section) section.classList.add('active');
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');
  const titles = {
    dashboard: 'Дешборд',
    users: 'Користувачі',
    transactions: 'Транзакції',
    processing: 'Процесинг',
    payouts: 'Виплати',
    cards: 'Картки',
    compliance: 'Комплаєнс',
    audit: 'Аудит',
  };
  document.getElementById('topbarTitle').textContent = titles[page] || page;
  closeSidebar();
  loadPage(page);
}

function loadPage(page) {
  switch (page) {
    case 'dashboard':    loadDashboard(); break;
    case 'users':        loadUsers(); break;
    case 'transactions': loadTransactions(); loadTxChart(); break;
    case 'processing':   loadProcessing(); break;
    case 'cards':        loadAdminCards(); break;
    case 'compliance':   loadCompliance(); break;
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
  currentAdminUser = null;
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('adminApp').classList.add('hidden');
}
function showApp(user) {
  currentAdminUser = user || null;
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('adminApp').classList.remove('hidden');
  const initials = (user.full_name || 'A').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('sidebarAvatar').textContent = initials;
  document.getElementById('sidebarName').textContent = user.full_name || user.email;
  document.getElementById('sidebarRole').textContent = user.role;
  applyRoleUi();
  navigate(defaultPageForRole(user.role));
}

async function tryAutoLogin() {
  if (!api.token) { showAuth(); return; }
  try {
    const res = await api.me();
    const user = res.data;
    if (!isProcessingRole(user?.role)) {
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
    if (!isProcessingRole(user?.role)) {
      api.setToken('');
      errEl.textContent = 'Доступ дозволено лише для operator/admin/platform_admin.';
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
        <td>${kycBadge(u.kyc_status || 'pending')}</td>
        <td>${u.aml_flag ? '<span class="badge badge-blocked" style="font-size:.72rem">⚑</span>' : '<span style="color:var(--text-muted);font-size:.78rem">—</span>'}</td>
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
  if (tab === 'compliance' && modalUserId) loadModalCompliance(modalUserId);
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

async function loadModalCompliance(userId) {
  const loading = document.getElementById('mCmpLoading');
  const content = document.getElementById('mCmpContent');
  const editSec = document.getElementById('mCmpEditSection');
  loading.style.display = 'block';
  content.style.display = 'none';
  editSec.style.display = 'none';
  document.getElementById('mCmpMsg').classList.add('hidden');
  try {
    const res = await api.complianceGetUser(userId);
    const cp = res.data?.compliance || {};
    document.getElementById('mCmpKycStatus').innerHTML = kycBadge(cp.kyc_status);
    document.getElementById('mCmpAmlFlag').innerHTML   = cp.aml_flag
      ? '<span class="badge badge-blocked" style="font-size:.75rem">⚑ AML</span>'
      : '<span style="color:var(--text-muted)">—</span>';
    document.getElementById('mCmpRiskLevel').innerHTML  = riskBadge(cp.risk_level);
    document.getElementById('mCmpNotes').textContent    = cp.notes || '—';
    document.getElementById('mCmpUpdatedAt').textContent = cp.updated_at ? fmt(cp.updated_at) : '—';
    document.getElementById('mCmpUpdatedBy').textContent = cp.updated_by_name || (cp.updated_by ? `#${cp.updated_by}` : '—');
    // pre-fill edit form
    document.getElementById('mCmpEditKyc').value  = cp.kyc_status || 'pending';
    document.getElementById('mCmpEditRisk').value = cp.risk_level || 'low';
    document.getElementById('mCmpEditAml').checked = !!cp.aml_flag;
    document.getElementById('mCmpEditNotes').value = cp.notes || '';
    loading.style.display = 'none';
    content.style.display = 'block';
    editSec.style.display = 'block';
  } catch (err) {
    loading.textContent = 'Помилка: ' + err.message;
  }
}

document.getElementById('mCmpSaveBtn')?.addEventListener('click', async () => {
  if (!modalUserId) return;
  const msg = document.getElementById('mCmpMsg');
  msg.classList.add('hidden');
  try {
    await api.complianceUpdateUser(modalUserId, {
      kyc_status: document.getElementById('mCmpEditKyc').value,
      risk_level: document.getElementById('mCmpEditRisk').value,
      aml_flag:   document.getElementById('mCmpEditAml').checked ? 1 : 0,
      notes:      document.getElementById('mCmpEditNotes').value.trim() || null,
    });
    showToast('Комплаєнс оновлено!');
    loadModalCompliance(modalUserId);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

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
  const reqId = ++txReqSeq;
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
  const highValueOnly = Boolean(document.getElementById('txHighValueOnly')?.checked);
  const highValueMinRaw = document.getElementById('txHighValueMin')?.value;
  const sortBy = document.getElementById('txSortFilter')?.value || 'newest';

  if (txType) params.tx_type = txType;
  if (dir) params.direction = dir;
  if (from) params.from_date = from;
  if (to) params.to_date = to;
  if (search) params.search = search;
  if (userId > 0) params.user_id = userId;
  if (minAmountRaw !== '' && Number(minAmountRaw) >= 0) params.min_amount = Number(minAmountRaw);
  if (maxAmountRaw !== '' && Number(maxAmountRaw) >= 0) params.max_amount = Number(maxAmountRaw);
  if (highValueOnly) params.high_value_only = 'true';
  if (highValueMinRaw !== '' && Number(highValueMinRaw) > 0) params.high_value_min = Number(highValueMinRaw);
  params.sort_by = sortBy;

  try {
    const res   = await api.listTransactions(params);
    if (reqId !== txReqSeq) return;
    const rows  = res.data  || [];
    const total = res.total || 0;
    const summary = res.summary || null;
    const highValueThreshold = Number(summary?.high_value_threshold || 0);

    txCurrentRows = rows;
    document.getElementById('txCount').textContent = `${total} транзакцій`;
    updateTxRegistry(rows, summary);
    renderTxInsights(summary, rows);

    document.getElementById('txBody').innerHTML = rows.map(tx => {
      const isHighValue = highValueThreshold > 0 && Number(tx.amount || 0) >= highValueThreshold;
      return `
      <tr class="${isHighValue ? 'tx-high-value' : ''}">
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
    `;
    }).join('');

    renderPagination(total, offset, txLimit);
  } catch (err) {
    if (reqId !== txReqSeq) return;
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

function updateTxRegistry(rows, summary = null) {
  let inTotal = rows
    .filter(tx => tx.direction === 'in')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  let outTotal = rows
    .filter(tx => tx.direction === 'out')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  let net = inTotal - outTotal;
  let avg = rows.length ? (inTotal + outTotal) / rows.length : 0;
  let count = rows.length;
  let minAmount = rows.length ? Math.min(...rows.map(tx => Number(tx.amount || 0))) : 0;
  let maxAmount = rows.length ? Math.max(...rows.map(tx => Number(tx.amount || 0))) : 0;
  let medianAmount = 0;
  let p90Amount = 0;
  let highValueCount = 0;
  let uniqueUsers = new Set(rows.map(tx => Number(tx.user_id || 0)).filter(Boolean)).size;
  let topType = rows.length ? rows.reduce((acc, tx) => {
    const key = String(tx.tx_type || 'other');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}) : {};
  if (rows.length) {
    topType = Object.entries(topType).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || '—';
  } else {
    topType = '—';
  }
  if (rows.length) {
    const sorted = rows.map(tx => Number(tx.amount || 0)).sort((a, b) => a - b);
    const midLow = sorted[(sorted.length - 1) >> 1] || 0;
    const midHigh = sorted[sorted.length >> 1] || 0;
    medianAmount = (midLow + midHigh) / 2;
    const p90Idx = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
    p90Amount = sorted[p90Idx] || 0;
    const localThreshold = maxAmount > 0 ? Math.max(avg * 3, maxAmount * 0.65) : 0;
    highValueCount = localThreshold > 0
      ? rows.filter(tx => Number(tx.amount || 0) >= localThreshold).length
      : 0;
  }

  if (summary && typeof summary === 'object') {
    inTotal = Number(summary.total_in || 0);
    outTotal = Number(summary.total_out || 0);
    net = Number(summary.net || 0);
    avg = Number(summary.avg_amount || 0);
    count = Number(summary.count || 0);
    minAmount = Number(summary.min_amount || 0);
    maxAmount = Number(summary.max_amount || 0);
    medianAmount = Number(summary.median_amount || medianAmount);
    p90Amount = Number(summary.p90_amount || p90Amount);
    highValueCount = Number(summary.count_high_value || highValueCount);
    uniqueUsers = Number(summary.unique_users || 0);
    topType = summary.top_tx_type || topType;
  }

  document.getElementById('txRegPageCount').textContent = `${count}`;
  document.getElementById('txRegIn').textContent = fmtMoney(inTotal);
  document.getElementById('txRegOut').textContent = fmtMoney(outTotal);
  document.getElementById('txRegNet').textContent = fmtMoney(net);
  document.getElementById('txRegAvg').textContent = fmtMoney(avg);
  const txRegMedian = document.getElementById('txRegMedian');
  if (txRegMedian) txRegMedian.textContent = fmtMoney(medianAmount);
  const txRegP90 = document.getElementById('txRegP90');
  if (txRegP90) txRegP90.textContent = fmtMoney(p90Amount);
  const txRegMin = document.getElementById('txRegMin');
  if (txRegMin) txRegMin.textContent = fmtMoney(minAmount);
  const txRegMax = document.getElementById('txRegMax');
  if (txRegMax) txRegMax.textContent = fmtMoney(maxAmount);
  const txRegUsers = document.getElementById('txRegUsers');
  if (txRegUsers) txRegUsers.textContent = `${uniqueUsers}`;
  const txRegTopType = document.getElementById('txRegTopType');
  if (txRegTopType) txRegTopType.textContent = txTypeLabel(String(topType || ''));
  const txRegHighValueCount = document.getElementById('txRegHighValueCount');
  if (txRegHighValueCount) txRegHighValueCount.textContent = `${Math.max(0, Math.round(highValueCount))}`;
}

function renderTxInsights(summary = null, rows = []) {
  const usersWrap = document.getElementById('txTopUsersBody');
  const typesWrap = document.getElementById('txTopTypesBody');
  if (!usersWrap || !typesWrap) return;

  let topUsers = Array.isArray(summary?.top_users) ? summary.top_users.slice(0, 5) : [];
  if (!topUsers.length && rows.length) {
    const map = new Map();
    rows.forEach(tx => {
      const id = Number(tx.user_id || 0);
      if (!id) return;
      if (!map.has(id)) {
        map.set(id, { user_id: id, full_name: tx.full_name || '—', turnover: 0, tx_count: 0 });
      }
      const slot = map.get(id);
      slot.turnover += Number(tx.amount || 0);
      slot.tx_count += 1;
    });
    topUsers = Array.from(map.values())
      .sort((a, b) => Number(b.turnover || 0) - Number(a.turnover || 0))
      .slice(0, 5);
  }

  usersWrap.innerHTML = topUsers.length
    ? topUsers.map(row => `
      <div class="tx-insight-row">
        <div class="tx-insight-main">
          <div class="tx-insight-name">${escHtml(row.full_name || '—')}</div>
          <div class="tx-insight-sub">#${row.user_id || '—'} · ${row.tx_count || 0} tx</div>
        </div>
        <div class="tx-insight-val">${fmtMoney(row.turnover || 0)}</div>
      </div>
    `).join('')
    : '<div class="mini-chart-empty">Немає даних для топ-користувачів.</div>';

  let byType = Array.isArray(summary?.by_type) ? summary.by_type.slice(0, 6) : [];
  if (!byType.length && rows.length) {
    const map = new Map();
    rows.forEach(tx => {
      const key = String(tx.tx_type || 'other');
      if (!map.has(key)) map.set(key, { tx_type: key, cnt: 0, total_amount: 0 });
      const slot = map.get(key);
      slot.cnt += 1;
      slot.total_amount += Number(tx.amount || 0);
    });
    byType = Array.from(map.values()).sort((a, b) => Number(b.cnt || 0) - Number(a.cnt || 0)).slice(0, 6);
  }

  typesWrap.innerHTML = byType.length
    ? byType.map(row => `
      <div class="tx-insight-row">
        <div class="tx-insight-main">
          <div class="tx-insight-name">${escHtml(txTypeLabel(String(row.tx_type || '')))}</div>
          <div class="tx-insight-sub">${Number(row.cnt || 0)} tx</div>
        </div>
        <div class="tx-insight-val">${fmtMoney(row.total_amount || 0)}</div>
      </div>
    `).join('')
    : '<div class="mini-chart-empty">Немає даних для типів транзакцій.</div>';
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
    ['txHighValueMin', ''],
    ['txFromDate', ''],
    ['txToDate', ''],
    ['txSortFilter', 'newest'],
    ['txLimitFilter', '50'],
  ];
  defaults.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  const txHighValueOnly = document.getElementById('txHighValueOnly');
  if (txHighValueOnly) txHighValueOnly.checked = false;
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
  const reqId = ++txChartReqSeq;
  const days = Number(document.getElementById('txChartDays')?.value || 30);
  try {
    const res = await api.chartStats(days);
    if (reqId !== txChartReqSeq) return;
    renderTxChart((res.data && res.data.daily) || [], 'api');
  } catch (_err) {
    if (reqId !== txChartReqSeq) return;
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
document.getElementById('txHighValueOnly')?.addEventListener('change', () => loadTransactions(0));
document.getElementById('txHighValueMin')?.addEventListener('change', () => {
  if (document.getElementById('txHighValueOnly')?.checked) loadTransactions(0);
});
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
   PAYMENT PROCESSING
══════════════════════════════════════════════ */
function statusBadge(status) {
  return badge('status', status || '—');
}

function riskBadge(level) {
  const safe = level || 'low';
  return badge(`risk-${safe}`, safe);
}

function reviewBadge(state) {
  const safe = state || 'none';
  return badge(`review-${safe}`, safe);
}

function approvalBadge(state) {
  const safe = (state || 'none').toLowerCase();
  return badge(`approval-${safe}`, safe);
}

function priorityBadge(level) {
  const safe = (level || 'normal').toLowerCase();
  return badge(`priority-${safe}`, safe);
}

function fmtMinutesHuman(totalMinutes) {
  if (totalMinutes == null || Number.isNaN(Number(totalMinutes))) return '—';
  const value = Math.abs(Number(totalMinutes));
  const d = Math.floor(value / 1440);
  const h = Math.floor((value % 1440) / 60);
  const m = Math.floor(value % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function parseRiskFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function renderProcBars(containerId, rows, kind = 'status') {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = '<div class="mini-chart-empty">Немає даних</div>';
    return;
  }
  const max = Math.max(...rows.map(r => Number(r.cnt || 0)), 1);
  container.innerHTML = rows.map(row => {
    const label = row.status || row.risk_level || '—';
    const cnt = Number(row.cnt || 0);
    const pct = Math.max(6, (cnt / max) * 100);
    const cls = kind === 'risk'
      ? `risk-${String(label).toLowerCase()}`
      : 'status';
    return `
      <div class="proc-bar-row">
        <div class="proc-bar-label">${escHtml(label)}</div>
        <div class="proc-bar-track"><div class="proc-bar-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="proc-bar-value">${cnt}</div>
      </div>
    `;
  }).join('');
}

async function loadFraudStats() {
  const reqId = ++procRequestSeq.fraud;
  try {
    const res = await api.getFraudStats();
    if (reqId !== procRequestSeq.fraud) return;
    const data = res.data || {};
    const byStatus = data.by_status || [];
    const byLevel = data.by_level || [];
    const byReview = data.by_review_state || [];
    const unresolved = data.unresolved_events || [];
    const recentCritical = data.recent_critical || [];

    const statusMap = Object.fromEntries(byStatus.map(s => [s.status, Number(s.cnt || 0)]));
    const levelMap = Object.fromEntries(byLevel.map(s => [s.risk_level, Number(s.cnt || 0)]));
    const reviewMap = Object.fromEntries(byReview.map(s => [s.review_state, Number(s.cnt || 0)]));
    const unresolvedTotal = unresolved.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
    const ordersTotal = byStatus.reduce((sum, row) => sum + Number(row.cnt || 0), 0);

    document.getElementById('procOrdersTotal').textContent = `${ordersTotal}`;
    document.getElementById('procBlockedTotal').textContent = `${statusMap.blocked || 0}`;
    document.getElementById('procCriticalTotal').textContent = `${levelMap.critical || 0}`;
    document.getElementById('procUnresolvedTotal').textContent = `${unresolvedTotal}`;
    document.getElementById('procCompletedTotal').textContent = `${statusMap.completed || 0}`;
    document.getElementById('procReviewPendingTotal').textContent = `${data.review_pending_total ?? (reviewMap.pending || 0)}`;
    document.getElementById('procAssignedTotal').textContent = `${data.assigned_total ?? 0}`;

    renderProcBars('procStatusBars', byStatus, 'status');
    renderProcBars('procRiskBars', byLevel, 'risk');

    const criticalBody = document.getElementById('procCriticalBody');
    if (!recentCritical.length) {
      criticalBody.innerHTML = '<tr><td colspan="5" class="empty-state">Критичних ордерів немає.</td></tr>';
    } else {
      criticalBody.innerHTML = recentCritical.map(row => `
        <tr>
          <td>#${row.id}</td>
          <td style="color:var(--text-muted);font-size:.8rem">${fmt(row.created_at)}</td>
          <td>${escHtml(row.full_name || '—')}</td>
          <td><code>${escHtml(row.sender || '—')}</code></td>
          <td class="amount-out">${fmtMoney(row.amount)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    if (reqId !== procRequestSeq.fraud) return;
    showToast('Помилка процесингу: ' + err.message, 'error');
  }
}

function renderProcOrdersPagination(total, offset, limit) {
  const bar = document.getElementById('procOrdersPagination');
  if (!bar) return;
  const pages = Math.ceil(total / limit);
  const cur = Math.floor(offset / limit);
  if (pages <= 1) { bar.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${cur === 0 ? 'disabled' : ''} onclick="loadPaymentOrders(${(cur - 1) * limit})">‹</button>`;
  const start = Math.max(0, cur - 2);
  const end = Math.min(pages - 1, cur + 2);
  if (start > 0) {
    html += `<button class="page-btn" onclick="loadPaymentOrders(0)">1</button>`;
    if (start > 1) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === cur ? 'active' : ''}" onclick="loadPaymentOrders(${i * limit})">${i + 1}</button>`;
  }
  if (end < pages - 1) {
    if (end < pages - 2) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
    html += `<button class="page-btn" onclick="loadPaymentOrders(${(pages - 1) * limit})">${pages}</button>`;
  }
  html += `<button class="page-btn" ${cur >= pages - 1 ? 'disabled' : ''} onclick="loadPaymentOrders(${(cur + 1) * limit})">›</button>`;
  bar.innerHTML = html;
}

async function loadPaymentOrders(offset = 0) {
  procOrderOffset = offset;
  const reqId = ++procRequestSeq.orders;
  const params = { limit: PROC_LIMIT, offset };
  const status = document.getElementById('procOrderStatusFilter')?.value || '';
  const risk = document.getElementById('procOrderRiskFilter')?.value || '';
  const reviewState = document.getElementById('procOrderReviewFilter')?.value || '';
  const assignedFilter = document.getElementById('procOrderAssignedFilter')?.value || '';
  const userId = Number(document.getElementById('procOrderUserFilter')?.value || 0);
  const search = document.getElementById('procOrderSearchFilter')?.value.trim() || '';
  if (status) params.status = status;
  if (risk) params.risk_level = risk;
  if (reviewState) params.review_state = reviewState;
  if (assignedFilter === 'me' && currentAdminUser?.id) {
    params.assigned_admin_id = currentAdminUser.id;
  } else if (assignedFilter === 'unassigned') {
    params.assigned_mode = 'unassigned';
  }
  if (userId > 0) params.user_id = userId;
  if (search) params.search = search;

  try {
    const res = await api.listPaymentOrders(params);
    if (reqId !== procRequestSeq.orders) return;
    const rows = res.data || [];
    const total = Number(res.total || 0);
    const body = document.getElementById('procOrdersBody');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="11" class="empty-state">Ордерів не знайдено.</td></tr>';
    } else {
      body.innerHTML = rows.map(row => {
        const flags = parseRiskFlags(row.risk_flags);
        const flagsText = flags.length ? flags.join(', ') : '—';
        const route = `${escHtml(row.sender_number || '—')} → ${escHtml(row.recipient_number || '—')}`;
        const assignee = row.assigned_admin_name
          ? `${escHtml(row.assigned_admin_name)} #${row.assigned_admin_id || ''}`
          : '—';
        return `
          <tr>
            <td>#${row.id}</td>
            <td style="color:var(--text-muted);font-size:.8rem">${fmt(row.created_at)}</td>
            <td>${escHtml(row.initiator_name || '—')} <span style="color:var(--text-muted)">#${row.initiator_user_id || '—'}</span></td>
            <td><code>${route}</code></td>
            <td class="${row.status === 'completed' ? 'amount-in' : 'amount-out'}">${fmtMoney(row.amount)}</td>
            <td>${statusBadge(row.status)}</td>
            <td>${riskBadge(row.risk_level)}</td>
            <td>${reviewBadge(row.review_state)}</td>
            <td class="proc-flags" title="${escHtml(assignee)}">${assignee}</td>
            <td class="proc-flags" title="${escHtml(flagsText + (row.failure_reason ? ' | fail: ' + row.failure_reason : ''))}">
              ${escHtml(flagsText)}
            </td>
            <td>
              <div class="tx-row-actions">
                <button class="tx-mini-btn" onclick="openPaymentOrderCase(${row.id})">Case</button>
                <button class="tx-mini-btn" onclick="assignPaymentOrderToMe(${row.id})">Take</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
    renderProcOrdersPagination(total, offset, PROC_LIMIT);
  } catch (err) {
    if (reqId !== procRequestSeq.orders) return;
    showToast('Помилка ордерів: ' + err.message, 'error');
  }
}
window.loadPaymentOrders = loadPaymentOrders;

function setSlaSummary(summary = {}) {
  document.getElementById('procSlaTotal').textContent = `${summary.total ?? 0}`;
  document.getElementById('procSlaOverdue').textContent = `${summary.overdue_total ?? 0}`;
  document.getElementById('procSlaDueSoon').textContent = `${summary.due_soon_total ?? 0}`;
  document.getElementById('procSlaUnassigned').textContent = `${summary.unassigned_total ?? 0}`;
  document.getElementById('procSlaEscalated').textContent = `${summary.escalated_total ?? 0}`;
  document.getElementById('procSlaAwaitingApproval').textContent = `${summary.awaiting_approval_total ?? 0}`;
  document.getElementById('procSlaAvgAge').textContent = fmtMinutesHuman(summary.avg_age_minutes ?? 0);
}

function normalizeSlaOrderRow(raw = {}) {
  const row = { ...raw };
  const nowMs = Date.now();
  const createdMs = new Date(row.created_at || row.updated_at || nowMs).getTime();
  const validCreatedMs = Number.isNaN(createdMs) ? nowMs : createdMs;
  const risk = String(row.risk_level || 'low').toLowerCase();
  const slaMinutesDefault = SLA_MINUTES_BY_RISK[risk] || SLA_MINUTES_BY_RISK.low;
  const ageMinutes = row.sla_age_minutes != null
    ? Number(row.sla_age_minutes)
    : Math.max(0, Math.floor((nowMs - validCreatedMs) / 60000));
  const remainingMinutes = row.sla_remaining_minutes != null
    ? Number(row.sla_remaining_minutes)
    : (Number(row.sla_minutes || slaMinutesDefault) - ageMinutes);
  const overdue = row.sla_overdue != null
    ? Boolean(row.sla_overdue)
    : remainingMinutes < 0;
  const dueSoon = row.sla_due_soon != null
    ? Boolean(row.sla_due_soon)
    : (!overdue && remainingMinutes <= 30);

  let priority = String(row.sla_priority || '').toLowerCase();
  if (!priority) {
    if (overdue && (risk === 'critical' || risk === 'high')) priority = 'critical';
    else if (overdue) priority = 'high';
    else if (risk === 'critical') priority = 'high';
    else if (dueSoon) priority = 'medium';
    else priority = 'normal';
  }

  row.sla_minutes = Number(row.sla_minutes || slaMinutesDefault);
  row.sla_age_minutes = Number.isFinite(ageMinutes) ? ageMinutes : 0;
  row.sla_remaining_minutes = Number.isFinite(remainingMinutes) ? remainingMinutes : null;
  row.sla_overdue = overdue;
  row.sla_due_soon = dueSoon;
  row.sla_priority = priority;
  return row;
}

function compareSlaRows(a, b) {
  const aa = normalizeSlaOrderRow(a);
  const bb = normalizeSlaOrderRow(b);
  const aOverdue = Boolean(aa.sla_overdue);
  const bOverdue = Boolean(bb.sla_overdue);
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

  const aPriority = SLA_PRIORITY_WEIGHT[String(aa.sla_priority || 'normal').toLowerCase()] || 1;
  const bPriority = SLA_PRIORITY_WEIGHT[String(bb.sla_priority || 'normal').toLowerCase()] || 1;
  if (aPriority !== bPriority) return bPriority - aPriority;

  const aRisk = SLA_RISK_WEIGHT[String(aa.risk_level || 'low').toLowerCase()] || 1;
  const bRisk = SLA_RISK_WEIGHT[String(bb.risk_level || 'low').toLowerCase()] || 1;
  if (aRisk !== bRisk) return bRisk - aRisk;

  const aAge = Number(aa.sla_age_minutes || 0);
  const bAge = Number(bb.sla_age_minutes || 0);
  if (aAge !== bAge) return bAge - aAge;

  const aAmount = Number(aa.amount || 0);
  const bAmount = Number(bb.amount || 0);
  if (aAmount !== bAmount) return bAmount - aAmount;

  return Number(bb.id || 0) - Number(aa.id || 0);
}

function buildSlaSummary(rows = []) {
  const normalized = rows.map(normalizeSlaOrderRow);
  const total = normalized.length;
  const overdueTotal = normalized.filter(row => row.sla_overdue).length;
  const dueSoonTotal = normalized.filter(row => row.sla_due_soon).length;
  const unassignedTotal = normalized.filter(row => !row.assigned_admin_id).length;
  const escalatedTotal = normalized.filter(row => String(row.review_state || '').toLowerCase() === 'escalated').length;
  const awaitingApprovalTotal = normalized.filter(row => String(row.approval_state || '').toLowerCase() === 'requested').length;
  const avgAgeMinutes = Math.round(
    normalized.reduce((sum, row) => sum + Number(row.sla_age_minutes || 0), 0) / Math.max(1, total)
  );
  const byPriority = { critical: 0, high: 0, medium: 0, normal: 0 };
  normalized.forEach(row => {
    const key = String(row.sla_priority || 'normal').toLowerCase();
    byPriority[key] = (byPriority[key] || 0) + 1;
  });
  return {
    total,
    overdue_total: overdueTotal,
    due_soon_total: dueSoonTotal,
    unassigned_total: unassignedTotal,
    escalated_total: escalatedTotal,
    awaiting_approval_total: awaitingApprovalTotal,
    avg_age_minutes: avgAgeMinutes,
    by_priority: byPriority,
  };
}

function renderSlaQueueRows(rows, total, offset) {
  const body = document.getElementById('procSlaBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="12" class="empty-state">SLA ордерів не знайдено.</td></tr>';
    clearSlaSelection();
    renderProcSlaPagination(total, offset, PROC_SLA_LIMIT);
    return;
  }

  const normalizedRows = rows.map(normalizeSlaOrderRow);
  body.innerHTML = normalizedRows.map(row => {
    const assignee = row.assigned_admin_name
      ? `${escHtml(row.assigned_admin_name)} #${row.assigned_admin_id || ''}`
      : '—';
    const review = row.review_state || 'none';
    const approval = row.approval_state || 'none';
    const checked = procSlaSelectedIds.has(Number(row.id)) ? 'checked' : '';
    return `
      <tr>
        <td><input type="checkbox" class="proc-sla-check" data-order-id="${row.id}" ${checked} onchange="toggleSlaOrderSelection(${row.id}, this.checked)" /></td>
        <td>${priorityBadge(row.sla_priority || 'normal')}</td>
        <td>#${row.id}</td>
        <td>${escHtml(row.initiator_name || '—')} <span style="color:var(--text-muted)">#${row.initiator_user_id || '—'}</span></td>
        <td class="${row.status === 'completed' ? 'amount-in' : 'amount-out'}">${fmtMoney(row.amount)}</td>
        <td>${riskBadge(row.risk_level)}</td>
        <td>${fmtMinutesHuman(row.sla_age_minutes)}</td>
        <td>${renderSlaDue(row.sla_remaining_minutes)}</td>
        <td class="proc-flags" title="${escHtml(assignee)}">${assignee}</td>
        <td>${reviewBadge(review)}</td>
        <td>${approvalBadge(approval)}</td>
        <td>
          <div class="tx-row-actions">
            <button class="tx-mini-btn" onclick="openPaymentOrderCase(${row.id})">Case</button>
            <button class="tx-mini-btn" onclick="assignPaymentOrderToMe(${row.id})">Take</button>
            <button class="tx-mini-btn" onclick="escalateQueueOrder(${row.id})" ${review === 'escalated' ? 'disabled' : ''}>Escalate</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  const pageIds = normalizedRows.map(row => Number(row.id)).filter(Boolean);
  const allSelectedOnPage = pageIds.length > 0 && pageIds.every(id => procSlaSelectedIds.has(id));
  const selectAll = document.getElementById('procSlaSelectAll');
  const selectAllHead = document.getElementById('procSlaSelectAllHead');
  if (selectAll) selectAll.checked = allSelectedOnPage;
  if (selectAllHead) selectAllHead.checked = allSelectedOnPage;
  updateSlaSelectedCount();
  renderProcSlaPagination(total, offset, PROC_SLA_LIMIT);
}

function updateSlaSelectedCount() {
  const badgeEl = document.getElementById('procSlaSelectedCount');
  if (badgeEl) badgeEl.textContent = `${procSlaSelectedIds.size} selected`;
}

function clearSlaSelection() {
  procSlaSelectedIds = new Set();
  const selectAll = document.getElementById('procSlaSelectAll');
  const selectAllHead = document.getElementById('procSlaSelectAllHead');
  if (selectAll) selectAll.checked = false;
  if (selectAllHead) selectAllHead.checked = false;
  document.querySelectorAll('.proc-sla-check').forEach(cb => { cb.checked = false; });
  updateSlaSelectedCount();
}

function toggleSlaOrderSelection(orderId, checked) {
  const id = Number(orderId);
  if (!id) return;
  if (checked) procSlaSelectedIds.add(id);
  else procSlaSelectedIds.delete(id);
  const pageChecks = Array.from(document.querySelectorAll('.proc-sla-check'));
  const allChecked = pageChecks.length > 0 && pageChecks.every(cb => cb.checked);
  const selectAll = document.getElementById('procSlaSelectAll');
  const selectAllHead = document.getElementById('procSlaSelectAllHead');
  if (selectAll) selectAll.checked = allChecked;
  if (selectAllHead) selectAllHead.checked = allChecked;
  updateSlaSelectedCount();
}
window.toggleSlaOrderSelection = toggleSlaOrderSelection;

function toggleSlaPageSelection(checked) {
  document.querySelectorAll('.proc-sla-check').forEach(cb => {
    cb.checked = checked;
    const id = Number(cb.dataset.orderId || 0);
    if (!id) return;
    if (checked) procSlaSelectedIds.add(id);
    else procSlaSelectedIds.delete(id);
  });
  const selectAll = document.getElementById('procSlaSelectAll');
  const selectAllHead = document.getElementById('procSlaSelectAllHead');
  if (selectAll) selectAll.checked = checked;
  if (selectAllHead) selectAllHead.checked = checked;
  updateSlaSelectedCount();
}

function renderProcSlaPagination(total, offset, limit) {
  const bar = document.getElementById('procSlaPagination');
  if (!bar) return;
  const pages = Math.ceil(total / limit);
  const cur = Math.floor(offset / limit);
  if (pages <= 1) { bar.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${cur === 0 ? 'disabled' : ''} onclick="loadPaymentSlaQueue(${(cur - 1) * limit})">‹</button>`;
  const start = Math.max(0, cur - 2);
  const end = Math.min(pages - 1, cur + 2);
  if (start > 0) {
    html += `<button class="page-btn" onclick="loadPaymentSlaQueue(0)">1</button>`;
    if (start > 1) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === cur ? 'active' : ''}" onclick="loadPaymentSlaQueue(${i * limit})">${i + 1}</button>`;
  }
  if (end < pages - 1) {
    if (end < pages - 2) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
    html += `<button class="page-btn" onclick="loadPaymentSlaQueue(${(pages - 1) * limit})">${pages}</button>`;
  }
  html += `<button class="page-btn" ${cur >= pages - 1 ? 'disabled' : ''} onclick="loadPaymentSlaQueue(${(cur + 1) * limit})">›</button>`;
  bar.innerHTML = html;
}

function renderSlaDue(remainingMinutes) {
  if (remainingMinutes == null || Number.isNaN(Number(remainingMinutes))) return '—';
  const rem = Number(remainingMinutes);
  if (rem < 0) {
    return `<span class="sla-due-overdue">${fmtMinutesHuman(rem)} overdue</span>`;
  }
  return `<span class="sla-due-ok">${fmtMinutesHuman(rem)}</span>`;
}

function canFinalizeApprovalFromInbox(row) {
  if (!isAdminRole()) return false;
  const requestedBy = Number(row?.approval_requested_by || 0);
  return requestedBy <= 0 || requestedBy !== Number(currentAdminUser?.id || 0);
}

function renderApprovalInboxActions(row) {
  const orderId = Number(row?.id || 0);
  if (!orderId) return '—';
  if (!isAdminRole()) {
    return `
      <div class="tx-row-actions">
        <button class="tx-mini-btn" onclick="openPaymentOrderCase(${orderId})">Case</button>
      </div>
    `;
  }
  if (!canFinalizeApprovalFromInbox(row)) {
    return `<span class="badge badge-review-pending">maker-lock</span>`;
  }
  return `
    <div class="tx-row-actions">
      <button class="tx-mini-btn" onclick="quickFinalizeApprovalFromInbox(${orderId}, true)">Approve</button>
      <button class="tx-mini-btn" onclick="quickFinalizeApprovalFromInbox(${orderId}, false)">Deny</button>
      <button class="tx-mini-btn" onclick="openPaymentOrderCase(${orderId})">Case</button>
    </div>
  `;
}

function renderProcApprovalPagination(total, offset, limit) {
  const bar = document.getElementById('procApprovalPagination');
  if (!bar) return;
  const pages = Math.ceil(total / limit);
  const cur = Math.floor(offset / limit);
  if (pages <= 1) { bar.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${cur === 0 ? 'disabled' : ''} onclick="loadApprovalInbox(${(cur - 1) * limit})">‹</button>`;
  const start = Math.max(0, cur - 2);
  const end = Math.min(pages - 1, cur + 2);
  if (start > 0) {
    html += `<button class="page-btn" onclick="loadApprovalInbox(0)">1</button>`;
    if (start > 1) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === cur ? 'active' : ''}" onclick="loadApprovalInbox(${i * limit})">${i + 1}</button>`;
  }
  if (end < pages - 1) {
    if (end < pages - 2) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
    html += `<button class="page-btn" onclick="loadApprovalInbox(${(pages - 1) * limit})">${pages}</button>`;
  }
  html += `<button class="page-btn" ${cur >= pages - 1 ? 'disabled' : ''} onclick="loadApprovalInbox(${(cur + 1) * limit})">›</button>`;
  bar.innerHTML = html;
}

async function loadApprovalInbox(offset = 0) {
  procInboxOffset = offset;
  const body = document.getElementById('procApprovalInboxBody');
  if (!body) return;
  const reqId = ++procRequestSeq.inbox;

  const params = {
    limit: PROC_INBOX_LIMIT,
    offset,
    open_only: 'true',
  };
  const action = document.getElementById('procInboxActionFilter')?.value || '';
  const priority = document.getElementById('procInboxPriorityFilter')?.value || '';
  const overdue = document.getElementById('procInboxOverdueFilter')?.value || '';
  const search = document.getElementById('procInboxSearchFilter')?.value.trim() || '';
  if (action) params.approval_action = action;
  if (priority) params.priority = priority;
  if (overdue) params.overdue = overdue;
  if (search) params.search = search;
  if (isOperatorRole() && currentAdminUser?.id) {
    params.assigned_admin_id = currentAdminUser.id;
  }

  try {
    const res = await api.getPaymentApprovalInbox(params);
    if (reqId !== procRequestSeq.inbox) return;
    const rows = res.data || [];
    const total = Number(res.total || 0);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty-state">Немає ордерів, що очікують погодження.</td></tr>';
      renderProcApprovalPagination(total, offset, PROC_INBOX_LIMIT);
      return;
    }

    body.innerHTML = rows.map(row => {
      const requestedBy = row.approval_requested_by_name
        ? `${escHtml(row.approval_requested_by_name)} #${row.approval_requested_by || ''}`
        : '—';
      return `
        <tr>
          <td>#${row.id}</td>
          <td style="color:var(--text-muted);font-size:.8rem">${fmt(row.created_at)}</td>
          <td>${escHtml(row.initiator_name || '—')} <span style="color:var(--text-muted)">#${row.initiator_user_id || '—'}</span></td>
          <td class="${row.status === 'completed' ? 'amount-in' : 'amount-out'}">${fmtMoney(row.amount)}</td>
          <td>${riskBadge(row.risk_level)}</td>
          <td><span class="badge badge-review-pending">${escHtml(row.approval_requested_action || '—')}</span></td>
          <td class="proc-flags" title="${escHtml(requestedBy)}">${requestedBy}</td>
          <td>${renderSlaDue(row.sla_remaining_minutes)}</td>
          <td>${renderApprovalInboxActions(row)}</td>
        </tr>
      `;
    }).join('');
    renderProcApprovalPagination(total, offset, PROC_INBOX_LIMIT);
  } catch (err) {
    if (reqId !== procRequestSeq.inbox) return;
    body.innerHTML = `<tr><td colspan="9" class="empty-state">Помилка завантаження inbox: ${escHtml(err.message || 'unknown')}</td></tr>`;
    renderProcApprovalPagination(0, 0, PROC_INBOX_LIMIT);
  }
}
window.loadApprovalInbox = loadApprovalInbox;

async function quickFinalizeApprovalFromInbox(orderId, approve = true) {
  if (!isAdminRole()) {
    showToast('Finalize approval доступний лише адміністратору.', 'error');
    return;
  }
  const note = approve
    ? 'Approval finalized from inbox.'
    : 'Approval denied from inbox (quick action).';
  try {
    await api.finalizePaymentOrderApproval(orderId, { approve: Boolean(approve), note });
    showToast(
      approve ? `Ордер #${orderId}: approval підтверджено.` : `Ордер #${orderId}: approval відхилено.`,
      'success'
    );
    await refreshProcessingViews({
      inbox: true,
      orders: true,
      sla: true,
      fraud: true,
      workload: true,
      caseModal: procModalOrderId === Number(orderId),
    });
  } catch (err) {
    showToast('Помилка approval inbox: ' + err.message, 'error');
  }
}
window.quickFinalizeApprovalFromInbox = quickFinalizeApprovalFromInbox;

async function loadPaymentSlaQueue(offset = 0) {
  procSlaOffset = offset;
  const reqId = ++procRequestSeq.sla;
  const params = { limit: PROC_SLA_LIMIT, offset, open_only: 'true' };
  const overdue = document.getElementById('procSlaOverdueFilter')?.value || '';
  const assigned = document.getElementById('procSlaAssignedFilter')?.value || '';
  const risk = document.getElementById('procSlaRiskFilter')?.value || '';
  const priority = document.getElementById('procSlaPriorityFilter')?.value || '';
  const approval = document.getElementById('procSlaApprovalFilter')?.value || '';
  const search = document.getElementById('procSlaSearchFilter')?.value.trim() || '';
  if (overdue) params.overdue = overdue;
  if (risk) params.risk_level = risk;
  if (priority) params.priority = priority;
  if (approval) params.approval_state = approval;
  if (search) params.search = search;
  if (assigned === 'me' && currentAdminUser?.id) {
    params.assigned_admin_id = currentAdminUser.id;
  } else if (assigned === 'unassigned') {
    params.assigned_mode = 'unassigned';
  }

  try {
    const res = await api.getPaymentSlaQueue(params);
    if (reqId !== procRequestSeq.sla) return;
    const rows = res.data || [];
    const total = Number(res.total || 0);
    setSlaSummary(res.summary || buildSlaSummary(rows));
    renderSlaQueueRows(rows, total, offset);
  } catch (err) {
    if (reqId !== procRequestSeq.sla) return;
    const fallbackOk = await loadPaymentSlaQueueFallback(offset, params);
    if (fallbackOk) {
      showToast(`SLA queue API недоступний, показано fallback: ${err.message}`, 'error');
      return;
    }
    showToast('Помилка SLA queue: ' + err.message, 'error');
  }
}
window.loadPaymentSlaQueue = loadPaymentSlaQueue;

async function loadPaymentSlaQueueFallback(offset = 0, baseFilters = {}) {
  try {
    const fallbackParams = {
      limit: 800,
      offset: 0,
      open_only: 'true',
    };
    if (baseFilters.status) fallbackParams.status = baseFilters.status;
    if (baseFilters.risk_level) fallbackParams.risk_level = baseFilters.risk_level;
    if (baseFilters.review_state) fallbackParams.review_state = baseFilters.review_state;
    if (baseFilters.approval_state) fallbackParams.approval_state = baseFilters.approval_state;
    if (baseFilters.user_id) fallbackParams.user_id = baseFilters.user_id;
    if (baseFilters.assigned_admin_id) fallbackParams.assigned_admin_id = baseFilters.assigned_admin_id;
    if (baseFilters.assigned_mode) fallbackParams.assigned_mode = baseFilters.assigned_mode;
    if (baseFilters.search) fallbackParams.search = baseFilters.search;

    const res = await api.listPaymentOrders(fallbackParams);
    let rows = Array.isArray(res?.data) ? res.data.map(normalizeSlaOrderRow) : [];
    if (baseFilters.overdue === 'true') rows = rows.filter(row => Boolean(row.sla_overdue));
    if (baseFilters.overdue === 'false') rows = rows.filter(row => !Boolean(row.sla_overdue));
    if (baseFilters.priority) {
      const pr = String(baseFilters.priority || '').toLowerCase();
      rows = rows.filter(row => String(row.sla_priority || '').toLowerCase() === pr);
    }
    rows.sort(compareSlaRows);
    const total = rows.length;
    const page = rows.slice(offset, offset + PROC_SLA_LIMIT);
    setSlaSummary(buildSlaSummary(rows));
    renderSlaQueueRows(page, total, offset);
    return true;
  } catch (_err) {
    return false;
  }
}

async function escalateQueueOrder(orderId) {
  try {
    await api.decidePaymentOrder(orderId, {
      decision: 'escalate',
      note: 'Manual SLA escalation from processing queue.',
    });
    showToast(`Ордер #${orderId} ескальовано.`, 'success');
    await refreshProcessingViews({
      orders: true,
      sla: true,
      fraud: true,
      workload: true,
      inbox: true,
      caseModal: procModalOrderId === Number(orderId),
    });
  } catch (err) {
    showToast('Помилка ескалації: ' + err.message, 'error');
  }
}
window.escalateQueueOrder = escalateQueueOrder;

async function runSlaAutoEscalate() {
  if (!isAdminRole()) {
    showToast('Auto-escalate доступний лише адміністратору.', 'error');
    return;
  }
  const btn = document.getElementById('procSlaAutoEscalateBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api.runPaymentSlaAutoEscalate({ dry_run: false, scan_limit: 1200 });
    const count = Number(res?.data?.escalated_count || 0);
    showToast(`Auto-escalate завершено: ${count} ордер(ів).`, 'success');
    await refreshProcessingViews({
      orders: true,
      sla: true,
      fraud: true,
      workload: true,
      inbox: true,
    });
  } catch (err) {
    showToast('Помилка auto-escalate: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderPriorityMix(byPriority = {}) {
  const c = Number(byPriority.critical || 0);
  const h = Number(byPriority.high || 0);
  const m = Number(byPriority.medium || 0);
  const n = Number(byPriority.normal || 0);
  return `<span class="priority-mix">C:${c} H:${h} M:${m} N:${n}</span>`;
}

async function loadProcessingWorkload() {
  const reqId = ++procRequestSeq.workload;
  try {
    const res = await api.getPaymentWorkload({ open_only: 'true' });
    if (reqId !== procRequestSeq.workload) return;
    const rows = res.data || [];
    const summary = res.summary || {};
    document.getElementById('procWorkOpenTotal').textContent = `${summary.open_total ?? 0}`;
    document.getElementById('procWorkAssigneesTotal').textContent = `${summary.assignees_total ?? 0}`;
    document.getElementById('procWorkUnassignedTotal').textContent = `${summary.unassigned_total ?? 0}`;
    document.getElementById('procWorkOverdueTotal').textContent = `${summary.overdue_total ?? 0}`;
    document.getElementById('procWorkCriticalTotal').textContent = `${summary.critical_total ?? 0}`;
    document.getElementById('procWorkAwaitingApprovalTotal').textContent = `${summary.awaiting_approval_total ?? 0}`;

    const body = document.getElementById('procWorkloadBody');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty-state">Даних по workload немає.</td></tr>';
    } else {
      body.innerHTML = rows.map(row => `
        <tr>
          <td>${escHtml(row.admin_name || 'Unassigned')} ${row.admin_user_id ? `<span style="color:var(--text-muted)">#${row.admin_user_id}</span>` : ''}</td>
          <td>${row.total || 0}</td>
          <td class="amount-out">${row.overdue || 0}</td>
          <td>${row.critical || 0}</td>
          <td>${row.escalated || 0}</td>
          <td>${row.awaiting_approval || 0}</td>
          <td>${fmtMinutesHuman(row.avg_age_minutes || 0)}</td>
          <td>${renderPriorityMix(row.by_priority || {})}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    if (reqId !== procRequestSeq.workload) return;
    showToast('Помилка workload: ' + err.message, 'error');
  }
}

async function runSlaBulkAction() {
  const action = document.getElementById('procSlaBulkAction')?.value || '';
  const assigneeRaw = Number(document.getElementById('procSlaBulkAssignee')?.value || 0);
  const note = (document.getElementById('procSlaBulkNote')?.value || '').trim();
  const onlyOverdue = Boolean(document.getElementById('procSlaBulkOnlyOverdue')?.checked);
  const ids = Array.from(procSlaSelectedIds);

  if (!action) {
    showToast('Оберіть bulk action.', 'error');
    return;
  }
  if (!isAdminRole() && !OPERATOR_BULK_ACTIONS.has(action)) {
    showToast('Для operator доступні bulk-дії: assign, escalate, note.', 'error');
    return;
  }
  if (!ids.length) {
    showToast('Немає вибраних ордерів.', 'error');
    return;
  }

  const payload = { ids, action, only_overdue: onlyOverdue };
  if (action === 'assign') {
    payload.admin_user_id = isAdminRole()
      ? (assigneeRaw > 0 ? assigneeRaw : (currentAdminUser?.id || 0))
      : (currentAdminUser?.id || 0);
  }
  if (note) payload.note = note;

  const btn = document.getElementById('procSlaBulkRunBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api.runPaymentSlaBulkAction(payload);
    const done = Number(res?.data?.success_count || 0);
    const failed = Number(res?.data?.failed_count || 0);
    showToast(`Bulk ${action}: success ${done}, failed ${failed}.`, failed ? 'error' : 'success');
    clearSlaSelection();
    await refreshProcessingViews({
      orders: true,
      sla: true,
      fraud: true,
      workload: true,
      inbox: true,
      caseModal: Boolean(procModalOrderId),
    });
  } catch (err) {
    showToast('Помилка bulk action: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setProcModalMessage(msg, type = 'success') {
  const el = document.getElementById('procModalMsg');
  if (!el) return;
  el.textContent = msg;
  el.className = `form-msg ${type}`;
}

function clearProcModalMessage() {
  const el = document.getElementById('procModalMsg');
  if (!el) return;
  el.className = 'form-msg hidden';
  el.textContent = '';
}

function formatEventType(eventType) {
  const map = {
    created: 'Створено',
    status_changed: 'Зміна статусу',
    assigned: 'Призначено',
    note: 'Нотатка',
    decision_approved: 'Рішення: approve',
    decision_rejected: 'Рішення: reject',
    decision_escalated: 'Рішення: escalate',
    decision_cleared: 'Скидання рішення',
  };
  return map[eventType] || eventType || 'event';
}

function renderProcTimeline(items = []) {
  const wrap = document.getElementById('procModalTimeline');
  if (!wrap) return;
  if (!items.length) {
    wrap.innerHTML = '<div class="mini-chart-empty">Подій ще немає.</div>';
    return;
  }
  wrap.innerHTML = items.map(item => `
    <div class="proc-timeline-item">
      <div class="proc-timeline-head">
        <div class="proc-timeline-type">${escHtml(formatEventType(item.event_type))}</div>
        <div class="proc-timeline-meta">${fmt(item.created_at)}</div>
      </div>
      <div class="proc-timeline-meta">${escHtml(item.actor_name || 'System')} ${item.actor_user_id ? `#${item.actor_user_id}` : ''}</div>
      <div class="proc-timeline-details">${escHtml(item.details || '—')}</div>
    </div>
  `).join('');
}

function renderPaymentOrderCase(order, timeline = []) {
  document.getElementById('procModalTitle').textContent = `Платіжний ордер #${order.id}`;
  document.getElementById('procModalBadges').innerHTML = `${statusBadge(order.status)} ${riskBadge(order.risk_level)} ${reviewBadge(order.review_state)} ${approvalBadge(order.approval_state)}`;
  document.getElementById('procModalId').textContent = `#${order.id}`;
  document.getElementById('procModalUser').textContent = `${order.initiator_name || '—'}${order.initiator_user_id ? ` #${order.initiator_user_id}` : ''}`;
  document.getElementById('procModalRoute').textContent = `${order.sender_number || '—'} -> ${order.recipient_number || '—'}`;
  document.getElementById('procModalAmount').textContent = fmtMoney(order.amount);
  document.getElementById('procModalStatus').innerHTML = statusBadge(order.status);
  document.getElementById('procModalRisk').innerHTML = riskBadge(order.risk_level);
  document.getElementById('procModalReview').innerHTML = reviewBadge(order.review_state);
  document.getElementById('procModalApprovalState').innerHTML = approvalBadge(order.approval_state);
  document.getElementById('procModalApprovalRequestedBy').textContent = order.approval_requested_by_name
    ? `${order.approval_requested_by_name} #${order.approval_requested_by || ''}`
    : '—';
  document.getElementById('procModalApprovalDecidedBy').textContent = order.approval_decided_by_name
    ? `${order.approval_decided_by_name} #${order.approval_decided_by || ''}`
    : '—';
  document.getElementById('procModalAssignee').textContent = order.assigned_admin_name
    ? `${order.assigned_admin_name} #${order.assigned_admin_id}`
    : '—';
  document.getElementById('procModalDecisionNote').textContent = order.decision_note || '—';
  const assignInput = document.getElementById('procModalAssignUserId');
  if (assignInput) {
    assignInput.value = order.assigned_admin_id || currentAdminUser?.id || '';
    assignInput.disabled = isOperatorRole();
    if (isOperatorRole()) assignInput.value = currentAdminUser?.id || '';
  }
  const denyBtn = document.getElementById('procModalApprovalDenyBtn');
  if (denyBtn) {
    const makerLock = Number(order.approval_requested_by || 0) === Number(currentAdminUser?.id || 0);
    const denyDisabled = String(order.approval_state || '').toLowerCase() !== 'requested' || !isAdminRole() || makerLock;
    denyBtn.disabled = denyDisabled;
  }
  const approveBtn = document.getElementById('procModalApproveBtn');
  const rejectBtn = document.getElementById('procModalRejectBtn');
  const clearBtn = document.getElementById('procModalClearBtn');
  const escalateBtn = document.getElementById('procModalEscalateBtn');
  const assignBtn = document.getElementById('procModalAssignBtn');
  if (approveBtn) approveBtn.disabled = isOperatorRole();
  if (rejectBtn) rejectBtn.disabled = isOperatorRole();
  if (clearBtn) clearBtn.disabled = isOperatorRole();
  if (assignBtn) assignBtn.disabled = false;
  if (escalateBtn) {
    const alreadyEscalated = String(order.review_state || '').toLowerCase() === 'escalated';
    escalateBtn.disabled = alreadyEscalated;
  }
  renderProcTimeline(timeline);
}

async function refreshPaymentOrderCase() {
  if (!procModalOrderId) return;
  const [orderRes, timelineRes] = await Promise.all([
    api.getPaymentOrder(procModalOrderId),
    api.getPaymentOrderTimeline(procModalOrderId, 250),
  ]);
  renderPaymentOrderCase(orderRes.data || {}, timelineRes.data || []);
}

async function openPaymentOrderCase(orderId) {
  procModalOrderId = Number(orderId);
  document.getElementById('procOrderModal').classList.remove('hidden');
  clearProcModalMessage();
  document.getElementById('procModalTimeline').innerHTML = '<div class="mini-chart-empty">Завантаження…</div>';
  try {
    await refreshPaymentOrderCase();
  } catch (err) {
    showToast('Помилка кейсу: ' + err.message, 'error');
  }
}
window.openPaymentOrderCase = openPaymentOrderCase;

function closePaymentOrderCase() {
  document.getElementById('procOrderModal').classList.add('hidden');
  procModalOrderId = null;
}

async function assignPaymentOrderToMe(orderId) {
  if (!currentAdminUser?.id) {
    showToast('Немає активного admin-користувача.', 'error');
    return;
  }
  try {
    await api.assignPaymentOrder(orderId, { admin_user_id: currentAdminUser.id });
    showToast(`Ордер #${orderId} призначено на вас.`, 'success');
    await refreshProcessingViews({
      orders: true,
      sla: true,
      workload: true,
      inbox: true,
      caseModal: procModalOrderId === Number(orderId),
    });
  } catch (err) {
    showToast('Помилка assign: ' + err.message, 'error');
  }
}
window.assignPaymentOrderToMe = assignPaymentOrderToMe;

async function assignOpenPaymentOrder() {
  if (!procModalOrderId) return;
  const assigneeRaw = Number(document.getElementById('procModalAssignUserId').value || 0);
  const note = (document.getElementById('procModalDecisionInput').value || '').trim();
  const assignee = isOperatorRole()
    ? Number(currentAdminUser?.id || 0)
    : (assigneeRaw > 0 ? assigneeRaw : (currentAdminUser?.id || 0));
  if (assignee <= 0) {
    setProcModalMessage('Вкажіть коректний Admin User ID.', 'error');
    return;
  }
  try {
    await api.assignPaymentOrder(procModalOrderId, { admin_user_id: assignee, note });
    setProcModalMessage('Ордер призначено.', 'success');
    await refreshProcessingViews({
      orders: true,
      sla: true,
      workload: true,
      inbox: true,
      caseModal: true,
    });
  } catch (err) {
    setProcModalMessage(err.message, 'error');
  }
}

async function decideOpenPaymentOrder(decision) {
  if (!procModalOrderId) return;
  if (isOperatorRole() && decision !== 'escalate') {
    setProcModalMessage('Для operator доступне лише рішення escalate.', 'error');
    return;
  }
  const note = (document.getElementById('procModalDecisionInput').value || '').trim();
  try {
    const res = await api.decidePaymentOrder(procModalOrderId, { decision, note });
    const mode = res?.meta?.mode || 'direct';
    if (mode === 'approval_requested') {
      setProcModalMessage(`Approval request (${decision}) створено. Потрібен другий адміністратор.`, 'success');
    } else if (mode === 'approval_finalized') {
      setProcModalMessage(`Approval finalized: ${decision}.`, 'success');
    } else {
      setProcModalMessage(`Рішення ${decision} застосовано.`, 'success');
    }
    await refreshProcessingViews({
      orders: true,
      sla: true,
      fraud: true,
      workload: true,
      inbox: true,
      caseModal: true,
    });
  } catch (err) {
    setProcModalMessage(err.message, 'error');
  }
}

async function finalizeOpenPaymentOrderApproval(approve = false) {
  if (!procModalOrderId) return;
  if (!isAdminRole()) {
    setProcModalMessage('Finalize approval доступний лише адміністратору.', 'error');
    return;
  }
  const note = (document.getElementById('procModalDecisionInput').value || '').trim();
  try {
    await api.finalizePaymentOrderApproval(procModalOrderId, { approve: Boolean(approve), note });
    setProcModalMessage(
      approve ? 'Approval request підтверджено.' : 'Approval request відхилено.',
      'success'
    );
    await refreshProcessingViews({
      orders: true,
      sla: true,
      fraud: true,
      workload: true,
      inbox: true,
      caseModal: true,
    });
  } catch (err) {
    setProcModalMessage(err.message, 'error');
  }
}

async function addOpenPaymentOrderNote() {
  if (!procModalOrderId) return;
  const input = document.getElementById('procModalAddNoteInput');
  const note = (input.value || '').trim();
  if (!note) {
    setProcModalMessage('Введіть текст нотатки.', 'error');
    return;
  }
  try {
    await api.addPaymentOrderNote(procModalOrderId, note);
    input.value = '';
    setProcModalMessage('Нотатку додано.', 'success');
    await refreshProcessingViews({ caseModal: true });
  } catch (err) {
    setProcModalMessage(err.message, 'error');
  }
}

function renderRiskPagination(offset, limit) {
  const bar = document.getElementById('procRiskPagination');
  if (!bar) return;
  const prevDisabled = offset <= 0 ? 'disabled' : '';
  const nextDisabled = procLastRiskCount < limit ? 'disabled' : '';
  bar.innerHTML = `
    <button class="page-btn" ${prevDisabled} onclick="loadPaymentRiskEvents(${Math.max(0, offset - limit)})">‹</button>
    <span style="color:var(--text-muted);font-size:.82rem">offset: ${offset}</span>
    <button class="page-btn" ${nextDisabled} onclick="loadPaymentRiskEvents(${offset + limit})">›</button>
  `;
}

async function loadPaymentRiskEvents(offset = 0) {
  procRiskOffset = offset;
  const reqId = ++procRequestSeq.risk;
  const params = { limit: PROC_LIMIT, offset };
  const severity = document.getElementById('procRiskSeverityFilter')?.value || '';
  const resolved = document.getElementById('procRiskResolvedFilter')?.value || '';
  const userId = Number(document.getElementById('procRiskUserFilter')?.value || 0);
  if (severity) params.severity = severity;
  if (resolved) params.resolved = resolved;
  if (userId > 0) params.user_id = userId;

  try {
    const res = await api.listPaymentRiskEvents(params);
    if (reqId !== procRequestSeq.risk) return;
    const rows = res.data || [];
    procLastRiskCount = rows.length;
    const body = document.getElementById('procRiskBody');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty-state">Risk events не знайдено.</td></tr>';
    } else {
      body.innerHTML = rows.map(row => `
        <tr>
          <td>#${row.id}</td>
          <td style="color:var(--text-muted);font-size:.8rem">${fmt(row.created_at)}</td>
          <td>${row.payment_order_id ? '#' + row.payment_order_id : '—'}</td>
          <td>${escHtml(row.user_name || '—')} <span style="color:var(--text-muted)">#${row.user_id || '—'}</span></td>
          <td>${riskBadge(row.severity || 'low')}</td>
          <td>${escHtml(row.event_type || '—')}</td>
          <td class="proc-detail" title="${escHtml(row.details || '—')}">${escHtml(row.details || '—')}</td>
          <td>
            ${row.resolved_at
              ? '<span class="badge badge-status">resolved</span>'
              : `<button class="tx-mini-btn" onclick="resolveRiskEventById(${row.id})">Resolve</button>`}
          </td>
        </tr>
      `).join('');
    }
    renderRiskPagination(offset, PROC_LIMIT);
  } catch (err) {
    if (reqId !== procRequestSeq.risk) return;
    showToast('Помилка risk events: ' + err.message, 'error');
  }
}
window.loadPaymentRiskEvents = loadPaymentRiskEvents;

async function resolveRiskEventById(eventId) {
  try {
    await api.resolvePaymentRiskEvent(eventId);
    showToast(`Risk event #${eventId} вирішено.`, 'success');
    await Promise.all([loadPaymentRiskEvents(procRiskOffset), loadFraudStats()]);
  } catch (err) {
    showToast('Помилка resolve: ' + err.message, 'error');
  }
}
window.resolveRiskEventById = resolveRiskEventById;

async function loadProcessing() {
  configureBulkActionsByRole();
  await Promise.all([
    loadFraudStats(),
    loadPaymentOrders(0),
    loadPaymentSlaQueue(0),
    loadProcessingWorkload(),
    loadApprovalInbox(),
    loadPaymentRiskEvents(0),
  ]);
}

document.getElementById('refreshProcessing')?.addEventListener('click', loadProcessing);
document.getElementById('procOrderApplyBtn')?.addEventListener('click', () => loadPaymentOrders(0));
document.getElementById('procOrderClearBtn')?.addEventListener('click', () => {
  document.getElementById('procOrderStatusFilter').value = '';
  document.getElementById('procOrderRiskFilter').value = '';
  document.getElementById('procOrderReviewFilter').value = '';
  document.getElementById('procOrderAssignedFilter').value = '';
  document.getElementById('procOrderUserFilter').value = '';
  document.getElementById('procOrderSearchFilter').value = '';
  loadPaymentOrders(0);
});
document.getElementById('procRiskApplyBtn')?.addEventListener('click', () => loadPaymentRiskEvents(0));
document.getElementById('procRiskClearBtn')?.addEventListener('click', () => {
  document.getElementById('procRiskSeverityFilter').value = '';
  document.getElementById('procRiskResolvedFilter').value = '';
  document.getElementById('procRiskUserFilter').value = '';
  loadPaymentRiskEvents(0);
});
document.getElementById('procOrderSearchFilter')?.addEventListener('input', debounce(() => loadPaymentOrders(0), 380));
document.getElementById('procSlaApplyBtn')?.addEventListener('click', () => loadPaymentSlaQueue(0));
document.getElementById('procSlaClearBtn')?.addEventListener('click', () => {
  document.getElementById('procSlaOverdueFilter').value = '';
  document.getElementById('procSlaAssignedFilter').value = '';
  document.getElementById('procSlaRiskFilter').value = '';
  document.getElementById('procSlaPriorityFilter').value = '';
  document.getElementById('procSlaApprovalFilter').value = '';
  document.getElementById('procSlaSearchFilter').value = '';
  clearSlaSelection();
  loadPaymentSlaQueue(0);
});
document.getElementById('procSlaSearchFilter')?.addEventListener('input', debounce(() => loadPaymentSlaQueue(0), 380));
document.getElementById('procInboxApplyBtn')?.addEventListener('click', () => loadApprovalInbox(0));
document.getElementById('procInboxClearBtn')?.addEventListener('click', () => {
  document.getElementById('procInboxActionFilter').value = '';
  document.getElementById('procInboxPriorityFilter').value = '';
  document.getElementById('procInboxOverdueFilter').value = '';
  document.getElementById('procInboxSearchFilter').value = '';
  loadApprovalInbox(0);
});
document.getElementById('procInboxSearchFilter')?.addEventListener('input', debounce(() => loadApprovalInbox(0), 380));
document.getElementById('procSlaAutoEscalateBtn')?.addEventListener('click', runSlaAutoEscalate);
document.getElementById('procSlaBulkRunBtn')?.addEventListener('click', runSlaBulkAction);
document.getElementById('procSlaSelectAll')?.addEventListener('change', (e) => {
  toggleSlaPageSelection(Boolean(e.target.checked));
});
document.getElementById('procSlaSelectAllHead')?.addEventListener('change', (e) => {
  toggleSlaPageSelection(Boolean(e.target.checked));
});

document.getElementById('procModalClose')?.addEventListener('click', closePaymentOrderCase);
document.getElementById('procOrderModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('procOrderModal')) closePaymentOrderCase();
});
document.getElementById('procModalAssignBtn')?.addEventListener('click', assignOpenPaymentOrder);
document.getElementById('procModalApproveBtn')?.addEventListener('click', () => decideOpenPaymentOrder('approve'));
document.getElementById('procModalRejectBtn')?.addEventListener('click', () => decideOpenPaymentOrder('reject'));
document.getElementById('procModalApprovalDenyBtn')?.addEventListener('click', () => finalizeOpenPaymentOrderApproval(false));
document.getElementById('procModalEscalateBtn')?.addEventListener('click', () => decideOpenPaymentOrder('escalate'));
document.getElementById('procModalClearBtn')?.addEventListener('click', () => decideOpenPaymentOrder('clear'));
document.getElementById('procModalAddNoteBtn')?.addEventListener('click', addOpenPaymentOrderNote);

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
   CARDS PAGE
══════════════════════════════════════════════ */
function cardStatusBadge(s) {
  if (s === 'active')  return badge('active', 'Активна');
  if (s === 'blocked') return badge('blocked', 'Заблокована');
  if (s === 'closed')  return badge('closed', 'Закрита');
  return badge('', s || '—');
}

function cardTypeLbl(t) {
  return t === 'physical' ? 'Фізична' : 'Віртуальна';
}

function renderCardsPagination(total, offset, limit) {
  const bar = document.getElementById('cardsPagination');
  if (!bar) return;
  const pages = Math.ceil(total / limit);
  const cur   = Math.floor(offset / limit);
  if (pages <= 1) { bar.innerHTML = ''; return; }
  let html = '';
  for (let i = 0; i < pages; i++) {
    html += `<button class="page-btn${i === cur ? ' active' : ''}" data-offset="${i * limit}">${i + 1}</button>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      cardsOffset = +btn.dataset.offset;
      loadAdminCards(cardsOffset);
    });
  });
}

async function loadCardsStats() {
  try {
    const res = await api.cardsStats();
    const d = res.data || {};
    document.getElementById('cardStatTotal').textContent   = d.total   ?? '—';
    document.getElementById('cardStatActive').textContent  = d.active  ?? '—';
    document.getElementById('cardStatBlocked').textContent = d.blocked ?? '—';
    document.getElementById('cardStatClosed').textContent  = d.closed  ?? '—';
  } catch { /* silent */ }
}

async function loadAdminCards(offset = 0) {
  cardsOffset = offset;
  const params = {};
  const search = (document.getElementById('cardSearch')?.value || '').trim();
  const status = document.getElementById('cardStatusFilter')?.value || '';
  const userId = (document.getElementById('cardUserIdFilter')?.value || '').trim();
  if (search) params.search = search;
  if (status) params.status = status;
  if (userId) params.user_id = userId;
  params.limit  = CARDS_LIMIT;
  params.offset = offset;

  if (offset === 0) loadCardsStats();

  document.getElementById('cardsBody').innerHTML = '<tr><td colspan="10" class="empty-state">Завантаження…</td></tr>';
  try {
    const res = await api.listAdminCards(params);
    const data  = res.data || [];
    const total = res.total || 0;

    if (!data.length) {
      document.getElementById('cardsBody').innerHTML = '<tr><td colspan="10" class="empty-state">Карток не знайдено.</td></tr>';
      renderCardsPagination(0, 0, CARDS_LIMIT);
      return;
    }

    document.getElementById('cardsBody').innerHTML = data.map(c => `
      <tr>
        <td style="color:var(--text-muted);font-size:.78rem">${c.id}</td>
        <td><code style="font-size:.8rem">${escHtml(c.card_number_masked || '****')}</code></td>
        <td style="font-size:.82rem">${cardTypeLbl(c.card_type)}</td>
        <td style="font-size:.82rem">${escHtml(c.design || 'gold')}</td>
        <td>
          <div style="font-weight:600;font-size:.82rem">${escHtml(c.full_name || '—')}</div>
          <div style="font-size:.75rem;color:var(--text-muted)">${escHtml(c.phone || '')} · ID ${c.user_id}</div>
        </td>
        <td style="font-size:.78rem;color:var(--text-muted)">${escHtml(c.account_number || '—')}</td>
        <td>${cardStatusBadge(c.status)}</td>
        <td style="font-size:.78rem;color:var(--text-muted);white-space:nowrap">${fmt(c.issued_at)}</td>
        <td style="font-size:.78rem;color:var(--text-muted);white-space:nowrap">${c.expires_at ? c.expires_at.slice(0,7) : '—'}</td>
        <td class="actions-cell">
          ${c.status !== 'blocked' && c.status !== 'closed'
            ? `<button class="btn-secondary card-action-btn" data-id="${c.id}" data-action="block" style="font-size:.75rem;padding:4px 8px">Блок</button>`
            : ''}
          ${c.status === 'blocked'
            ? `<button class="btn-secondary card-action-btn" data-id="${c.id}" data-action="unblock" style="font-size:.75rem;padding:4px 8px">Розблок</button>`
            : ''}
          ${c.status !== 'closed'
            ? `<button class="btn-secondary card-action-btn" data-id="${c.id}" data-action="close" style="font-size:.75rem;padding:4px 8px;color:var(--danger)">Закрити</button>`
            : ''}
        </td>
      </tr>
    `).join('');

    renderCardsPagination(total, offset, CARDS_LIMIT);
  } catch (err) {
    document.getElementById('cardsBody').innerHTML = `<tr><td colspan="10" class="empty-state">${escHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('applyCardFilterBtn')?.addEventListener('click', () => loadAdminCards(0));
document.getElementById('clearCardFilterBtn')?.addEventListener('click', () => {
  document.getElementById('cardSearch').value = '';
  document.getElementById('cardStatusFilter').value = '';
  document.getElementById('cardUserIdFilter').value = '';
  loadAdminCards(0);
});

document.getElementById('cardsBody')?.addEventListener('click', async e => {
  const btn = e.target.closest('.card-action-btn');
  if (!btn) return;
  const { id, action } = btn.dataset;
  const labels = { block: 'Заблокувати', unblock: 'Розблокувати', close: 'Закрити' };
  if (!confirm(`${labels[action] || action} картку ID ${id}?`)) return;
  try {
    if (action === 'block')   await api.blockAdminCard(id);
    if (action === 'unblock') await api.unblockAdminCard(id);
    if (action === 'close')   await api.closeAdminCard(id);
    showToast('Готово!');
    loadAdminCards(cardsOffset);
  } catch (err) {
    showToast('Помилка: ' + err.message, 'error');
  }
});

/* Issue card modal */
let _issueCardDropdownUsers = [];
const issueCardUserSearch = document.getElementById('issueCardUserSearch');
const issueCardDropdown   = document.getElementById('issueCardUserDropdown');

function setIssueCardUser(user) {
  issueCardSelectedUserId = user.id;
  document.getElementById('issueCardSelectedName').textContent = `${user.full_name} · ${user.phone}`;
  document.getElementById('issueCardSelectedUser').classList.remove('hidden');
  issueCardUserSearch.value = '';
  issueCardDropdown.classList.add('hidden');
  document.getElementById('issueCardSubmitBtn').disabled = false;
}

issueCardUserSearch?.addEventListener('input', debounce(async () => {
  const q = issueCardUserSearch.value.trim();
  if (q.length < 2) { issueCardDropdown.classList.add('hidden'); return; }
  try {
    const res = await api.listUsers({ search: q });
    _issueCardDropdownUsers = (res.data || []).slice(0, 8);
    if (!_issueCardDropdownUsers.length) { issueCardDropdown.classList.add('hidden'); return; }
    issueCardDropdown.innerHTML = _issueCardDropdownUsers.map(u =>
      `<div class="user-dropdown-item" data-uid="${u.id}">${escHtml(u.full_name)} <span style="opacity:.6">${escHtml(u.phone)}</span></div>`
    ).join('');
    issueCardDropdown.classList.remove('hidden');
  } catch { issueCardDropdown.classList.add('hidden'); }
}, 280));

issueCardDropdown?.addEventListener('click', e => {
  const item = e.target.closest('.user-dropdown-item');
  if (!item) return;
  const user = _issueCardDropdownUsers.find(u => u.id == item.dataset.uid);
  if (user) setIssueCardUser(user);
});

document.getElementById('issueCardClearUser')?.addEventListener('click', () => {
  issueCardSelectedUserId = null;
  document.getElementById('issueCardSelectedUser').classList.add('hidden');
  document.getElementById('issueCardSubmitBtn').disabled = true;
});

document.getElementById('issueCardOpenBtn')?.addEventListener('click', () => {
  issueCardSelectedUserId = null;
  document.getElementById('issueCardSelectedUser').classList.add('hidden');
  document.getElementById('issueCardSubmitBtn').disabled = true;
  document.getElementById('issueCardUserSearch').value = '';
  document.getElementById('issueCardMsg').classList.add('hidden');
  document.getElementById('issueCardModal').classList.remove('hidden');
});

document.getElementById('issueCardCloseBtn')?.addEventListener('click', () => {
  document.getElementById('issueCardModal').classList.add('hidden');
});

document.getElementById('issueCardSubmitBtn')?.addEventListener('click', async () => {
  if (!issueCardSelectedUserId) return;
  const card_type = document.getElementById('issueCardType').value;
  const design    = document.getElementById('issueCardDesign').value;
  const msg = document.getElementById('issueCardMsg');
  msg.classList.add('hidden');
  try {
    await api.issueAdminCard(issueCardSelectedUserId, { card_type, design });
    showToast('Картку видано!');
    document.getElementById('issueCardModal').classList.add('hidden');
    loadAdminCards(cardsOffset);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

/* ══════════════════════════════════════════════
   COMPLIANCE PAGE
══════════════════════════════════════════════ */
function kycBadge(s) {
  const map = { not_started: ['', 'Не розпочато'], pending: ['pending', 'Очікує'],
    in_review: ['processing', 'На перевірці'], verified: ['active', 'Верифіковано'], rejected: ['blocked', 'Відхилено'] };
  const [cls, lbl] = map[s] || ['', s || '—'];
  return `<span class="badge badge-${cls}" style="font-size:.75rem">${lbl}</span>`;
}

function riskBadge(r) {
  const map = { low: 'active', medium: 'pending', high: 'processing', critical: 'blocked' };
  return `<span class="badge badge-${map[r] || ''}" style="font-size:.75rem">${r || '—'}</span>`;
}

function renderCmpPagination(total, offset, limit) {
  const bar = document.getElementById('compliancePagination');
  if (!bar) return;
  const pages = Math.ceil(total / limit);
  const cur   = Math.floor(offset / limit);
  if (pages <= 1) { bar.innerHTML = ''; return; }
  let html = '';
  for (let i = 0; i < pages; i++) {
    html += `<button class="page-btn${i === cur ? ' active' : ''}" data-offset="${i * limit}">${i + 1}</button>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      cmpOffset = +btn.dataset.offset;
      loadCompliance(cmpOffset);
    });
  });
}

async function loadComplianceStats() {
  try {
    const res = await api.complianceStats();
    const d = res.data || {};
    document.getElementById('cmpStatTotal').textContent    = d.total_users ?? '—';
    document.getElementById('cmpStatVerified').textContent = d.kyc?.verified ?? 0;
    document.getElementById('cmpStatInReview').textContent = d.kyc?.in_review ?? 0;
    document.getElementById('cmpStatPending').textContent  = (d.kyc?.pending ?? 0) + (d.kyc?.not_started ?? 0);
    document.getElementById('cmpStatRejected').textContent = d.kyc?.rejected ?? 0;
    document.getElementById('cmpStatAml').textContent      = d.aml_flagged ?? 0;
    document.getElementById('cmpStatHighRisk').textContent = (d.risk?.high ?? 0) + (d.risk?.critical ?? 0);
    document.getElementById('cmpStatUntracked').textContent = d.untracked ?? 0;
  } catch { /* ignore */ }
}

async function loadCompliance(offset = 0) {
  cmpOffset = offset;
  await loadComplianceStats();

  const params = { limit: CMP_LIMIT, offset };
  const search = (document.getElementById('cmpSearch')?.value || '').trim();
  const kyc    = document.getElementById('cmpKycFilter')?.value || '';
  const aml    = document.getElementById('cmpAmlFilter')?.value ?? '';
  const risk   = document.getElementById('cmpRiskFilter')?.value || '';
  if (search) params.search = search;
  if (kyc)    params.kyc_status = kyc;
  if (aml !== '') params.aml_flag = aml;
  if (risk)   params.risk_level = risk;

  document.getElementById('complianceBody').innerHTML = '<tr><td colspan="10" class="empty-state">Завантаження…</td></tr>';
  try {
    const res = await api.complianceUsers(params);
    const data  = res.data || [];
    const total = res.total || 0;

    if (!data.length) {
      document.getElementById('complianceBody').innerHTML = '<tr><td colspan="10" class="empty-state">Записів не знайдено.</td></tr>';
      renderCmpPagination(0, 0, CMP_LIMIT);
      return;
    }

    document.getElementById('complianceBody').innerHTML = data.map(u => `
      <tr>
        <td style="color:var(--text-muted);font-size:.78rem">${u.id}</td>
        <td style="font-weight:600;font-size:.82rem">${escHtml(u.full_name || '—')}</td>
        <td style="font-size:.8rem;color:var(--text-muted)">${escHtml(u.phone || '—')}</td>
        <td>${roleBadge(u.role)}</td>
        <td>${kycBadge(u.kyc_status)}</td>
        <td>${u.aml_flag ? '<span class="badge badge-blocked" style="font-size:.75rem">⚑ AML</span>' : '<span style="color:var(--text-muted);font-size:.78rem">—</span>'}</td>
        <td>${riskBadge(u.risk_level)}</td>
        <td style="font-size:.78rem;color:var(--text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(u.notes || '')}">${escHtml(u.notes || '—')}</td>
        <td style="font-size:.78rem;color:var(--text-muted);white-space:nowrap">${u.updated_at ? fmt(u.updated_at) : '—'}</td>
        <td class="actions-cell">
          <button class="btn-secondary cmp-edit-btn" data-uid="${u.id}" style="font-size:.75rem;padding:4px 8px">Редагувати</button>
        </td>
      </tr>
    `).join('');

    renderCmpPagination(total, offset, CMP_LIMIT);
  } catch (err) {
    document.getElementById('complianceBody').innerHTML = `<tr><td colspan="10" class="empty-state">${escHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('applyCmpFilterBtn')?.addEventListener('click', () => loadCompliance(0));
document.getElementById('clearCmpFilterBtn')?.addEventListener('click', () => {
  document.getElementById('cmpSearch').value = '';
  document.getElementById('cmpKycFilter').value = '';
  document.getElementById('cmpAmlFilter').value = '';
  document.getElementById('cmpRiskFilter').value = '';
  loadCompliance(0);
});

document.getElementById('refreshComplianceBtn')?.addEventListener('click', () => loadCompliance(0));

/* Compliance detail modal */
async function openComplianceModal(userId) {
  cmpModalUserId = userId;
  try {
    const res = await api.complianceGetUser(userId);
    const u = res.data;
    const cp = u.compliance || {};
    const initials = (u.full_name || 'C').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('cmpModalAvatar').textContent    = initials;
    document.getElementById('cmpModalName').textContent      = u.full_name || '—';
    document.getElementById('cmpModalRoleBadge').innerHTML   = roleBadge(u.role);
    document.getElementById('cmpModalUserId').textContent    = u.id;
    document.getElementById('cmpModalPhone').textContent     = u.phone || '—';
    document.getElementById('cmpModalEmail').textContent     = u.email || '—';
    document.getElementById('cmpModalUpdatedAt').textContent = cp.updated_at ? fmt(cp.updated_at) : '—';
    document.getElementById('cmpModalUpdatedBy').textContent = cp.updated_by_name || (cp.updated_by ? `#${cp.updated_by}` : '—');
    document.getElementById('cmpEditKyc').value   = cp.kyc_status || 'pending';
    document.getElementById('cmpEditRisk').value  = cp.risk_level || 'low';
    document.getElementById('cmpEditAmlFlag').checked = !!cp.aml_flag;
    document.getElementById('cmpEditNotes').value = cp.notes || '';
    document.getElementById('cmpModalMsg').classList.add('hidden');
    document.getElementById('complianceModal').classList.remove('hidden');
  } catch (err) {
    showToast('Помилка завантаження: ' + err.message, 'error');
  }
}

document.getElementById('complianceBody')?.addEventListener('click', e => {
  const btn = e.target.closest('.cmp-edit-btn');
  if (!btn) return;
  openComplianceModal(+btn.dataset.uid);
});

document.getElementById('cmpModalCloseBtn')?.addEventListener('click', () => {
  document.getElementById('complianceModal').classList.add('hidden');
});
document.getElementById('cmpModalCancelBtn')?.addEventListener('click', () => {
  document.getElementById('complianceModal').classList.add('hidden');
});

document.getElementById('cmpModalSaveBtn')?.addEventListener('click', async () => {
  if (!cmpModalUserId) return;
  const msg = document.getElementById('cmpModalMsg');
  msg.classList.add('hidden');
  try {
    await api.complianceUpdateUser(cmpModalUserId, {
      kyc_status: document.getElementById('cmpEditKyc').value,
      risk_level: document.getElementById('cmpEditRisk').value,
      aml_flag:   document.getElementById('cmpEditAmlFlag').checked ? 1 : 0,
      notes:      document.getElementById('cmpEditNotes').value.trim() || null,
    });
    showToast('Збережено!');
    document.getElementById('complianceModal').classList.add('hidden');
    loadCompliance(cmpOffset);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

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
