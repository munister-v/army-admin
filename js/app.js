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
  const map = { soldier: 'Клієнт', operator: 'Оператор', admin: 'Адмін', platform_admin: 'Plt Admin' };
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
let dispatchOffset = 0;
const DISPATCH_LIMIT = 50;
let batchRows = [];
let batchRowId = 0;
let accOffset = 0;
const ACC_LIMIT = 100;
let accAllRows = [];
let reportSelectedUserId = null;
let globalReportRows = [];
let balAllRows = [];
let balSelectedIds = new Set();
let balOffset = 0;
const BAL_LIMIT = 100;
let balFilteredRows = [];
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
const FULL_ACCESS_PAGES = ['dashboard', 'users', 'transactions', 'processing', 'payouts', 'cards', 'compliance', 'audit', 'accounts', 'balances', 'reports', 'analytics', 'documents', 'simulator', 'agent'];
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
    case 'payouts':      loadFinancePage(); break;
    case 'cards':        loadAdminCards(); break;
    case 'compliance':   loadCompliance(); break;
    case 'audit':        loadAuditLogs(); break;
    case 'accounts':     loadAccountsPage(); break;
    case 'balances':     loadBalancesPage(); break;
    case 'reports':      loadReportsPage(); break;
    case 'analytics':    loadAnalyticsPage(); break;
    case 'documents':    loadDocumentsPage(); break;
    case 'simulator':    loadSimulatorPage(); break;
    case 'agent':        initAgentPage(); break;
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
  startSessionEngine();
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
  stopSessionEngine();
  await api.logout();
  api.setToken('');
  showAuth();
});

window.addEventListener('admin:unauthorized', () => { stopSessionEngine(); showAuth(); });

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

    const roleNames = { soldier: 'Клієнт', operator: 'Оператор', admin: 'Адмін', platform_admin: 'Platform Admin' };
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
  downloadCsv(`transactions_registry_${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
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
    await api.createPayout({ user_id: selectedPayoutUser, amount, title, payout_type });
    msgEl.textContent = `✓ Виплату ${fmtMoney(amount)} нараховано успішно.`;
    msgEl.className   = 'form-msg success';
    document.getElementById('payoutAmount').value = '';
    document.getElementById('payoutTitle').value  = '';
    showToast('Виплату нараховано', 'success');
    loadFinanceStats();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = 'form-msg error';
  }
});

/* ══════════════════════════════════════════════
   FINANCE PAGE — stats + batch + dispatch
══════════════════════════════════════════════ */
function loadFinancePage() {
  loadFinanceStats();
  // activate single tab by default
  finSwitchTab('single');
  loadDispatch();
}

async function loadFinanceStats() {
  try {
    const [monthRes, todayRes] = await api.financeStats();
    const monthTxs = monthRes.data || [];
    const todayTxs = todayRes.data || [];

    const sum = arr => arr.reduce((acc, t) => acc + Number(t.amount || 0), 0);

    document.getElementById('finStatMonthCount').textContent  = monthTxs.length;
    document.getElementById('finStatMonthAmount').textContent = fmtMoney(sum(monthTxs));
    document.getElementById('finStatTodayCount').textContent  = todayTxs.length;
    document.getElementById('finStatTodayAmount').textContent = fmtMoney(sum(todayTxs));

    const combat = monthTxs.filter(t => (t.description || '').toLowerCase().includes('бойов') ||
                                        (t.tx_type || '') === 'payout' && (t.description || '').toLowerCase().includes('combat'));
    const salary = monthTxs.filter(t => (t.description || '').toLowerCase().includes('забезп') ||
                                        (t.description || '').toLowerCase().includes('salary'));
    document.getElementById('finStatCombat').textContent = `${combat.length} · ${fmtMoney(sum(combat))}`;
    document.getElementById('finStatSalary').textContent = `${salary.length} · ${fmtMoney(sum(salary))}`;
  } catch (err) {
    // stats are non-critical
  }
}

// ── Finance tab switcher ──────────────────────────────────────────────────────
document.querySelectorAll('[data-fin-tab]').forEach(btn => {
  btn.addEventListener('click', () => finSwitchTab(btn.dataset.finTab));
});

function finSwitchTab(tab) {
  document.querySelectorAll('[data-fin-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.finTab === tab)
  );
  document.querySelectorAll('.fin-tab-content').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById(`fin-tab-${tab}`);
  if (panel) panel.classList.remove('hidden');
  if (tab === 'dispatch') loadDispatch();
}
document.getElementById('refreshPayoutsBtn').addEventListener('click', () => {
  loadFinanceStats();
  loadDispatch();
});

// ── Dispatch journal ──────────────────────────────────────────────────────────
function renderDispatchPagination(total, offset, limit) {
  const bar = document.getElementById('dispatchPagination');
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
    btn.addEventListener('click', () => loadDispatch({ offset: +btn.dataset.offset }));
  });
}

async function loadDispatch(opts = {}) {
  dispatchOffset = opts.offset ?? 0;
  const search = document.getElementById('dispatchSearch').value.trim() || undefined;
  const type   = document.getElementById('dispatchTypeFilter').value || undefined;
  const from   = document.getElementById('dispatchFrom').value || undefined;
  const to     = document.getElementById('dispatchTo').value || undefined;

  const params = { limit: DISPATCH_LIMIT, offset: dispatchOffset };
  if (search) params.search = search;
  if (type)   params.description = type;    // backend uses description filter
  if (from)   params.from_date = from;
  if (to)     params.to_date   = to;

  document.getElementById('dispatchBody').innerHTML =
    '<tr><td colspan="7" class="empty-state">Завантаження…</td></tr>';

  try {
    const res  = await api.listPayouts(params);
    const rows = res.data || [];
    const total = res.total ?? rows.length;

    document.getElementById('dispatchBody').innerHTML = rows.length ? rows.map(t => `
      <tr>
        <td style="color:var(--text-muted);font-size:.8rem">${t.id}</td>
        <td style="white-space:nowrap;font-size:.82rem">${fmt(t.created_at)}</td>
        <td>
          <div style="font-weight:600;font-size:.85rem">${escHtml(t.user_name || t.full_name || '—')}</div>
          <div style="color:var(--text-muted);font-size:.78rem">${escHtml(t.related_account || '')}</div>
        </td>
        <td><span class="badge badge-${t.tx_type || 'payout'}">${txTypeLabel(t.tx_type)}</span></td>
        <td style="font-weight:700;color:var(--gold)">${fmtMoney(t.amount)}</td>
        <td style="font-size:.82rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.description || '—')}</td>
        <td style="font-size:.78rem;color:var(--text-muted)">${escHtml(t.actor_name || '—')}</td>
      </tr>
    `).join('') : '<tr><td colspan="7" class="empty-state">Виплат не знайдено</td></tr>';

    // Pagination
    renderDispatchPagination(total, dispatchOffset, DISPATCH_LIMIT);
  } catch (err) {
    document.getElementById('dispatchBody').innerHTML =
      `<tr><td colspan="7" class="empty-state" style="color:var(--red)">${escHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('dispatchApplyBtn').addEventListener('click', () => loadDispatch());
document.getElementById('dispatchClearBtn').addEventListener('click', () => {
  document.getElementById('dispatchSearch').value = '';
  document.getElementById('dispatchTypeFilter').value = '';
  document.getElementById('dispatchFrom').value = '';
  document.getElementById('dispatchTo').value = '';
  loadDispatch();
});

document.getElementById('dispatchExportCsvBtn').addEventListener('click', async () => {
  try {
    const res  = await api.listPayouts({ limit: 2000 });
    const rows = res.data || [];
    const header = 'ID,Дата,Отримувач,Рахунок,Сума,Опис';
    const lines  = rows.map(t =>
      [t.id, t.created_at, t.user_name || t.full_name, t.related_account, t.amount, `"${(t.description||'').replace(/"/g,'""')}"`].join(',')
    );
    downloadCsv(`payouts_${new Date().toISOString().slice(0,10)}.csv`, header + '\n' + lines.join('\n'));
  } catch (err) { showToast('Помилка: ' + err.message, 'error'); }
});

// ── Batch payout ──────────────────────────────────────────────────────────────
function renderBatchTable() {
  const tbody = document.getElementById('batchBody');
  const empty = document.getElementById('batchEmptyRow');
  const PAYOUT_TYPES = { combat: 'Бойова виплата', salary: 'Грошове забезп.', bonus: 'Бонус', other: 'Інше' };

  if (!batchRows.length) {
    tbody.innerHTML = '';
    tbody.appendChild(empty);
    document.getElementById('submitBatchBtn').disabled = true;
    document.getElementById('batchSummaryLabel').textContent = '0 рядків · ₴ 0,00';
    return;
  }
  empty.remove();

  tbody.innerHTML = batchRows.map((row, idx) => `
    <tr data-bid="${row.id}">
      <td style="color:var(--text-muted);font-size:.8rem">${idx + 1}</td>
      <td>
        <div style="font-weight:600;font-size:.85rem">${escHtml(row.userName || '—')}</div>
        <div style="color:var(--text-muted);font-size:.78rem">ID ${row.userId}</div>
      </td>
      <td>
        <select class="filter-select batch-type-sel" data-bid="${row.id}" style="font-size:.8rem;padding:4px 6px">
          ${Object.entries(PAYOUT_TYPES).map(([v,l]) =>
            `<option value="${v}" ${row.type === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </td>
      <td>
        <input type="number" class="filter-input batch-amount-inp" data-bid="${row.id}" value="${row.amount || ''}"
          placeholder="0.00" min="0.01" step="0.01" style="max-width:120px;font-size:.85rem" />
      </td>
      <td>
        <input type="text" class="filter-input batch-title-inp" data-bid="${row.id}" value="${escHtml(row.title || '')}"
          placeholder="Призначення" style="font-size:.82rem" />
      </td>
      <td>
        <button class="btn-ghost batch-remove-btn" data-bid="${row.id}"
          style="padding:4px 8px;font-size:.78rem;color:var(--red)">✕</button>
      </td>
    </tr>
  `).join('');

  // bind events
  tbody.querySelectorAll('.batch-type-sel').forEach(sel =>
    sel.addEventListener('change', e => { findBatchRow(e.target.dataset.bid).type = e.target.value; updateBatchSummary(); })
  );
  tbody.querySelectorAll('.batch-amount-inp').forEach(inp =>
    inp.addEventListener('input', e => { findBatchRow(e.target.dataset.bid).amount = parseFloat(e.target.value) || 0; updateBatchSummary(); })
  );
  tbody.querySelectorAll('.batch-title-inp').forEach(inp =>
    inp.addEventListener('input', e => { findBatchRow(e.target.dataset.bid).title = e.target.value; })
  );
  tbody.querySelectorAll('.batch-remove-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      batchRows = batchRows.filter(r => String(r.id) !== String(e.target.dataset.bid));
      renderBatchTable();
    })
  );
  updateBatchSummary();
}

function findBatchRow(id) { return batchRows.find(r => String(r.id) === String(id)); }

function updateBatchSummary() {
  const total = batchRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  document.getElementById('batchSummaryLabel').textContent =
    `${batchRows.length} рядків · ${fmtMoney(total)}`;
  document.getElementById('submitBatchBtn').disabled = !batchRows.length || !batchRows.every(r => r.userId && r.amount > 0);
}

// Add row via user search dropdown (reuse payout search infra)
let batchAddingRow = null;
const debouncedBatchSearch = debounce(async q => {
  if (!q || q.length < 2 || !batchAddingRow) return;
  try {
    const res   = await api.listUsers({ search: q });
    const users = (res.data || []).slice(0, 8);
    const dd    = document.getElementById(`batchDrop_${batchAddingRow}`);
    if (!dd) return;
    if (!users.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = users.map(u => `
      <div class="dropdown-item"
        onclick="selectBatchUser(${batchAddingRow}, ${u.id}, '${escHtml(u.full_name)}')">
        <div class="d-name">${escHtml(u.full_name)}</div>
        <div class="d-sub">${escHtml(u.phone || '')} ${escHtml(u.email || '')}</div>
      </div>
    `).join('');
    dd.classList.remove('hidden');
  } catch {}
}, 350);

window.selectBatchUser = function(bid, userId, name) {
  const row = findBatchRow(bid);
  if (!row) return;
  row.userId = userId;
  row.userName = name;
  renderBatchTable();
  updateBatchSummary();
};

document.getElementById('batchAddRowBtn').addEventListener('click', () => {
  const id = ++batchRowId;
  const defaultType   = document.getElementById('batchDefaultType').value || 'combat';
  const defaultAmount = parseFloat(document.getElementById('batchDefaultAmount').value) || 0;
  batchRows.push({ id, userId: null, userName: null, type: defaultType, amount: defaultAmount, title: '' });

  // Render the row, then inject a user search field into the user cell
  renderBatchTable();

  const userCell = document.querySelector(`tr[data-bid="${id}"] td:nth-child(2)`);
  if (userCell) {
    userCell.innerHTML = `
      <div class="user-search-wrap" style="position:relative">
        <input type="text" class="filter-input" id="batchSearch_${id}" placeholder="Пошук користувача…"
          autocomplete="off" style="font-size:.82rem" />
        <div class="user-dropdown hidden" id="batchDrop_${id}"></div>
      </div>
    `;
    batchAddingRow = id;
    const inp = document.getElementById(`batchSearch_${id}`);
    inp.addEventListener('input', e => {
      batchAddingRow = id;
      debouncedBatchSearch(e.target.value.trim());
    });
    inp.focus();
  }
});

document.getElementById('batchFillAmountBtn').addEventListener('click', () => {
  const amt = parseFloat(document.getElementById('batchDefaultAmount').value);
  if (!amt || amt <= 0) return;
  batchRows.forEach(r => { r.amount = amt; });
  renderBatchTable();
});

document.getElementById('submitBatchBtn').addEventListener('click', async () => {
  const invalid = batchRows.filter(r => !r.userId || !(r.amount > 0));
  if (invalid.length) { showToast('Заповніть всі поля', 'error'); return; }

  const btn = document.getElementById('submitBatchBtn');
  btn.disabled = true;
  const progressWrap = document.getElementById('batchProgress');
  const bar          = document.getElementById('batchProgressBar');
  const log          = document.getElementById('batchResultLog');
  progressWrap.classList.remove('hidden');
  log.classList.remove('hidden');
  log.textContent = '';

  let done = 0;
  for (const row of batchRows) {
    try {
      await api.createPayout({
        user_id: row.userId,
        amount: row.amount,
        title: row.title || 'Виплата',
        payout_type: row.type,
      });
      done++;
      log.textContent += `✓ [${row.userName}] ${fmtMoney(row.amount)}\n`;
    } catch (err) {
      log.textContent += `✗ [${row.userName}] ${err.message}\n`;
    }
    bar.style.width = `${Math.round((done / batchRows.length) * 100)}%`;
    log.scrollTop = log.scrollHeight;
  }
  bar.style.width = '100%';
  showToast(`Пакет: ${done}/${batchRows.length} успішно`, done === batchRows.length ? 'success' : 'error');
  batchRows = [];
  batchRowId = 0;
  setTimeout(() => {
    renderBatchTable();
    progressWrap.classList.add('hidden');
    bar.style.width = '0%';
    btn.disabled = false;
    loadFinanceStats();
  }, 1800);
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
   ACCOUNTS PAGE
══════════════════════════════════════════════ */
function loadAccountsPage() {
  accOffset = 0;
  loadAccounts();
}

async function loadAccounts() {
  const search = (document.getElementById('accSearch')?.value || '').trim().toLowerCase();
  const sort   = document.getElementById('accSortBy')?.value || 'balance_desc';
  const body   = document.getElementById('accountsBody');
  const empty  = document.getElementById('accountsEmpty');
  body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Завантаження…</td></tr>';
  empty.classList.add('hidden');
  try {
    const res = await api.listAccounts({ limit: 500 });
    let rows = res.users || res.data || [];
    accAllRows = rows;

    // Update stats
    const totalBal = rows.reduce((s, u) => s + (u.account?.balance || 0), 0);
    document.getElementById('accStatTotal').textContent = rows.length;
    document.getElementById('accStatBalance').textContent = fmtMoney(totalBal);
    document.getElementById('accStatAvg').textContent = rows.length ? fmtMoney(totalBal / rows.length) : '—';
    document.getElementById('accStatErrors').textContent = '—';

    // Filter
    if (search) {
      rows = rows.filter(u =>
        (u.full_name || '').toLowerCase().includes(search) ||
        (u.account?.account_number || '').toLowerCase().includes(search) ||
        (u.phone || '').includes(search)
      );
    }

    // Sort
    rows = [...rows].sort((a, b) => {
      if (sort === 'balance_desc') return (b.account?.balance || 0) - (a.account?.balance || 0);
      if (sort === 'balance_asc')  return (a.account?.balance || 0) - (b.account?.balance || 0);
      if (sort === 'name_asc') return (a.full_name || '').localeCompare(b.full_name || '', 'uk');
      if (sort === 'created_desc') return new Date(b.created_at) - new Date(a.created_at);
      return 0;
    });

    // Pagination
    const total  = rows.length;
    const page   = rows.slice(accOffset, accOffset + ACC_LIMIT);
    renderAccountsPagination(total, accOffset, ACC_LIMIT);

    if (!page.length) { body.innerHTML = ''; empty.classList.remove('hidden'); return; }
    body.innerHTML = page.map(u => {
      const acc = u.account || {};
      const bal = acc.balance != null ? fmtMoney(acc.balance) : '—';
      const accNum = acc.account_number ? `<code style="font-size:.78rem">${escHtml(acc.account_number)}</code>` : '—';
      const cards = u.card_count != null ? u.card_count : '—';
      const kyc = kycBadge(u.kyc_status);
      return `<tr>
        <td>${accNum}</td>
        <td>${escHtml(u.full_name || '—')}</td>
        <td>${roleBadge(u.role)}</td>
        <td style="font-weight:600">${bal}</td>
        <td>${cards}</td>
        <td>${kyc}</td>
        <td>${fmt(u.created_at)}</td>
        <td>
          <button class="btn-table" onclick="openUserFromAccounts(${u.id})">Профіль</button>
          <button class="btn-table" onclick="accBalanceAdjust(${u.id}, '${escHtml(u.full_name || '')}')">Коригування</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" style="color:var(--red)">${escHtml(err.message)}</td></tr>`;
  }
}

function renderAccountsPagination(total, offset, limit) {
  const el = document.getElementById('accountsPagination');
  if (!el) return;
  const pages = Math.ceil(total / limit);
  const cur   = Math.floor(offset / limit);
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="page-btn${i === cur ? ' active' : ''}" data-accpage="${i}">${i + 1}</button>`
  ).join('');
  el.querySelectorAll('[data-accpage]').forEach(btn => {
    btn.addEventListener('click', () => {
      accOffset = parseInt(btn.dataset.accpage) * limit;
      loadAccounts();
    });
  });
}

window.openUserFromAccounts = function(userId) { navigate('users'); openUserModal(userId); };

window.accBalanceAdjust = async function(userId, name) {
  const amtStr = prompt(`Коригування балансу для ${name}\nВкажіть суму (від'ємна — списання, додатна — поповнення):`);
  if (amtStr === null) return;
  const amount = parseFloat(amtStr.replace(',', '.'));
  if (isNaN(amount) || amount === 0) { showToast('Невірна сума', 'error'); return; }
  const reason = prompt('Причина коригування:') || '';
  try {
    await api.adjustUserBalance(userId, { amount, reason });
    showToast('Баланс скориговано');
    loadAccounts();
  } catch (err) { showToast(err.message, 'error'); }
};

document.getElementById('refreshAccountsBtn')?.addEventListener('click', loadAccounts);
document.getElementById('accApplyBtn')?.addEventListener('click', () => { accOffset = 0; loadAccounts(); });
document.getElementById('accSearch')?.addEventListener('keydown', e => { if (e.key === 'Enter') { accOffset = 0; loadAccounts(); } });

document.getElementById('accountsIntegrityBtn')?.addEventListener('click', async () => {
  const result = document.getElementById('accountsIntegrityResult');
  result.textContent = 'Перевірка…';
  result.className = 'form-msg';
  result.classList.remove('hidden');
  try {
    const res = await api.integrityCheckAll();
    const issues = res.issues || res.errors || [];
    if (!issues.length) {
      result.textContent = 'Цілісність рахунків: ОК — помилок не знайдено.';
      result.className = 'form-msg success';
      document.getElementById('accStatErrors').textContent = '0';
    } else {
      result.textContent = `Знайдено ${issues.length} проблем: ${issues.slice(0, 3).map(i => i.message || JSON.stringify(i)).join('; ')}${issues.length > 3 ? '…' : ''}`;
      result.className = 'form-msg error';
      document.getElementById('accStatErrors').textContent = issues.length;
    }
  } catch (err) {
    result.textContent = `Помилка перевірки: ${err.message}`;
    result.className = 'form-msg error';
  }
});

/* ══════════════════════════════════════════════
   REPORTS PAGE
══════════════════════════════════════════════ */
function loadReportsPage() {
  // Switch to first tab by default
  repSwitchTab('user');
  // Init global date pickers
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const fromEl = document.getElementById('repGlobalFrom');
  const toEl   = document.getElementById('repGlobalTo');
  if (fromEl && !fromEl.value) fromEl.value = monthStart;
  if (toEl && !toEl.value)     toEl.value   = today;
  document.getElementById('globalReportEmpty')?.classList.remove('hidden');
  document.getElementById('globalReportContent')?.classList.add('hidden');
  document.getElementById('userReportEmpty')?.classList.remove('hidden');
  document.getElementById('userReportContent')?.classList.add('hidden');
}

function repSwitchTab(tab) {
  document.querySelectorAll('[data-rep-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.repTab === tab);
  });
  ['user', 'global'].forEach(t => {
    const el = document.getElementById(`rep-tab-${t}`);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
}
document.querySelectorAll('[data-rep-tab]').forEach(btn => {
  btn.addEventListener('click', () => repSwitchTab(btn.dataset.repTab));
});

// User report — user search
const repUserSearchEl = document.getElementById('reportUserSearch');
const repUserDropdown = document.getElementById('reportUserDropdown');
const debouncedRepUserSearch = debounce(async (q) => {
  if (q.length < 2) { repUserDropdown?.classList.add('hidden'); return; }
  try {
    const res = await api.listUsers({ search: q, limit: 8 });
    const users = res.users || res.data || [];
    if (!users.length) { repUserDropdown.innerHTML = '<div class="dropdown-item muted">Не знайдено</div>'; repUserDropdown.classList.remove('hidden'); return; }
    repUserDropdown.innerHTML = users.map(u =>
      `<div class="dropdown-item" data-uid="${u.id}" data-name="${escHtml(u.full_name || u.phone || u.id)}">${escHtml(u.full_name || '—')} <span style="color:var(--text-muted);font-size:.8rem">${escHtml(u.phone || '')}</span></div>`
    ).join('');
    repUserDropdown.classList.remove('hidden');
    repUserDropdown.querySelectorAll('.dropdown-item[data-uid]').forEach(item => {
      item.addEventListener('click', () => {
        reportSelectedUserId = item.dataset.uid;
        document.getElementById('reportSelectedName').textContent = item.dataset.name;
        document.getElementById('reportSelectedUser').classList.remove('hidden');
        repUserSearchEl.value = '';
        repUserDropdown.classList.add('hidden');
        document.getElementById('loadUserReportBtn').disabled = false;
        document.getElementById('exportUserReportCsvBtn').disabled = true;
      });
    });
  } catch { repUserDropdown?.classList.add('hidden'); }
}, 300);
repUserSearchEl?.addEventListener('input', e => debouncedRepUserSearch(e.target.value));
document.getElementById('reportClearUser')?.addEventListener('click', () => {
  reportSelectedUserId = null;
  document.getElementById('reportSelectedUser').classList.add('hidden');
  document.getElementById('loadUserReportBtn').disabled = true;
  document.getElementById('exportUserReportCsvBtn').disabled = true;
  document.getElementById('userReportContent').classList.add('hidden');
  document.getElementById('userReportEmpty').classList.remove('hidden');
});

document.getElementById('loadUserReportBtn')?.addEventListener('click', async () => {
  if (!reportSelectedUserId) return;
  const content = document.getElementById('userReportContent');
  const empty   = document.getElementById('userReportEmpty');
  content.classList.add('hidden');
  empty.classList.add('hidden');
  try {
    const [userRes, txRes, cmpRes] = await api.getUserReport(reportSelectedUserId);
    const u   = userRes.user || userRes;
    const acc = u.account || {};
    const txs = txRes.transactions || txRes.data || [];
    const cmp = cmpRes?.user || cmpRes || {};

    // Stats
    document.getElementById('repAvatar').textContent = (u.full_name || '?')[0].toUpperCase();
    document.getElementById('repName').textContent = u.full_name || '—';
    document.getElementById('repMeta').textContent = `${u.email || '—'} · ${u.phone || '—'} · ID ${u.id}`;
    document.getElementById('repKycBadge').innerHTML = kycBadge(u.kyc_status);
    document.getElementById('repRoleBadge').innerHTML = roleBadge(u.role);
    document.getElementById('repBalance').textContent = acc.balance != null ? fmtMoney(acc.balance) : '—';
    document.getElementById('repAccount').textContent = acc.account_number || '—';
    document.getElementById('repCardCount').textContent = u.card_count != null ? u.card_count : '—';
    document.getElementById('repTxCount').textContent = txs.length;

    const payouts = txs.filter(t => t.tx_type === 'payout');
    document.getElementById('repPayoutCount').textContent = payouts.length;
    document.getElementById('repPayoutSum').textContent = fmtMoney(payouts.reduce((s, t) => s + Math.abs(t.amount || 0), 0));

    // TX table
    document.getElementById('repTxBody').innerHTML = txs.slice(0, 100).map(t =>
      `<tr>
        <td>${fmt(t.created_at)}</td>
        <td>${txTypeBadge(t.tx_type)}</td>
        <td style="font-weight:600">${fmtMoney(t.amount)}</td>
        <td style="color:var(--text-muted);font-size:.82rem">${escHtml(t.description || '—')}</td>
      </tr>`
    ).join('') || '<tr><td colspan="4" style="color:var(--text-muted)">Транзакцій не знайдено</td></tr>';

    content.classList.remove('hidden');
    document.getElementById('exportUserReportCsvBtn').disabled = false;
    // Store for export
    window._userReportData = { u, acc, txs, cmp };
  } catch (err) {
    empty.textContent = `Помилка: ${err.message}`;
    empty.classList.remove('hidden');
  }
});

document.getElementById('exportUserReportCsvBtn')?.addEventListener('click', () => {
  const d = window._userReportData;
  if (!d) return;
  const { u, acc, txs } = d;
  let csv = 'Дата,Тип,Сума,Опис\n';
  txs.forEach(t => {
    csv += `"${fmt(t.created_at)}","${t.tx_type}","${t.amount}","${(t.description || '').replace(/"/g, '""')}"\n`;
  });
  const header = `"Звіт по користувачу: ${u.full_name}","Рахунок: ${acc.account_number || '—'}","Баланс: ${acc.balance}"\n\n`;
  downloadCsv(`report_user_${u.id}.csv`, header + csv);
});

// Global report
document.getElementById('loadGlobalReportBtn')?.addEventListener('click', async () => {
  const from = document.getElementById('repGlobalFrom').value;
  const to   = document.getElementById('repGlobalTo').value;
  const content = document.getElementById('globalReportContent');
  const empty   = document.getElementById('globalReportEmpty');
  content.classList.add('hidden');
  empty.textContent = 'Завантаження…';
  empty.classList.remove('hidden');
  try {
    const res = await api.getGlobalReport({ from_date: from, to_date: to });
    const txs = res.transactions || res.data || [];
    globalReportRows = txs;

    const volume = txs.reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    const byType = {};
    txs.forEach(t => {
      const tp = t.tx_type || 'other';
      byType[tp] = byType[tp] || { count: 0, sum: 0 };
      byType[tp].count++;
      byType[tp].sum += Math.abs(t.amount || 0);
    });
    const payouts = byType['payout'] || { count: 0, sum: 0 };
    const dons    = byType['donation'] || { count: 0, sum: 0 };

    document.getElementById('grepTxCount').textContent = txs.length;
    document.getElementById('grepVolume').textContent   = fmtMoney(volume);
    document.getElementById('grepPayoutCount').textContent = payouts.count;
    document.getElementById('grepPayoutSum').textContent   = fmtMoney(payouts.sum);
    document.getElementById('grepDonCount').textContent    = dons.count;
    document.getElementById('grepDonSum').textContent      = fmtMoney(dons.sum);

    // Breakdown table
    document.getElementById('grepBreakdownBody').innerHTML = Object.entries(byType)
      .sort((a, b) => b[1].sum - a[1].sum)
      .map(([tp, v]) => {
        const share = volume > 0 ? ((v.sum / volume) * 100).toFixed(1) + '%' : '—';
        return `<tr>
          <td>${txTypeBadge(tp)}</td>
          <td>${v.count}</td>
          <td>${fmtMoney(v.sum)}</td>
          <td>${share}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" style="color:var(--text-muted)">Немає даних</td></tr>';

    // Top accounts by volume
    const byAcc = {};
    txs.forEach(t => {
      const accNum = t.account_number || t.from_account || t.to_account || '—';
      byAcc[accNum] = byAcc[accNum] || { count: 0, vol: 0 };
      byAcc[accNum].count++;
      byAcc[accNum].vol += Math.abs(t.amount || 0);
    });
    document.getElementById('grepTopBody').innerHTML = Object.entries(byAcc)
      .sort((a, b) => b[1].vol - a[1].vol)
      .slice(0, 20)
      .map(([acc, v]) => `<tr>
        <td><code style="font-size:.78rem">${escHtml(acc)}</code></td>
        <td>${v.count}</td>
        <td>${fmtMoney(v.vol)}</td>
      </tr>`).join('') || '<tr><td colspan="3" style="color:var(--text-muted)">Немає даних</td></tr>';

    empty.classList.add('hidden');
    content.classList.remove('hidden');
    document.getElementById('exportGlobalCsvBtn').disabled = false;
  } catch (err) {
    empty.textContent = `Помилка: ${err.message}`;
    empty.classList.remove('hidden');
  }
});

document.getElementById('exportGlobalCsvBtn')?.addEventListener('click', () => {
  if (!globalReportRows.length) return;
  let csv = 'Дата,Тип,Сума,Опис,Рахунок\n';
  globalReportRows.forEach(t => {
    csv += `"${fmt(t.created_at)}","${t.tx_type}","${t.amount}","${(t.description || '').replace(/"/g, '""')}","${t.account_number || t.from_account || ''}"\n`;
  });
  const from = document.getElementById('repGlobalFrom').value;
  const to   = document.getElementById('repGlobalTo').value;
  downloadCsv(`global_report_${from}_${to}.csv`, csv);
});

/* Universal download — works in Telegram WebView, iOS Safari, desktop browsers.
   Blob + anchor is blocked in TG WebView; data: URI works everywhere. */
function triggerDownload(filename, dataUrl) {
  // Try anchor click first (works in Chrome/Firefox desktop)
  try {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 500);
  } catch {
    // Fallback: open in new tab (Telegram WebView, some mobile browsers)
    window.open(dataUrl, '_blank');
  }
}

function downloadCsv(filename, content) {
  // data: URI with BOM for Excel — works in Telegram WebView where blob: URLs are blocked
  const encoded = encodeURIComponent('\ufeff' + content);
  triggerDownload(filename, `data:text/csv;charset=utf-8,${encoded}`);
}

function downloadHtml(filename, content) {
  const encoded = encodeURIComponent(content);
  triggerDownload(filename, `data:text/html;charset=utf-8,${encoded}`);
}

/* ══════════════════════════════════════════════
   BALANCES PAGE
══════════════════════════════════════════════ */
function loadBalancesPage() {
  balSelectedIds.clear();
  balOffset = 0;
  loadBalances();
}

function balApplyFilters(rows) {
  const search = (document.getElementById('balSearch')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('balFilter')?.value || 'all';
  const sort   = document.getElementById('balSort')?.value || 'balance_desc';
  if (search) rows = rows.filter(u =>
    (u.full_name || '').toLowerCase().includes(search) ||
    (u.account?.account_number || '').toLowerCase().includes(search)
  );
  if (filter === 'positive') rows = rows.filter(u => (u.account?.balance || 0) > 0);
  if (filter === 'zero')     rows = rows.filter(u => (u.account?.balance || 0) === 0);
  if (filter === 'negative') rows = rows.filter(u => (u.account?.balance || 0) < 0);
  rows = [...rows].sort((a, b) => {
    if (sort === 'balance_desc') return (b.account?.balance || 0) - (a.account?.balance || 0);
    if (sort === 'balance_asc')  return (a.account?.balance || 0) - (b.account?.balance || 0);
    if (sort === 'name_asc') return (a.full_name || '').localeCompare(b.full_name || '', 'uk');
    return 0;
  });
  return rows;
}

async function loadBalances() {
  const body  = document.getElementById('balancesBody');
  const empty = document.getElementById('balancesEmpty');
  body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Завантаження…</td></tr>';
  empty.classList.add('hidden');
  try {
    const res = await api.listAccounts({ limit: 500 });
    balAllRows = res.users || res.data || [];

    // Stats
    const totalBal = balAllRows.reduce((s, u) => s + (u.account?.balance || 0), 0);
    const maxBal   = balAllRows.reduce((m, u) => Math.max(m, u.account?.balance || 0), 0);
    document.getElementById('balStatUsers').textContent = balAllRows.length;
    document.getElementById('balStatTotal').textContent = fmtMoney(totalBal);
    document.getElementById('balStatZero').textContent  = balAllRows.filter(u => (u.account?.balance || 0) === 0).length;
    document.getElementById('balStatNeg').textContent   = balAllRows.filter(u => (u.account?.balance || 0) < 0).length;
    document.getElementById('balStatMax').textContent   = fmtMoney(maxBal);
    document.getElementById('balStatAvg').textContent   = balAllRows.length ? fmtMoney(totalBal / balAllRows.length) : '—';

    renderBalTable();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" style="color:var(--red)">${escHtml(err.message)}</td></tr>`;
  }
}

function renderBalTable() {
  const body  = document.getElementById('balancesBody');
  const empty = document.getElementById('balancesEmpty');
  balFilteredRows = balApplyFilters(balAllRows);
  const page = balFilteredRows.slice(balOffset, balOffset + BAL_LIMIT);
  renderBalPagination(balFilteredRows.length, balOffset, BAL_LIMIT);
  updateBalBulkBar();
  if (!page.length) { body.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  body.innerHTML = page.map(u => {
    const bal = u.account?.balance ?? 0;
    const balClass = bal < 0 ? 'style="color:var(--red);font-weight:700"' : bal === 0 ? 'style="color:var(--text-muted)"' : 'style="font-weight:600"';
    const accNum = u.account?.account_number ? `<code style="font-size:.78rem">${escHtml(u.account.account_number)}</code>` : '—';
    const checked = balSelectedIds.has(u.id) ? 'checked' : '';
    return `<tr class="${balSelectedIds.has(u.id) ? 'bal-selected' : ''}">
      <td><input type="checkbox" class="bal-chk" data-uid="${u.id}" data-bal="${bal}" ${checked} /></td>
      <td>${escHtml(u.full_name || '—')}</td>
      <td>${accNum}</td>
      <td ${balClass}>${fmtMoney(bal)}</td>
      <td>${roleBadge(u.role)}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn-table" onclick="balZeroOne(${u.id},'${escHtml(u.full_name||'')}',${bal})">Обнулити</button>
        <button class="btn-table" onclick="balAdjustOne(${u.id},'${escHtml(u.full_name||'')}')">Коригування</button>
      </td>
    </tr>`;
  }).join('');

  body.querySelectorAll('.bal-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const uid = Number(chk.dataset.uid);
      chk.checked ? balSelectedIds.add(uid) : balSelectedIds.delete(uid);
      const row = chk.closest('tr');
      row.classList.toggle('bal-selected', chk.checked);
      updateBalBulkBar();
    });
  });
}

function renderBalPagination(total, offset, limit) {
  const el = document.getElementById('balancesPagination');
  if (!el) return;
  const pages = Math.ceil(total / limit);
  const cur   = Math.floor(offset / limit);
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="page-btn${i === cur ? ' active' : ''}" data-bpage="${i}">${i + 1}</button>`
  ).join('');
  el.querySelectorAll('[data-bpage]').forEach(btn => {
    btn.addEventListener('click', () => { balOffset = parseInt(btn.dataset.bpage) * limit; renderBalTable(); });
  });
}

function updateBalBulkBar() {
  const n = balSelectedIds.size;
  document.getElementById('balBulkCount').textContent = `Обрано: ${n}`;
  document.getElementById('balBulkZeroBtn').disabled = n === 0;
  document.getElementById('balBulkAddBtn').disabled  = n === 0;
  document.getElementById('balBulkSubBtn').disabled  = n === 0;
}

window.balZeroOne = async function(userId, name, bal) {
  if (bal === 0) { showToast('Баланс вже нульовий', 'error'); return; }
  if (!confirm(`Обнулити баланс ${name}?\nПоточний: ${fmtMoney(bal)}`)) return;
  try {
    await api.adjustUserBalance(userId, { amount: -bal, reason: 'manual zero-out' });
    showToast(`Баланс ${name} обнулено`);
    loadBalances();
  } catch (err) { showToast(err.message, 'error'); }
};

window.balAdjustOne = async function(userId, name) {
  const s = prompt(`Коригування балансу: ${name}\nДодатня сума — поповнення, від'ємна — списання:`);
  if (s === null) return;
  const amount = parseFloat(s.replace(',', '.'));
  if (isNaN(amount) || amount === 0) { showToast('Невірна сума', 'error'); return; }
  const reason = prompt('Причина:') || 'manual adjust';
  try {
    await api.adjustUserBalance(userId, { amount, reason });
    showToast('Баланс скориговано');
    loadBalances();
  } catch (err) { showToast(err.message, 'error'); }
};

async function balBulkOp(op) {
  if (!balSelectedIds.size) return;
  const msg = document.getElementById('balOpMsg');
  const ids = [...balSelectedIds];
  let amountVal = 0;
  if (op !== 'zero') {
    amountVal = parseFloat((document.getElementById('balBulkAmount')?.value || '0').replace(',', '.'));
    if (isNaN(amountVal) || amountVal <= 0) { showToast('Введіть суму', 'error'); return; }
  }
  const label = op === 'zero' ? 'обнулення' : op === 'add' ? `нарахування ${fmtMoney(amountVal)}` : `списання ${fmtMoney(amountVal)}`;
  if (!confirm(`${op === 'zero' ? 'Обнулити' : 'Застосувати'} ${label} для ${ids.length} рахунків?`)) return;

  msg.textContent = `Обробка 0/${ids.length}…`;
  msg.className = 'form-msg';
  msg.classList.remove('hidden');
  let done = 0, failed = 0;
  for (const uid of ids) {
    const u = balAllRows.find(r => r.id === uid);
    const curBal = u?.account?.balance ?? 0;
    let amount = op === 'zero' ? -curBal : op === 'add' ? amountVal : -amountVal;
    if (op === 'zero' && curBal === 0) { done++; continue; }
    try {
      await api.adjustUserBalance(uid, { amount, reason: `bulk ${op}` });
      done++;
    } catch { failed++; }
    msg.textContent = `Обробка ${done + failed}/${ids.length}…`;
  }
  msg.textContent = `Виконано: ${done} успішно${failed ? `, ${failed} помилок` : ''}.`;
  msg.className = `form-msg ${failed ? 'error' : 'success'}`;
  balSelectedIds.clear();
  loadBalances();
}

document.getElementById('refreshBalancesBtn')?.addEventListener('click', loadBalances);
document.getElementById('balApplyBtn')?.addEventListener('click', () => { balOffset = 0; renderBalTable(); });
document.getElementById('balSearch')?.addEventListener('keydown', e => { if (e.key === 'Enter') { balOffset = 0; renderBalTable(); } });
document.getElementById('balBulkZeroBtn')?.addEventListener('click', () => balBulkOp('zero'));
document.getElementById('balBulkAddBtn')?.addEventListener('click', () => balBulkOp('add'));
document.getElementById('balBulkSubBtn')?.addEventListener('click', () => balBulkOp('sub'));
document.getElementById('balSelectAllBtn')?.addEventListener('click', () => {
  balFilteredRows.forEach(u => balSelectedIds.add(u.id));
  renderBalTable();
});
document.getElementById('balClearSelBtn')?.addEventListener('click', () => {
  balSelectedIds.clear();
  renderBalTable();
});
document.getElementById('balSelectAllChk')?.addEventListener('change', function() {
  balFilteredRows.slice(balOffset, balOffset + BAL_LIMIT).forEach(u =>
    this.checked ? balSelectedIds.add(u.id) : balSelectedIds.delete(u.id)
  );
  renderBalTable();
});
document.getElementById('balExportCsvBtn')?.addEventListener('click', () => {
  if (!balAllRows.length) return;
  let csv = 'ПІБ,Рахунок,Баланс,Роль\n';
  balApplyFilters(balAllRows).forEach(u => {
    csv += `"${u.full_name || ''}","${u.account?.account_number || ''}","${u.account?.balance ?? 0}","${u.role}"\n`;
  });
  downloadCsv('balances_snapshot.csv', csv);
});

/* ══════════════════════════════════════════════
   ANALYTICS PAGE
══════════════════════════════════════════════ */
let analyticsLoaded = false;

async function loadAnalyticsPage() {
  if (analyticsLoaded) return;
  analyticsLoaded = false;
  try {
    // Fetch transactions (up to 2000 for analytics)
    const [txRes, usersRes] = await Promise.all([
      api.listTransactions({ limit: 2000 }),
      api.complianceUsers({ limit: 500 }),
    ]);
    const txs   = txRes.transactions || txRes.data || [];
    const users = usersRes.users || usersRes.data || [];
    renderCalendarHeatmap(txs);
    renderHourDayMatrix(txs);
    renderRiskKycMatrix(users);
    renderTxTypeDowMatrix(txs);
    analyticsLoaded = true;
  } catch (err) {
    document.getElementById('heatmapWrap').innerHTML = `<div style="color:var(--red)">${escHtml(err.message)}</div>`;
  }
}

document.getElementById('refreshAnalyticsBtn')?.addEventListener('click', () => {
  analyticsLoaded = false;
  loadAnalyticsPage();
});

/* ── Calendar Heat Map ── */
function renderCalendarHeatmap(txs) {
  const wrap = document.getElementById('heatmapWrap');
  const legend = document.getElementById('heatmapLegend');
  if (!wrap) return;

  // Aggregate counts by date string YYYY-MM-DD
  const countByDay = {};
  txs.forEach(t => {
    const d = (t.created_at || '').slice(0, 10);
    if (d) countByDay[d] = (countByDay[d] || 0) + 1;
  });

  // Build 52 weeks back from today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msDay = 86400000;
  // Start on the most recent Sunday ≥ 364 days ago
  const startDate = new Date(today.getTime() - 363 * msDay);
  const dayOffset = startDate.getDay(); // 0=Sun
  const gridStart = new Date(startDate.getTime() - dayOffset * msDay);

  const maxVal = Math.max(1, ...Object.values(countByDay));
  const WEEKS  = 54;
  const CELL   = 13;
  const GAP    = 2;
  const LEFT   = 26; // for day labels
  const TOP    = 22; // for month labels
  const W      = LEFT + WEEKS * (CELL + GAP);
  const H      = TOP  + 7   * (CELL + GAP);

  // Legend colors
  const heatColor = (v, max) => {
    if (v === 0) return '#e8ede3';
    const t = Math.pow(v / max, 0.5);
    // Interpolate #b8d4a8 → #2f4a37
    const r = Math.round(184 - t * (184 - 47));
    const g = Math.round(212 - t * (212 - 74));
    const b = Math.round(168 - t * (168 - 55));
    return `rgb(${r},${g},${b})`;
  };

  const DAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const MONTH_NAMES = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];

  let cells = '';
  let monthLabels = '';
  let lastMonth = -1;

  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(gridStart.getTime() + (w * 7 + d) * msDay);
      if (date > today) continue;
      const key   = date.toISOString().slice(0, 10);
      const count = countByDay[key] || 0;
      const color = heatColor(count, maxVal);
      const x = LEFT + w * (CELL + GAP);
      const y = TOP  + d * (CELL + GAP);
      const title = `${key}: ${count} транзакцій`;
      cells += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${color}"><title>${title}</title></rect>`;

      // Month label at first day of month
      const m = date.getMonth();
      if (d === 0 && m !== lastMonth) {
        monthLabels += `<text x="${x}" y="${TOP - 5}" font-size="9" fill="var(--text-muted)" font-family="Manrope,sans-serif">${MONTH_NAMES[m]}</text>`;
        lastMonth = m;
      }
    }
  }

  // Day labels
  const dayLabels = [1, 3, 5].map(d =>
    `<text x="0" y="${TOP + d * (CELL + GAP) + CELL - 3}" font-size="9" fill="var(--text-muted)" font-family="Manrope,sans-serif">${DAY_LABELS[d]}</text>`
  ).join('');

  wrap.innerHTML = `<svg width="${W}" height="${H}" style="display:block">${monthLabels}${dayLabels}${cells}</svg>`;

  // Legend
  const steps = 5;
  legend.innerHTML = Array.from({ length: steps }, (_, i) => {
    const c = heatColor(i / (steps - 1) * maxVal, maxVal);
    return `<div style="width:13px;height:13px;background:${c};border-radius:2px"></div>`;
  }).join('');
}

/* ── Hour × Day Matrix ── */
function renderHourDayMatrix(txs) {
  const el = document.getElementById('hourDayMatrix');
  if (!el) return;

  const DOW = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
  const matrix = Array.from({ length: 24 }, () => new Array(7).fill(0));
  txs.forEach(t => {
    const d = new Date(t.created_at);
    if (isNaN(d)) return;
    matrix[d.getHours()][d.getDay()]++;
  });
  const maxVal = Math.max(1, ...matrix.flat());

  const cellColor = v => {
    if (v === 0) return '#e8ede3';
    const t = Math.pow(v / maxVal, 0.6);
    const r = Math.round(184 - t * 137);
    const g = Math.round(212 - t * 138);
    const b = Math.round(168 - t * 113);
    return `rgb(${r},${g},${b})`;
  };

  let html = '<table class="matrix-table"><thead><tr><th></th>';
  DOW.forEach(d => { html += `<th>${d}</th>`; });
  html += '</tr></thead><tbody>';
  for (let h = 0; h < 24; h++) {
    html += `<tr><td class="matrix-row-label">${String(h).padStart(2,'0')}:00</td>`;
    for (let d = 0; d < 7; d++) {
      const v = matrix[h][d];
      html += `<td class="matrix-cell" style="background:${cellColor(v)}" title="${DOW[d]} ${h}:00 — ${v} транзакцій">${v || ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  el.outerHTML = `<div id="hourDayMatrix">${html}</div>`;
}

/* ── Risk × KYC Matrix ── */
function renderRiskKycMatrix(users) {
  const el = document.getElementById('riskKycMatrix');
  if (!el) return;
  const RISKS = ['low','medium','high','critical'];
  const KYCS  = ['not_started','pending','in_review','verified','rejected'];
  const KYC_LABELS = { not_started:'Не розпочато', pending:'Очікує', in_review:'На перевірці', verified:'Верифіковано', rejected:'Відхилено' };
  const RISK_LABELS = { low:'Low', medium:'Medium', high:'High', critical:'Critical' };

  const matrix = {};
  RISKS.forEach(r => { matrix[r] = {}; KYCS.forEach(k => { matrix[r][k] = 0; }); });
  users.forEach(u => {
    const r = u.risk_level || 'low';
    const k = u.kyc_status || 'not_started';
    if (matrix[r] && matrix[r][k] !== undefined) matrix[r][k]++;
  });
  const maxVal = Math.max(1, ...RISKS.flatMap(r => KYCS.map(k => matrix[r][k])));

  const RISK_COLORS = { low:'#d1fae5', medium:'#fef9c3', high:'#fed7aa', critical:'#fecaca' };
  const RISK_TEXT   = { low:'#065f46', medium:'#713f12', high:'#7c2d12', critical:'#7f1d1d' };

  let html = '<table class="matrix-table"><thead><tr><th>Ризик \\ KYC</th>';
  KYCS.forEach(k => { html += `<th>${KYC_LABELS[k]}</th>`; });
  html += '<th>Всього</th></tr></thead><tbody>';
  RISKS.forEach(r => {
    const rowTotal = KYCS.reduce((s, k) => s + matrix[r][k], 0);
    html += `<tr><td class="matrix-row-label" style="background:${RISK_COLORS[r]};color:${RISK_TEXT[r]};font-weight:600">${RISK_LABELS[r]}</td>`;
    KYCS.forEach(k => {
      const v = matrix[r][k];
      const intensity = v / maxVal;
      const alpha = v === 0 ? 0 : 0.08 + intensity * 0.6;
      html += `<td class="matrix-cell" style="background:rgba(47,74,55,${alpha.toFixed(2)})" title="${RISK_LABELS[r]} / ${KYC_LABELS[k]}: ${v}">${v || ''}</td>`;
    });
    html += `<td class="matrix-cell-total">${rowTotal}</td></tr>`;
  });
  // Column totals
  html += '<tr><td class="matrix-row-label" style="font-weight:700">Всього</td>';
  KYCS.forEach(k => {
    const colTotal = RISKS.reduce((s, r) => s + matrix[r][k], 0);
    html += `<td class="matrix-cell-total">${colTotal}</td>`;
  });
  html += `<td class="matrix-cell-total" style="font-weight:700">${users.length}</td></tr>`;
  html += '</tbody></table>';
  el.outerHTML = `<div id="riskKycMatrix">${html}</div>`;
}

/* ── Tx Type × Day-of-Week Matrix ── */
function renderTxTypeDowMatrix(txs) {
  const el = document.getElementById('txTypeDowMatrix');
  if (!el) return;
  const TYPES = ['payout','transfer','deposit','withdrawal','donation'];
  const TYPE_LABELS = { payout:'Виплата', transfer:'Переказ', deposit:'Депозит', withdrawal:'Зняття', donation:'Донат' };
  const DOW = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];

  const matrix = {};
  TYPES.forEach(tp => { matrix[tp] = new Array(7).fill(0); });
  const other = new Array(7).fill(0);
  txs.forEach(t => {
    const d = new Date(t.created_at).getDay();
    if (isNaN(d)) return;
    if (matrix[t.tx_type]) matrix[t.tx_type][d]++;
    else other[d]++;
  });
  const allVals = [...TYPES.flatMap(tp => matrix[tp]), ...other];
  const maxVal  = Math.max(1, ...allVals);

  const cellColor = v => {
    if (!v) return '#e8ede3';
    const t = Math.pow(v / maxVal, 0.55);
    const r = Math.round(184 - t * 137);
    const g = Math.round(212 - t * 138);
    const b = Math.round(168 - t * 113);
    return `rgb(${r},${g},${b})`;
  };

  let html = '<table class="matrix-table"><thead><tr><th>Тип \\ День</th>';
  DOW.forEach(d => { html += `<th>${d}</th>`; });
  html += '<th>Всього</th></tr></thead><tbody>';

  [...TYPES, '__other'].forEach(tp => {
    const row   = tp === '__other' ? other : matrix[tp];
    const label = tp === '__other' ? 'Інші' : TYPE_LABELS[tp];
    if (row.every(v => v === 0)) return;
    const rowTotal = row.reduce((s, v) => s + v, 0);
    html += `<tr><td class="matrix-row-label">${label}</td>`;
    row.forEach((v, d) => {
      html += `<td class="matrix-cell" style="background:${cellColor(v)}" title="${label} ${DOW[d]}: ${v}">${v || ''}</td>`;
    });
    html += `<td class="matrix-cell-total">${rowTotal}</td></tr>`;
  });
  // Col totals
  html += '<tr><td class="matrix-row-label" style="font-weight:700">Всього</td>';
  for (let d = 0; d < 7; d++) {
    const t = TYPES.reduce((s, tp) => s + (matrix[tp][d] || 0), 0) + other[d];
    html += `<td class="matrix-cell-total">${t}</td>`;
  }
  html += `<td class="matrix-cell-total" style="font-weight:700">${txs.length}</td></tr>`;
  html += '</tbody></table>';
  el.outerHTML = `<div id="txTypeDowMatrix">${html}</div>`;
}

/* ══════════════════════════════════════════════
   DOCUMENTS — CRYPTO HELPERS
══════════════════════════════════════════════ */
const SIG_PRIV_KEY = 'army_sign_priv_jwk';
const SIG_PUB_KEY  = 'army_sign_pub_jwk';
const SIG_KEY_DATE = 'army_sign_key_date';
const DOCS_STORE   = 'army_admin_docs';

function buf2hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function hex2buf(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return a.buffer;
}

async function cryptoGenerateKeyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub  = await crypto.subtle.exportKey('jwk', kp.publicKey);
  localStorage.setItem(SIG_PRIV_KEY, JSON.stringify(priv));
  localStorage.setItem(SIG_PUB_KEY,  JSON.stringify(pub));
  localStorage.setItem(SIG_KEY_DATE, new Date().toISOString());
  return kp;
}

async function cryptoGetSignKey() {
  const s = localStorage.getItem(SIG_PRIV_KEY);
  if (!s) return null;
  return crypto.subtle.importKey('jwk', JSON.parse(s),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function cryptoGetVerifyKey(jwkOverride) {
  const s = jwkOverride || localStorage.getItem(SIG_PUB_KEY);
  if (!s) return null;
  const parsed = typeof s === 'string' ? JSON.parse(s) : s;
  return crypto.subtle.importKey('jwk', parsed,
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

async function cryptoSign(content) {
  const key = await cryptoGetSignKey();
  if (!key) throw new Error('Ключ не знайдено. Згенеруйте ключ у вкладці «Ключ підпису».');
  const encoded = new TextEncoder().encode(content);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoded);
  return buf2hex(sig);
}

async function cryptoVerify(content, sigHex, pubJwk) {
  try {
    const key = await cryptoGetVerifyKey(pubJwk);
    if (!key) return false;
    const encoded = new TextEncoder().encode(content);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, hex2buf(sigHex), encoded);
  } catch { return false; }
}

async function cryptoFingerprint() {
  const s = localStorage.getItem(SIG_PUB_KEY);
  if (!s) return null;
  const buf  = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return buf2hex(hash).slice(0, 16).toUpperCase().match(/.{2}/g).join(':');
}

/* ── Doc storage ── */
function docsLoad() {
  try { return JSON.parse(localStorage.getItem(DOCS_STORE) || '[]'); } catch { return []; }
}
function docsSave(docs) {
  localStorage.setItem(DOCS_STORE, JSON.stringify(docs));
}
function docsNextId() {
  const docs = docsLoad();
  const max  = docs.reduce((m, d) => Math.max(m, parseInt(d.seq || 0)), 0);
  return max + 1;
}

/* ══════════════════════════════════════════════
   DOCUMENTS — TEMPLATES
══════════════════════════════════════════════ */
const DOC_TYPE_LABELS = {
  payout_order:    'Наказ про виплату',
  balance_cert:    'Довідка про рахунок',
  payout_register: 'Реєстр виплат',
  compliance_act:  'Акт перевірки KYC/AML',
};

const DOC_TEMPLATES = {
  payout_order: {
    fields: [
      { id:'doc_number', label:'Номер наказу', type:'text', placeholder:'001' },
      { id:'date', label:'Дата', type:'date' },
      { id:'city', label:'Місто', type:'text', placeholder:'Київ' },
      { id:'unit', label:'Організація / відділ', type:'text', placeholder:'ТОВ "Назва" / Відділ' },
      { id:'recipient', label:'Отримувач (ПІБ)', type:'text' },
      { id:'recipient_rank', label:'Посада', type:'text', placeholder:'Менеджер' },
      { id:'amount', label:'Сума (грн)', type:'number', placeholder:'0.00' },
      { id:'account', label:'Рахунок IBAN', type:'text', placeholder:'UA00000000000000000000000000' },
      { id:'purpose', label:'Призначення виплати', type:'text', placeholder:'Виплата' },
      { id:'basis', label:'Підстава', type:'text', placeholder:'Розпорядження від ...' },
      { id:'commander', label:'Керівник (ПІБ, посада)', type:'text' },
    ],
    renderHtml(f, sig) {
      return docHtmlWrap(`
        <div class="doc-header-line">Наказ № ${esc(f.doc_number)} від ${fmtDocDate(f.date)} р., ${esc(f.city)}</div>
        <h1 class="doc-title">НАКАЗ</h1>
        <div class="doc-subtitle">Про нарахування грошових коштів</div>
        <div class="doc-unit">${esc(f.unit)}</div>

        <div class="doc-body">
          <p>На підставі ${esc(f.basis)}, відповідно до встановленого порядку виплати грошових коштів,</p>
          <p style="text-align:center;font-weight:700;margin:18px 0">НАКАЗУЮ:</p>
          <p>1. Здійснити нарахування грошових коштів у розмірі <strong>${fmtDocMoney(f.amount)} (${numToWords(f.amount)} гривень)</strong> на рахунок:</p>
          <table class="doc-inner-table">
            <tr><td>Отримувач:</td><td><strong>${esc(f.recipient)}</strong>${f.recipient_rank ? ', ' + esc(f.recipient_rank) : ''}</td></tr>
            <tr><td>Рахунок:</td><td><code>${esc(f.account)}</code></td></tr>
            <tr><td>Призначення:</td><td>${esc(f.purpose)}</td></tr>
          </table>
          <p>2. Контроль за виконанням наказу покладаю на себе.</p>
        </div>
        ${docSignatureBlock(f.commander, sig)}
      `, `Наказ №${f.doc_number} — ${f.purpose}`, sig);
    },
  },

  balance_cert: {
    fields: [
      { id:'cert_number', label:'Номер довідки', type:'text', placeholder:'Д-001' },
      { id:'date', label:'Дата видачі', type:'date' },
      { id:'city', label:'Місто', type:'text', placeholder:'Київ' },
      { id:'unit', label:'Організація / установа', type:'text', placeholder:'ТОВ "Назва" / Відділ' },
      { id:'recipient', label:'Кому видано (ПІБ)', type:'text' },
      { id:'recipient_rank', label:'Посада', type:'text' },
      { id:'account_number', label:'Номер рахунку', type:'text' },
      { id:'balance', label:'Залишок (грн)', type:'number', placeholder:'0.00' },
      { id:'kyc_status', label:'Статус верифікації', type:'text', placeholder:'Верифіковано' },
      { id:'cert_purpose', label:'Довідка надається для', type:'text', placeholder:'надання за місцем вимоги' },
      { id:'issuer', label:'Видав (ПІБ, посада)', type:'text' },
    ],
    renderHtml(f, sig) {
      return docHtmlWrap(`
        <div class="doc-header-line">Довідка № ${esc(f.cert_number)} від ${fmtDocDate(f.date)} р., ${esc(f.city)}</div>
        <h1 class="doc-title">ДОВІДКА</h1>
        <div class="doc-subtitle">Про стан рахунку у платіжній системі Army Bank</div>
        <div class="doc-unit">${esc(f.unit)}</div>
        <div class="doc-body">
          <p>Цим підтверджується, що <strong>${esc(f.recipient)}</strong>${f.recipient_rank ? ', ' + esc(f.recipient_rank) : ''}, є власником рахунку в системі Army Bank зі наступними характеристиками:</p>
          <table class="doc-inner-table">
            <tr><td>Номер рахунку:</td><td><code>${esc(f.account_number)}</code></td></tr>
            <tr><td>Залишок на дату видачі:</td><td><strong>${fmtDocMoney(f.balance)} грн</strong></td></tr>
            <tr><td>Статус верифікації (KYC):</td><td>${esc(f.kyc_status)}</td></tr>
          </table>
          <p>Довідка надається для ${esc(f.cert_purpose)}.</p>
          <p>Дійсна протягом 30 календарних днів з дати видачі.</p>
        </div>
        ${docSignatureBlock(f.issuer, sig)}
      `, `Довідка №${f.cert_number}`, sig);
    },
  },

  payout_register: {
    fields: [
      { id:'reg_number', label:'Номер реєстру', type:'text', placeholder:'Р-001' },
      { id:'date', label:'Дата складання', type:'date' },
      { id:'city', label:'Місто', type:'text', placeholder:'Київ' },
      { id:'unit', label:'Організація / відділ', type:'text', placeholder:'ТОВ "Назва" / Відділ' },
      { id:'period_from', label:'Звітний період від', type:'date' },
      { id:'period_to', label:'Звітний період до', type:'date' },
      { id:'payout_type', label:'Тип виплат', type:'text', placeholder:'Виплати' },
      { id:'total_amount', label:'Загальна сума (грн)', type:'number', step:'0.01', min:'0', readonly:true },
      { id:'total_count', label:'Кількість одержувачів', type:'number', step:'1', min:'0', readonly:true },
      { id:'responsible', label:'Відповідальний (ПІБ, посада)', type:'text' },
      { id:'commander', label:'Керівник (ПІБ, посада)', type:'text' },
    ],
    renderHtml(f, sig) {
      return docHtmlWrap(`
        <div class="doc-header-line">Реєстр № ${esc(f.reg_number)} від ${fmtDocDate(f.date)} р., ${esc(f.city)}</div>
        <h1 class="doc-title">ЗВЕДЕНИЙ РЕЄСТР</h1>
        <div class="doc-subtitle">Виплат грошових коштів</div>
        <div class="doc-unit">${esc(f.unit)}</div>
        <div class="doc-body">
          <table class="doc-inner-table">
            <tr><td>Звітний період:</td><td>${fmtDocDate(f.period_from)} — ${fmtDocDate(f.period_to)}</td></tr>
            <tr><td>Тип виплат:</td><td>${esc(f.payout_type)}</td></tr>
            <tr><td>Кількість одержувачів:</td><td><strong>${esc(f.total_count)} осіб</strong></td></tr>
            <tr><td>Загальна сума:</td><td><strong>${fmtDocMoney(f.total_amount)} грн</strong></td></tr>
          </table>
          ${buildPayoutRegisterRowsHtml(f.register_items)}
          <p>Зведений реєстр складено на підставі даних платіжної системи Army Bank. Відповідальний за складання: ${esc(f.responsible)}.</p>
          <p>Реєстр підлягає зберіганню у відповідності до вимог документообігу організації.</p>
          ${f.register_generated_at ? '<p style="color:#666;font-size:10pt">Автозаповнення виконано: ' + esc(fmt(f.register_generated_at)) + '</p>' : ''}
        </div>
        ${docSignatureBlock(f.commander, sig)}
      `, `Реєстр №${f.reg_number}`, sig);
    },
  },

  compliance_act: {
    fields: [
      { id:'act_number', label:'Номер акту', type:'text', placeholder:'А-001' },
      { id:'date', label:'Дата', type:'date' },
      { id:'city', label:'Місто', type:'text', placeholder:'Київ' },
      { id:'unit', label:'Організація / відділ', type:'text', placeholder:'ТОВ "Назва" / Відділ' },
      { id:'subject', label:'Суб\'єкт перевірки (ПІБ)', type:'text' },
      { id:'subject_id', label:'ID користувача системи', type:'text' },
      { id:'kyc_status', label:'KYC статус', type:'text', placeholder:'verified' },
      { id:'risk_level', label:'Рівень ризику', type:'text', placeholder:'low' },
      { id:'aml_flag', label:'AML прапор', type:'text', placeholder:'відсутній' },
      { id:'conclusion', label:'Висновок', type:'textarea', placeholder:'На підставі проведеної перевірки…' },
      { id:'inspector', label:'Перевіряючий (ПІБ, посада)', type:'text' },
    ],
    renderHtml(f, sig) {
      return docHtmlWrap(`
        <div class="doc-header-line">Акт № ${esc(f.act_number)} від ${fmtDocDate(f.date)} р., ${esc(f.city)}</div>
        <h1 class="doc-title">АКТ</h1>
        <div class="doc-subtitle">Перевірки відповідності KYC/AML</div>
        <div class="doc-unit">${esc(f.unit)}</div>
        <div class="doc-body">
          <table class="doc-inner-table">
            <tr><td>Суб'єкт перевірки:</td><td><strong>${esc(f.subject)}</strong> (ID: ${esc(f.subject_id)})</td></tr>
            <tr><td>KYC статус:</td><td>${esc(f.kyc_status)}</td></tr>
            <tr><td>Рівень ризику AML:</td><td>${esc(f.risk_level)}</td></tr>
            <tr><td>AML прапор:</td><td>${esc(f.aml_flag)}</td></tr>
          </table>
          <p style="font-weight:600;margin-top:14px">Висновок:</p>
          <p>${esc(f.conclusion).replace(/\n/g, '<br>')}</p>
        </div>
        ${docSignatureBlock(f.inspector, sig)}
      `, `Акт №${f.act_number}`, sig);
    },
  },
};

/* ── Recipients selection ── */
const _docSelectedClients = new Set(); // { id, name }
let _docAllClients = [];

document.querySelectorAll('input[name="docRecipient"]').forEach(r => {
  r.addEventListener('change', function() {
    const wrap = document.getElementById('docClientSearchWrap');
    if (this.value === 'select') {
      wrap?.classList.remove('hidden');
      if (!_docAllClients.length) _loadAllClients();
    } else {
      wrap?.classList.add('hidden');
    }
  });
});

async function _loadAllClients() {
  try {
    const res = await api.listUsers({ limit: 500 });
    _docAllClients = (Array.isArray(res) ? res : (res.data || []));
    _renderDocClientList(_docAllClients);
  } catch(e) { console.warn('clients:', e.message); }
}

function searchDocClients() {
  const q = (document.getElementById('docClientSearch')?.value || '').toLowerCase().trim();
  const filtered = q
    ? _docAllClients.filter(u => (u.full_name||'').toLowerCase().includes(q) || (u.phone||'').includes(q) || (u.email||'').toLowerCase().includes(q))
    : _docAllClients;
  _renderDocClientList(filtered);
}

function _renderDocClientList(users) {
  const list = document.getElementById('docClientPickList');
  if (!list) return;
  if (!users.length) { list.innerHTML = '<div style="padding:8px;opacity:.5">Не знайдено</div>'; return; }
  list.innerHTML = users.map(u => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;border-radius:5px">
      <input type="checkbox" value="${u.id}" ${_docSelectedClients.has(u.id) ? 'checked' : ''}
        onchange="_docClientToggle(${u.id}, ${JSON.stringify(escHtml(u.full_name || u.phone || '#'+u.id))}, this.checked)">
      <span>${escHtml(u.full_name || '—')} <span style="opacity:.45;font-size:.8rem">${escHtml(u.phone||'')} #${u.id}</span></span>
    </label>`).join('');
}

function _docClientToggle(id, name, checked) {
  if (checked) _docSelectedClients.add(id);
  else _docSelectedClients.delete(id);
  _updateSelectedDisplay();
}

function _updateSelectedDisplay() {
  const el = document.getElementById('docSelectedClientsDisplay');
  if (!el) return;
  const count = _docSelectedClients.size;
  el.textContent = count ? `Вибрано: ${count} клієнт(ів)` : 'Нікого не вибрано';
}

function _getDocRecipients() {
  const mode = document.querySelector('input[name="docRecipient"]:checked')?.value || 'all';
  if (mode === 'all') return { mode: 'all', user_ids: [] };
  return { mode: 'select', user_ids: [..._docSelectedClients] };
}

function _resetDocRecipients() {
  _docSelectedClients.clear();
  document.querySelectorAll('input[name="docRecipient"]').forEach(r => { r.checked = r.value === 'all'; });
  document.getElementById('docClientSearchWrap')?.classList.add('hidden');
  document.getElementById('docClientSearch') && (document.getElementById('docClientSearch').value = '');
  document.getElementById('docClientPickList') && (document.getElementById('docClientPickList').innerHTML = '');
  _updateSelectedDisplay();
}

function buildPayoutRegisterRowsHtml(itemsRaw) {
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  if (!items.length) {
    return "<p style=\"margin-top:14px;color:#8a6d3b\">За вибраний період виплат не знайдено.</p>";
  }
  let html = "<p style=\"margin-top:16px;font-weight:600\">Деталізація виплат (" + items.length + "):</p>";
  html += "<table class=\"doc-inner-table\"><tr>" +
    "<td style=\"width:6%\">№</td>" +
    "<td style=\"width:16%\">Дата</td>" +
    "<td style=\"width:24%\">Одержувач</td>" +
    "<td style=\"width:18%\">Рахунок</td>" +
    "<td style=\"width:24%\">Тип / опис</td>" +
    "<td style=\"width:12%\">Сума, грн</td>" +
    "</tr>";
  items.forEach((row, idx) => {
    html += "<tr>" +
      "<td>" + (idx + 1) + "</td>" +
      "<td>" + esc(row?.date || "—") + "</td>" +
      "<td>" + esc(row?.user_name || "—") + "</td>" +
      "<td><code>" + esc(row?.account || "—") + "</code></td>" +
      "<td>" + esc(row?.description || row?.tx_type || "Виплата") + "</td>" +
      "<td><strong>" + fmtDocMoney(row?.amount) + "</strong></td>" +
      "</tr>";
  });
  html += "</table>";
  return html;
}

function fmtDocDateShort(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("uk-UA");
  } catch {
    return d;
  }
}

function toIsoDateOrEmpty(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

async function loadPayoutRowsForRegister(fromDate, toDate) {
  const LIMIT = 500;
  const MAX_ROWS = 2000;
  let offset = 0;
  let total = Infinity;
  const all = [];

  while (offset < total && all.length < MAX_ROWS) {
    const res = await api.listPayouts({
      from_date: fromDate,
      to_date: toDate,
      limit: LIMIT,
      offset,
    });
    const rows = res?.data || [];
    total = Number.isFinite(res?.total) ? res.total : (offset + rows.length);
    if (!rows.length) break;
    all.push(...rows);
    offset += LIMIT;
    if (rows.length < LIMIT) break;
  }

  return all;
}

async function enrichDocFields(type, rawFields) {
  const fields = { ...(rawFields || {}) };
  if (type !== "payout_register") return fields;

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const fromDate = toIsoDateOrEmpty(fields.period_from) || monthStartIso;
  const toDate = toIsoDateOrEmpty(fields.period_to) || todayIso;

  let rows = await loadPayoutRowsForRegister(fromDate, toDate);
  const recipients = _getDocRecipients();
  if (recipients.mode === "select" && recipients.user_ids?.length) {
    const selected = new Set(recipients.user_ids.map(v => String(v)));
    rows = rows.filter(r => selected.has(String(r.user_id)));
  }

  const normalizedRows = rows.map(r => ({
    date: fmtDocDateShort(r.created_at),
    user_name: r.user_name || r.full_name || ("Клієнт #" + (r.user_id || "—")),
    account: r.related_account || r.account_number || "",
    description: r.description || txTypeLabel(r.tx_type),
    tx_type: r.tx_type || "payout",
    amount: Math.abs(Number(r.amount || 0)),
  }));

  const totalAmount = normalizedRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const uniqueRecipients = new Set(rows.map(r => String(r.user_id || "")).filter(Boolean)).size;

  fields.period_from = fromDate;
  fields.period_to = toDate;
  fields.payout_type = fields.payout_type || "Виплати (авто з транзакцій)";
  fields.total_amount = totalAmount.toFixed(2);
  fields.total_count = String(uniqueRecipients || 0);
  fields.responsible = fields.responsible || currentAdminUser?.full_name || currentAdminUser?.phone || "Адміністратор Army Bank";
  fields.register_generated_at = new Date().toISOString();
  fields.register_items = normalizedRows;

  return fields;
}

/* ── Doc HTML helpers ── */
function esc(s) { return escHtml(s || ''); }

function fmtDocDate(d) {
  if (!d) return '___';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString('uk-UA', { day:'2-digit', month:'long', year:'numeric' });
  } catch { return d; }
}

function fmtDocMoney(n) {
  if (n == null || n === '') return '0,00';
  return Number(n).toLocaleString('uk-UA', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function numToWords(n) {
  const num = Math.floor(Number(n) || 0);
  if (num === 0) return 'нуль';
  const ones  = ['','одна','дві','три','чотири','п\'ять','шість','сім','вісім','дев\'ять'];
  const teens = ['десять','одинадцять','дванадцять','тринадцять','чотирнадцять','п\'ятнадцять','шістнадцять','сімнадцять','вісімнадцять','дев\'ятнадцять'];
  const tens  = ['','','двадцять','тридцять','сорок','п\'ятдесят','шістдесят','сімдесят','вісімдесят','дев\'яносто'];
  const hunds = ['','сто','двісті','триста','чотириста','п\'ятсот','шістсот','сімсот','вісімсот','дев\'ятсот'];
  const thousands = (n) => {
    if (n === 1) return 'одна тисяча';
    if (n === 2) return 'дві тисячі';
    if (n >= 3 && n <= 4) return `${ones[n]} тисячі`;
    return `${ones[n]} тисяч`;
  };
  let result = '';
  const t = Math.floor(num / 1000);
  const r = num % 1000;
  if (t > 0 && t < 10) result += thousands(t) + ' ';
  else if (t >= 10) result += t + ' тисяч ';
  const h = Math.floor(r / 100);
  const rem = r % 100;
  if (h > 0) result += hunds[h] + ' ';
  if (rem >= 10 && rem <= 19) result += teens[rem - 10];
  else {
    const d = Math.floor(rem / 10);
    const o = rem % 10;
    if (d > 0) result += tens[d] + ' ';
    if (o > 0) result += ones[o];
  }
  return result.trim();
}

function docSignatureBlock(signer, sig) {
  if (sig) {
    // Compute short doc hash fingerprint from signature hex for display
    const hashShort = sig.signature_hex
      ? sig.signature_hex.slice(0,8).toUpperCase().match(/.{2}/g).join(':') + '…' + sig.signature_hex.slice(-8).toUpperCase().match(/.{2}/g).join(':')
      : '—';
    const hexWrapped = sig.signature_hex
      ? sig.signature_hex.match(/.{1,64}/g).join('\n')
      : '—';
    return `
    <div class="doc-cert-block">
      <div class="doc-cert-header">
        <div class="doc-cert-emblem">
          <svg viewBox="0 0 40 40" fill="none" width="36" height="36">
            <polygon points="20,2 37,10 37,30 20,38 3,30 3,10" fill="none" stroke="#2f4a37" stroke-width="1.8"/>
            <polygon points="20,7 32,13 32,27 20,33 8,27 8,13" fill="rgba(47,74,55,.08)" stroke="#2f4a37" stroke-width="1.2"/>
            <path d="M14 20 L18 24 L26 16" stroke="#2f4a37" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </div>
        <div class="doc-cert-title-wrap">
          <div class="doc-cert-title">ЕЛЕКТРОННИЙ ЦИФРОВИЙ ПІДПИС</div>
          <div class="doc-cert-subtitle">Army Bank Admin System · Кваліфікований підпис</div>
        </div>
        <div class="doc-cert-validity">✓&nbsp;ДІЙСНИЙ</div>
      </div>
      <div class="doc-cert-body">
        <div class="doc-cert-row">
          <span class="doc-cert-label">Підписант</span>
          <span class="doc-cert-val"><strong>${esc(sig.signer)}</strong></span>
        </div>
        <div class="doc-cert-row">
          <span class="doc-cert-label">Дата та час підпису</span>
          <span class="doc-cert-val">${esc(sig.signed_at)}</span>
        </div>
        <div class="doc-cert-row">
          <span class="doc-cert-label">Алгоритм підпису</span>
          <span class="doc-cert-val">ECDSA P-256 / SHA-256 (Web Crypto API)</span>
        </div>
        <div class="doc-cert-row">
          <span class="doc-cert-label">Відбиток публічного ключа</span>
          <span class="doc-cert-val"><code class="doc-cert-code">${esc(sig.key_fingerprint)}</code></span>
        </div>
        <div class="doc-cert-row">
          <span class="doc-cert-label">Ідентифікатор підпису</span>
          <span class="doc-cert-val"><code class="doc-cert-code">${hashShort}</code></span>
        </div>
        <div class="doc-cert-row doc-cert-row--hex">
          <span class="doc-cert-label">Значення підпису (ECDSA DER hex)</span>
          <pre class="doc-cert-hex">${hexWrapped}</pre>
        </div>
      </div>
      <div class="doc-cert-footer">
        <span>Для перевірки автентичності документа використовуйте вкладку «Перевірка» в системі Army Bank Admin.</span>
        <span class="doc-cert-watermark">ПІДПИСАНО · ARMY BANK</span>
      </div>
    </div>`;
  }

  // Unsigned — professional placeholder with fields for handwritten signature
  return `
  <div class="doc-sig-unsigned">
    <div class="doc-sig-unsigned-title">МІСЦЕ ДЛЯ ПІДПИСУ</div>
    <div class="doc-sig-unsigned-grid">
      <div class="doc-sig-unsigned-col">
        <div class="doc-sig-unsigned-label">Підписант</div>
        <div class="doc-sig-unsigned-value"><strong>${esc(signer || '____________________________')}</strong></div>
      </div>
      <div class="doc-sig-unsigned-col">
        <div class="doc-sig-unsigned-label">Підпис</div>
        <div class="doc-sig-unsigned-line"></div>
      </div>
      <div class="doc-sig-unsigned-col">
        <div class="doc-sig-unsigned-label">Дата</div>
        <div class="doc-sig-unsigned-line"></div>
      </div>
      <div class="doc-sig-unsigned-col">
        <div class="doc-sig-unsigned-label">М.П.</div>
        <div class="doc-sig-unsigned-stamp"></div>
      </div>
    </div>
    <div class="doc-sig-unsigned-hint">⚠ Документ не містить електронного підпису. Підпишіть документ у системі Army Bank Admin.</div>
  </div>`;
}

function docHtmlWrap(body, title, sig) {
  const sigStyle = sig ? 'border-top:3px solid #2f4a37;' : 'border-top:2px dashed #ccc;';
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8"/>
<title>${escHtml(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Noto Serif',serif;font-size:13pt;color:#111;background:#fff;padding:30mm 20mm;max-width:210mm;margin:0 auto}
  .doc-stamp{text-align:center;margin-bottom:18px}
  .doc-stamp svg{width:48px;height:48px}
  .doc-org{text-align:center;font-size:10pt;color:#444;margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
  .doc-header-line{text-align:center;font-size:9.5pt;color:#666;margin-bottom:12px}
  .doc-title{text-align:center;font-size:16pt;font-weight:700;letter-spacing:.08em;margin-bottom:6px}
  .doc-subtitle{text-align:center;font-size:11pt;margin-bottom:4px}
  .doc-unit{text-align:center;font-size:10pt;color:#555;margin-bottom:20px}
  .doc-body p{margin:10px 0;line-height:1.7;text-align:justify}
  .doc-inner-table{width:100%;border-collapse:collapse;margin:12px 0}
  .doc-inner-table td{padding:5px 8px;border:1px solid #ddd;font-size:11pt;vertical-align:top}
  .doc-inner-table td:first-child{width:38%;font-weight:600;background:#f8f8f8;white-space:nowrap}
  code{font-family:monospace;background:#f3f3f3;padding:1px 4px;border-radius:3px;font-size:.85em}
  /* ── Certificate signature block ── */
  .doc-cert-block{margin-top:40px;border:2px solid #2f4a37;border-radius:8px;overflow:hidden;page-break-inside:avoid}
  .doc-cert-header{display:flex;align-items:center;gap:12px;background:#2f4a37;padding:12px 16px;color:#fff}
  .doc-cert-emblem{flex-shrink:0}
  .doc-cert-emblem svg polygon,.doc-cert-emblem svg path{stroke:#c8a84b!important}
  .doc-cert-emblem svg polygon:nth-child(2){fill:rgba(200,168,75,.15)!important}
  .doc-cert-title-wrap{flex:1}
  .doc-cert-title{font-size:11pt;font-weight:700;letter-spacing:.06em;color:#f5f0e0}
  .doc-cert-subtitle{font-size:8.5pt;color:rgba(245,240,224,.65);margin-top:2px}
  .doc-cert-validity{background:#c8a84b;color:#2f4a37;font-weight:800;font-size:9pt;padding:4px 10px;border-radius:4px;letter-spacing:.04em;white-space:nowrap}
  .doc-cert-body{padding:14px 16px;background:#f8fcf8}
  .doc-cert-row{display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid rgba(47,74,55,.08)}
  .doc-cert-row:last-child{border-bottom:none}
  .doc-cert-row--hex{align-items:flex-start;flex-direction:column;gap:4px}
  .doc-cert-label{font-size:8.5pt;color:#556;font-weight:600;min-width:220px;flex-shrink:0}
  .doc-cert-val{font-size:9.5pt;color:#111}
  .doc-cert-code{font-family:monospace;background:#e8ede8;padding:2px 6px;border-radius:3px;font-size:8.5pt;color:#2f4a37}
  .doc-cert-hex{font-family:monospace;font-size:7.5pt;color:#444;background:#e8ede8;padding:8px;border-radius:4px;word-break:break-all;white-space:pre-wrap;width:100%;margin-top:4px;line-height:1.5}
  .doc-cert-footer{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#edf5ed;font-size:8pt;color:#556;border-top:1px solid rgba(47,74,55,.15)}
  .doc-cert-watermark{font-weight:700;color:rgba(47,74,55,.35);font-size:8pt;letter-spacing:.12em;white-space:nowrap}
  /* ── Unsigned block ── */
  .doc-sig-unsigned{margin-top:40px;border:2px dashed #bbb;border-radius:6px;padding:16px;background:#fafafa}
  .doc-sig-unsigned-title{font-size:9pt;font-weight:700;color:#888;letter-spacing:.08em;margin-bottom:12px;text-align:center}
  .doc-sig-unsigned-grid{display:grid;grid-template-columns:2fr 1fr 1fr 0.8fr;gap:16px;align-items:end}
  .doc-sig-unsigned-col{}
  .doc-sig-unsigned-label{font-size:8pt;color:#999;margin-bottom:4px}
  .doc-sig-unsigned-value{font-size:10pt;color:#333;padding-bottom:4px}
  .doc-sig-unsigned-line{border-bottom:1.5px solid #bbb;height:28px}
  .doc-sig-unsigned-stamp{border:1.5px solid #ccc;border-radius:50%;width:60px;height:60px;margin:0 auto}
  .doc-sig-unsigned-hint{font-size:8pt;color:#b45309;background:#fef9c3;padding:6px 10px;border-radius:4px;margin-top:12px;text-align:center}
  @media print{body{padding:15mm 15mm}@page{size:A4;margin:0}.doc-cert-block{break-inside:avoid}}
</style>
</head>
<body>
<div class="doc-stamp">
  <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polygon points="30,4 56,16 56,44 30,56 4,44 4,16" fill="none" stroke="#c8a84b" stroke-width="2"/>
    <polygon points="30,10 50,20 50,40 30,50 10,40 10,20" fill="rgba(200,168,75,.12)" stroke="#c8a84b" stroke-width="1.5"/>
    <line x1="22" y1="30" x2="38" y2="30" stroke="#c8a84b" stroke-width="2" stroke-linecap="round"/>
    <line x1="30" y1="22" x2="30" y2="38" stroke="#c8a84b" stroke-width="2" stroke-linecap="round"/>
  </svg>
</div>
<div class="doc-org">ARMY BANK — Платіжна система збройних сил</div>
${body}
</body></html>`;
}

/* ══════════════════════════════════════════════
   DOCUMENTS — PAGE LOGIC
══════════════════════════════════════════════ */
let currentDocFields = {};
let currentDocType   = '';
let previewDocId     = null;

function loadDocumentsPage() {
  updateDocKeyStatus().then(() => {
    const hasKey = !!localStorage.getItem(SIG_PRIV_KEY);
    if (!hasKey) {
      docSwitchTab('key');
    } else {
      docSwitchTab('registry');
      renderDocRegistry();
    }
  });
}

function docUpdateNoKeyHint() {
  const hasKey = !!localStorage.getItem(SIG_PRIV_KEY);
  const hint = document.getElementById('docNoKeyHint');
  if (hint) hint.classList.toggle('hidden', hasKey);
}

function docSwitchTab(tab) {
  document.querySelectorAll('[data-doc-tab]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.docTab === tab)
  );
  ['registry','create','key','verify'].forEach(t => {
    const el = document.getElementById(`doc-tab-${t}`);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
}
document.querySelectorAll('[data-doc-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    docSwitchTab(btn.dataset.docTab);
    if (btn.dataset.docTab === 'create') docUpdateNoKeyHint();
    if (btn.dataset.docTab === 'registry') renderDocRegistry();
  });
});

/* ── Registry ── */
function renderDocRegistry() {
  const body  = document.getElementById('docRegistryBody');
  const empty = document.getElementById('docRegistryEmpty');
  if (!body) return;
  let docs = docsLoad();
  const search = (document.getElementById('docRegSearch')?.value || '').toLowerCase();
  const type   = document.getElementById('docRegType')?.value   || '';
  const status = document.getElementById('docRegStatus')?.value || '';
  if (search) docs = docs.filter(d => (d.title || '').toLowerCase().includes(search));
  if (type)   docs = docs.filter(d => d.type === type);
  if (status) docs = docs.filter(d => d.status === status);
  docs = docs.slice().reverse();
  if (!docs.length) { body.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  body.innerHTML = docs.map(d => {
    const statusBadge = d.status === 'signed'
      ? `<span class="badge badge-active" style="font-size:.75rem">Підписано</span>`
      : `<span class="badge badge-pending" style="font-size:.75rem">Чернетка</span>`;
    const signBtn = d.status !== 'signed'
      ? `<button class="btn-table" onclick="docSignFromRegistry('${d.id}')">Підписати</button>` : '';
    const rec = d.recipients;
    const recLabel = !rec || rec.mode === 'all'
      ? '<span style="opacity:.5;font-size:.78rem">Всі клієнти</span>'
      : `<span style="font-size:.78rem">${rec.user_ids?.length || 0} клієнт(ів)</span>`;
    return `<tr>
      <td style="font-family:monospace;font-size:.78rem">${esc(d.id)}</td>
      <td>${esc(DOC_TYPE_LABELS[d.type] || d.type)}</td>
      <td>${esc(d.title)}</td>
      <td>${recLabel}</td>
      <td>${statusBadge}</td>
      <td>${fmt(d.created_at)}</td>
      <td style="font-size:.8rem;color:var(--text-muted)">${esc(d.signature?.signer || '—')}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn-table" onclick="docPreviewOpen('${d.id}')">Переглянути</button>
        ${signBtn}
        <button class="btn-table" onclick="docDelete('${d.id}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}

document.getElementById('docRegSearch')?.addEventListener('input', renderDocRegistry);
document.getElementById('docRegType')?.addEventListener('change', renderDocRegistry);
document.getElementById('docRegStatus')?.addEventListener('change', renderDocRegistry);

/* ── Create / Fields ── */
document.getElementById('docTemplateSelect')?.addEventListener('change', function() {
  const type = this.value;
  currentDocType = type;
  currentDocFields = {};
  _resetDocRecipients();
  const form = document.getElementById('docFieldsForm');
  const grid = document.getElementById('docFieldsGrid');
  if (!type) { form?.classList.add('hidden'); return; }
  const tpl = DOC_TEMPLATES[type];
  if (!tpl) return;
  // Auto-fill date
  const today = new Date().toISOString().slice(0,10);
  grid.innerHTML = tpl.fields.map(f => {
    const val = f.type === 'date' && f.id === 'date' ? today : (f.default || '');
    if (f.type === 'textarea') {
      return `<div class="field-group doc-field-full"><label>${esc(f.label)}</label>
        <textarea class="filter-input doc-field" id="df_${f.id}" placeholder="${esc(f.placeholder||'')}" rows="3">${esc(val)}</textarea></div>`;
    }
    return `<div class="field-group"><label>${esc(f.label)}</label>
      <input type="${f.type==='number'?'number':'text'}" class="filter-input doc-field" id="df_${f.id}"
        placeholder="${esc(f.placeholder||'')}" value="${esc(val)}" ${f.type==='date'?`type="date"`:''}
        ${f.type==='number'?`step="${f.step ?? '0.01'}" min="${f.min ?? '0'}"`:''} ${f.readonly?'readonly':''}/></div>`;
  }).join('');
  // Patch date inputs
  tpl.fields.filter(f => f.type === 'date').forEach(f => {
    const el = document.getElementById(`df_${f.id}`);
    if (el) { el.type = 'date'; if (f.id === 'date') el.value = today; }
  });
  form?.classList.remove('hidden');
});

function collectDocFields() {
  const tpl = DOC_TEMPLATES[currentDocType];
  if (!tpl) return {};
  const fields = {};
  tpl.fields.forEach(f => {
    const el = document.getElementById(`df_${f.id}`);
    fields[f.id] = el ? el.value.trim() : '';
  });
  return fields;
}

function docAutoTitle(type, fields) {
  if (type === 'payout_order')    return `Наказ №${fields.doc_number||'?'} — ${fields.purpose||'виплата'}`;
  if (type === 'balance_cert')    return `Довідка №${fields.cert_number||'?'} — ${fields.recipient||''}`;
  if (type === 'payout_register') return `Реєстр №${fields.reg_number||'?'} (${fields.period_from||''}–${fields.period_to||''})`;
  if (type === 'compliance_act')  return `Акт №${fields.act_number||'?'} — ${fields.subject||''}`;
  return 'Документ';
}

document.getElementById('docPreviewBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('docFormMsg');
  msg.classList.add('hidden');
  try {
    const fields = await enrichDocFields(currentDocType, collectDocFields());
    const html = DOC_TEMPLATES[currentDocType]?.renderHtml(fields, null);
    if (!html) return;
    openDocPreviewHtml(html, docAutoTitle(currentDocType, fields), null);
  } catch (err) {
    msg.textContent = 'Не вдалося автозаповнити документ: ' + err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

document.getElementById('docSaveDraftBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('docFormMsg');
  msg.classList.add('hidden');
  try {
    const fields = await enrichDocFields(currentDocType, collectDocFields());
    const id  = saveDoc(currentDocType, fields, null);
    showToast('Чернетку збережено: ' + id);
    docSwitchTab('registry');
    renderDocRegistry();
  } catch (err) {
    msg.textContent = 'Не вдалося зберегти документ: ' + err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

document.getElementById('docSignSaveBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('docFormMsg');
  msg.classList.add('hidden');
  try {
    const fields = await enrichDocFields(currentDocType, collectDocFields());
    const sig = await signDocFields(currentDocType, fields, currentAdminUser?.full_name || currentAdminUser?.phone || 'Admin');
    const id  = saveDoc(currentDocType, fields, sig);
    showToast('Підписано і збережено: ' + id);
    docSwitchTab('registry');
    renderDocRegistry();
  } catch(err) {
    msg.textContent = err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

function saveDoc(type, fields, sig) {
  const seq  = docsNextId();
  const id   = `DOC-${String(seq).padStart(3,'0')}`;
  const docs = docsLoad();
  const recipients = _getDocRecipients();
  docs.push({
    id, seq, type,
    title: docAutoTitle(type, fields),
    status: sig ? 'signed' : 'draft',
    created_at: new Date().toISOString(),
    fields,
    signature: sig || null,
    recipients,
  });
  docsSave(docs);
  _resetDocRecipients();
  return id;
}

async function signDocFields(type, fields, signerName) {
  const content = JSON.stringify({ type, fields, signed_at: new Date().toISOString() });
  const sigHex  = await cryptoSign(content);
  const fp      = await cryptoFingerprint();
  return {
    signer:         signerName,
    signed_at:      new Date().toLocaleString('uk-UA'),
    algorithm:      'ECDSA P-256 / SHA-256',
    key_fingerprint: fp || '—',
    signature_hex:  sigHex,
    content,
  };
}

/* ── Preview Modal ── */
function openDocPreviewHtml(html, title, docId) {
  previewDocId = docId || null;
  const modal = document.getElementById('docPreviewModal');
  document.getElementById('docPreviewTitle').textContent = title;
  const docs = docsLoad();
  const d    = docs.find(x => x.id === docId);
  const signBtn = document.getElementById('docPreviewSignBtn');
  document.getElementById('docPreviewStatus').innerHTML = d
    ? (d.status === 'signed'
        ? `<span class="badge badge-active" style="font-size:.75rem">Підписано</span>`
        : `<span class="badge badge-pending" style="font-size:.75rem">Чернетка</span>`)
    : '';
  signBtn.style.display = (d && d.status !== 'signed') ? '' : 'none';
  // Render in iframe
  const frame = document.getElementById('docPreviewBody');
  frame.innerHTML = `<iframe id="docPreviewFrame" style="width:100%;height:100%;border:none;border-radius:0 0 var(--radius) var(--radius)"></iframe>`;
  const iframe = document.getElementById('docPreviewFrame');
  iframe.onload = () => {};
  iframe.srcdoc = html;
  modal.classList.remove('hidden');
  // Store for download
  modal._currentHtml = html;
  modal._currentTitle = title;
}

window.docPreviewOpen = function(docId) {
  const docs = docsLoad();
  const d    = docs.find(x => x.id === docId);
  if (!d) return;
  const html = DOC_TEMPLATES[d.type]?.renderHtml(d.fields, d.signature);
  if (!html) return;
  openDocPreviewHtml(html, d.title, docId);
};

window.docDelete = function(docId) {
  if (!confirm(`Видалити документ ${docId}?`)) return;
  const docs = docsLoad().filter(d => d.id !== docId);
  docsSave(docs);
  renderDocRegistry();
};

window.docSignFromRegistry = async function(docId) {
  try {
    const docs = docsLoad();
    const d    = docs.find(x => x.id === docId);
    if (!d) return;
    const sig = await signDocFields(d.type, d.fields, currentAdminUser?.full_name || currentAdminUser?.phone || 'Admin');
    d.status = 'signed';
    d.signature = sig;
    docsSave(docs);
    showToast(`Документ ${docId} підписано`);
    renderDocRegistry();
    // Refresh preview if open
    if (previewDocId === docId && !document.getElementById('docPreviewModal').classList.contains('hidden')) {
      docPreviewOpen(docId);
    }
  } catch(err) { showToast(err.message, 'error'); }
};

document.getElementById('docPreviewClose')?.addEventListener('click', () => {
  document.getElementById('docPreviewModal').classList.add('hidden');
});
document.getElementById('docPreviewPrintBtn')?.addEventListener('click', () => {
  const frame = document.getElementById('docPreviewFrame');
  if (frame?.contentWindow) frame.contentWindow.print();
});
document.getElementById('docPreviewDownloadBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('docPreviewModal');
  const html  = modal._currentHtml;
  const title = modal._currentTitle || 'document';
  if (!html) return;
  downloadHtml(`${title.replace(/[^а-яёa-z0-9]/gi,'_')}.html`, html);
});
document.getElementById('docPreviewSignBtn')?.addEventListener('click', async () => {
  if (!previewDocId) return;
  try {
    await docSignFromRegistry(previewDocId);
  } catch(err) { showToast(err.message, 'error'); }
});

/* ── Key Management ── */
async function updateDocKeyStatus() {
  const fp        = await cryptoFingerprint();
  const keyDate   = localStorage.getItem(SIG_KEY_DATE);
  const badge     = document.getElementById('docKeyStatus');
  const statusLbl = document.getElementById('keyStatusLabel');
  const fpEl      = document.getElementById('keyFingerprint');
  const dateEl    = document.getElementById('keyCreatedAt');
  const showBtn   = document.getElementById('showPubKeyBtn');
  const copyBtn   = document.getElementById('copyPubKeyBtn');
  const expBtn    = document.getElementById('exportPrivKeyBtn');
  if (fp) {
    if (badge)     { badge.textContent = 'Ключ активний'; badge.className = 'doc-key-badge doc-key-ok'; }
    if (statusLbl) statusLbl.textContent = 'Активний';
    if (fpEl)      fpEl.textContent = fp;
    if (dateEl)    dateEl.textContent = keyDate ? new Date(keyDate).toLocaleString('uk-UA') : '—';
    if (showBtn)   showBtn.disabled = false;
    if (copyBtn)   copyBtn.disabled = false;
    if (expBtn)    expBtn.disabled  = false;
  } else {
    if (badge)     { badge.textContent = 'Ключ не згенеровано'; badge.className = 'doc-key-badge doc-key-none'; }
    if (statusLbl) statusLbl.textContent = 'Не згенеровано';
    if (fpEl)      fpEl.textContent = '—';
    if (dateEl)    dateEl.textContent = '—';
  }
}

document.getElementById('genKeyBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('keyMsg');
  const exists = !!localStorage.getItem(SIG_PRIV_KEY);
  if (exists && !confirm('Існуючий ключ буде замінено. Документи, підписані старим ключем, не можна буде перевірити через нову пару. Продовжити?')) return;
  try {
    await cryptoGenerateKeyPair();
    await updateDocKeyStatus();
    docUpdateNoKeyHint();
    msg.textContent = 'Новий ключ ECDSA P-256 успішно згенеровано і збережено.';
    msg.className = 'form-msg success';
    msg.classList.remove('hidden');
  } catch(err) {
    msg.textContent = err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

document.getElementById('showPubKeyBtn')?.addEventListener('click', () => {
  const jwk  = localStorage.getItem(SIG_PUB_KEY);
  const disp = document.getElementById('pubKeyDisplay');
  const txt  = document.getElementById('pubKeyText');
  if (!jwk || !disp || !txt) return;
  txt.value = JSON.stringify(JSON.parse(jwk), null, 2);
  disp.classList.toggle('hidden');
});

document.getElementById('copyPubKeyBtn')?.addEventListener('click', () => {
  const jwk = localStorage.getItem(SIG_PUB_KEY);
  if (!jwk) return;
  navigator.clipboard.writeText(jwk).then(() => showToast('Публічний ключ скопійовано'));
});

document.getElementById('exportPrivKeyBtn')?.addEventListener('click', () => {
  const priv = localStorage.getItem(SIG_PRIV_KEY);
  if (!priv) return;
  if (!confirm('Приватний ключ є секретним. Зберігайте його в безпечному місці. Продовжити?')) return;
  const blob = new Blob([priv], { type:'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'army_sign_private_key.json'; a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importKeyBtn')?.addEventListener('click', async () => {
  const msg  = document.getElementById('importKeyMsg');
  const text = document.getElementById('importKeyText')?.value.trim();
  if (!text) return;
  try {
    const jwk = JSON.parse(text);
    // Validate it's a proper ECDSA key
    await crypto.subtle.importKey('jwk', jwk, { name:'ECDSA', namedCurve:'P-256' }, true, ['sign']);
    localStorage.setItem(SIG_PRIV_KEY, text);
    localStorage.setItem(SIG_KEY_DATE, new Date().toISOString());
    // Try derive public key (if provided d+x+y, extract x+y as public)
    const pubJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, key_ops: ['verify'] };
    localStorage.setItem(SIG_PUB_KEY, JSON.stringify(pubJwk));
    await updateDocKeyStatus();
    msg.textContent = 'Ключ успішно імпортовано.';
    msg.className = 'form-msg success';
    msg.classList.remove('hidden');
  } catch(err) {
    msg.textContent = `Помилка імпорту: ${err.message}`;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

/* ── Verify ── */
document.getElementById('verifyDocBtn')?.addEventListener('click', async () => {
  const result  = document.getElementById('verifyResult');
  const pubKey  = document.getElementById('verifyPubKey')?.value.trim();
  const content = document.getElementById('verifyContent')?.value.trim();
  const sigHex  = document.getElementById('verifySig')?.value.trim();
  if (!pubKey || !content || !sigHex) {
    result.textContent = 'Заповніть всі поля.';
    result.className = 'form-msg error';
    result.classList.remove('hidden');
    return;
  }
  try {
    const valid = await cryptoVerify(content, sigHex, pubKey);
    result.textContent = valid
      ? '✓ Підпис дійсний. Документ не змінювався після підписання.'
      : '✗ Підпис недійсний або документ було змінено.';
    result.className = `form-msg ${valid ? 'success' : 'error'}`;
    result.classList.remove('hidden');
  } catch(err) {
    result.textContent = `Помилка: ${err.message}`;
    result.className = 'form-msg error';
    result.classList.remove('hidden');
  }
});

/* ══════════════════════════════════════════════
   BANKING SIMULATOR — REAL-TIME ENGINE
   Transactions are scheduled to real clock times.
   8–12 TX/day spread across weighted hour slots.
   Paydays on 1st & 15th. Weekend mode. Auto-reschedule at midnight.
══════════════════════════════════════════════ */
let simRunning   = false;
let simTxTotal   = 0;
let simTodayTx   = 0;
let simVolume    = 0;
let simErrors    = 0;
let simUsers     = [];
const SIM_LOG_MAX = 300;

// Queue: [{fireAt: Date, txDef, userId, targetId?}]
let simQueue    = [];
let simTimers   = [];   // active setTimeout handles
let simClockTmr = null; // 1-sec clock ticker
let simMidnightTmr = null;

/* ── Transaction catalog ── */
const SIM_TX_CATALOG = [
  { type:'payout',    subtype:'combat', weight:16, amtMin:5000,  amtMax:30000,
    labels:['Бойова виплата','Виплата за бойові дії','Компенсація ООС','Відшкодування за участь у БД','Виплата за ризик','Виплата учасника бойових дій'] },
  { type:'payout',    subtype:'salary', weight:20, amtMin:6800,  amtMax:18000,
    labels:['Грошове забезпечення','Посадовий оклад','Виплата ГЗ','Оклад за в/зв','Місячне ГЗ','Виплата грошового утримання'] },
  { type:'payout',    subtype:'bonus',  weight:8,  amtMin:500,   amtMax:7000,
    labels:['Надбавка за вислугу','Надбавка за спецумови','Преміювання','Матеріальна допомога','Разова виплата','Надбавка за таємницю'] },
  { type:'deposit',   weight:18, amtMin:200,   amtMax:12000,
    labels:['Поповнення рахунку','Переказ від родичів','Зарахування коштів','Благодійна допомога','Волонтерська допомога','Допомога від фонду'] },
  { type:'deduction', weight:20, amtMin:80,    amtMax:2500,
    labels:['Утримання за харчування','Утримання за речмайно','Погашення позики','Утримання за ПММ','Аліменти','Утримання за проживання','Погашення авансу','Повернення переплати'] },
  { type:'transfer',  weight:18, amtMin:150,   amtMax:6000,
    labels:['Взаємодопомога','Повернення боргу','Переказ побратиму','Збір на спорядження','Спільна закупівля','Допомога пораненому','Збір на дрон'] },
];

// Hour weights: probability of a TX at each hour (0–23). Peak 9–17, quiet 22–6.
const SIM_HOUR_WEIGHTS = [
  0.2, 0.1, 0.05, 0.05, 0.05, 0.1,  // 0–5
  0.3, 0.6, 1.2,  2.0,  2.5,  3.0,  // 6–11
  2.8, 2.5, 3.2,  3.5,  3.0,  2.5,  // 12–17
  2.0, 1.5, 1.0,  0.7,  0.4,  0.3,  // 18–23
];

function simPickWeighted(catalog) {
  const total = catalog.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of catalog) { r -= item.weight; if (r <= 0) return item; }
  return catalog[catalog.length - 1];
}
function simRandItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function simRandAmt(min, max) { return Math.round((Math.random() * (max - min) + min) * 100) / 100; }
function simRandInRange(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function simEnabledTypes() {
  const chks = [...document.querySelectorAll('.sim-type-chk:checked')].map(c => c.value);
  return SIM_TX_CATALOG.filter(t => chks.includes(t.type));
}

/* ── Schedule builder ──
   Generates an array of {fireAt, txDef, userId, targetId} for today,
   spread across real clock hours using weighted random slots. */
function simBuildDaySchedule(forDate) {
  if (!simUsers.length) return [];
  const catalog = simEnabledTypes();
  if (!catalog.length) return [];

  const now     = new Date();
  const isToday = forDate.toDateString() === now.toDateString();
  const dow     = forDate.getDay(); // 0=Sun, 6=Sat
  const isWeekend = (dow === 0 || dow === 6) && document.getElementById('simWeekendReduce')?.checked;
  const day     = forDate.getDate();
  const isPayday1  = day === 1  && document.getElementById('simPayday1')?.checked;
  const isPayday15 = day === 15 && document.getElementById('simPayday15')?.checked;

  let txMin = parseInt(document.getElementById('simTxMin')?.value || '8');
  let txMax = parseInt(document.getElementById('simTxMax')?.value || '12');
  if (isWeekend) { txMin = Math.max(1, Math.floor(txMin * 0.4)); txMax = Math.max(1, Math.floor(txMax * 0.4)); }
  if (isPayday1 || isPayday15) { txMin = Math.max(txMax, txMin + 4); txMax = txMin + 6; }

  const count = simRandInRange(txMin, txMax);
  const schedule = [];

  // Pick random hours weighted by SIM_HOUR_WEIGHTS
  const hourPool = [];
  SIM_HOUR_WEIGHTS.forEach((w, h) => {
    const slots = Math.round(w * 4); // relative slots
    for (let i = 0; i < slots; i++) hourPool.push(h);
  });

  // Payday special: most TX in morning 8–10
  const paydayHourPool = [];
  for (let i = 0; i < 40; i++) paydayHourPool.push(simRandInRange(8, 11));

  for (let i = 0; i < count; i++) {
    const pool     = (isPayday1 || isPayday15) ? paydayHourPool : hourPool;
    const hour     = simRandItem(pool);
    const minute   = simRandInRange(0, 59);
    const second   = simRandInRange(0, 59);

    const fireAt = new Date(forDate);
    fireAt.setHours(hour, minute, second, 0);
    if (isToday && fireAt <= now) continue; // skip past times for today

    // Pick TX type — on payday prefer salary/combat payouts
    let txDef;
    if ((isPayday1 || isPayday15) && Math.random() < 0.7) {
      const payCatalog = SIM_TX_CATALOG.filter(t => t.type === 'payout' && simEnabledTypes().includes(t));
      txDef = payCatalog.length ? simRandItem(payCatalog) : simPickWeighted(catalog);
    } else {
      txDef = simPickWeighted(catalog);
    }

    const user   = simRandItem(simUsers);
    const target = txDef.type === 'transfer'
      ? simRandItem(simUsers.filter(u => u.id !== user.id) || [user])
      : null;

    schedule.push({ fireAt, txDef, userId: user.id, userName: user.full_name || `#${user.id}`, targetId: target?.id, targetName: target?.full_name });
  }

  return schedule.sort((a, b) => a.fireAt - b.fireAt);
}

/* ── Schedule today at midnight ── */
function simScheduleMidnightReset() {
  if (simMidnightTmr) clearTimeout(simMidnightTmr);
  const now       = new Date();
  const tomorrow  = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 5, 0);
  const msUntil   = tomorrow - now;
  simMidnightTmr  = setTimeout(() => {
    if (!simRunning) return;
    simTodayTx = 0;
    simScheduleDay(tomorrow);
    simScheduleMidnightReset();
  }, msUntil);
}

function simScheduleDay(forDate) {
  // Cancel any pending timers
  simTimers.forEach(t => clearTimeout(t));
  simTimers = [];
  simQueue  = simBuildDaySchedule(forDate);

  renderSimSchedule(forDate);
  renderSimHourBar();
  updateSimUI();

  simQueue.forEach(item => {
    const delay = item.fireAt - Date.now();
    if (delay < 0) return;
    const tmr = setTimeout(() => simFireTx(item), delay);
    simTimers.push(tmr);
  });
}

async function simFireTx(item) {
  if (!simRunning) return;
  const { txDef, userId, userName, targetId, targetName } = item;
  const amt   = simRandAmt(txDef.amtMin, txDef.amtMax);
  const label = simRandItem(txDef.labels);
  let ok = false, errorMsg = '';

  try {
    if (txDef.type === 'payout') {
      await api.createPayout({ user_id: userId, amount: amt, payout_type: txDef.subtype || 'other', title: label });
    } else if (txDef.type === 'deposit') {
      await api.adjustUserBalance(userId, { amount: amt, reason: label });
    } else if (txDef.type === 'deduction') {
      await api.adjustUserBalance(userId, { amount: -amt, reason: label });
    } else if (txDef.type === 'transfer' && targetId) {
      await api.adjustUserBalance(userId,   { amount: -amt, reason: `${label} → ${targetName || targetId}` });
      await api.adjustUserBalance(targetId, { amount:  amt, reason: `${label} ← ${userName}` });
    }
    ok = true;
    simTxTotal++;
    simTodayTx++;
    simVolume += amt;
  } catch (e) {
    simErrors++;
    errorMsg = e.message;
  }

  simLogEntry({ ok, type: txDef.type, user: userName, label, amt, error: errorMsg, fireAt: item.fireAt });
  updateSimUI();
  renderSimSchedule(item.fireAt); // mark item as done
}

/* ── UI helpers ── */
function loadSimulatorPage() {
  updateSimUI();
  if (simRunning) renderSimSchedule(new Date());
  renderSimHourBar();
}

function updateSimUI() {
  const badge = document.getElementById('simStatusBadge');
  if (badge) { badge.textContent = simRunning ? 'Активний' : 'Вимкнено'; badge.className = `sim-badge ${simRunning ? 'sim-badge--on' : 'sim-badge--off'}`; }
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el('simStatTodayTx', simTodayTx);
  el('simStatTx',      simTxTotal);
  el('simStatVol',     '₴ ' + Math.round(simVolume).toLocaleString('uk-UA'));
  el('simStatErr',     simErrors);
  el('simStatUsers',   simUsers.length);
  // Next scheduled TX
  const upcoming = simQueue.filter(i => i.fireAt > new Date());
  const next = upcoming[0];
  el('simStatNext', next ? next.fireAt.toLocaleTimeString('uk-UA') + ' · ' + (next.userName || '—') : '—');
  const startBtn = document.getElementById('simStartBtn');
  const stopBtn  = document.getElementById('simStopBtn');
  if (startBtn) startBtn.disabled = simRunning;
  if (stopBtn)  stopBtn.disabled  = !simRunning;
}

function renderSimSchedule(forDate) {
  const el   = document.getElementById('simScheduleList');
  const dateEl = document.getElementById('simScheduleDate');
  if (!el) return;
  if (dateEl) dateEl.textContent = forDate ? forDate.toLocaleDateString('uk-UA', { weekday:'long', day:'numeric', month:'long' }) : '';
  const now = new Date();
  if (!simQueue.length) { el.innerHTML = '<div class="sim-log-empty">Немає запланованих операцій на сьогодні.</div>'; return; }
  const ICONS = { payout:'💰', deposit:'⬆', deduction:'⬇', transfer:'↔' };
  el.innerHTML = simQueue.map(item => {
    const past = item.fireAt <= now;
    return `<div class="sim-sched-row${past ? ' sim-sched-row--done' : ''}">
      <span class="sim-sched-time">${item.fireAt.toLocaleTimeString('uk-UA', { hour:'2-digit', minute:'2-digit' })}</span>
      <span class="sim-sched-icon">${ICONS[item.txDef.type] || '·'}</span>
      <span class="sim-sched-user">${escHtml(item.userName)}</span>
      ${past ? '<span class="sim-sched-done">✓</span>' : ''}
    </div>`;
  }).join('');
}

function renderSimHourBar() {
  const el = document.getElementById('simHourBar');
  if (!el) return;
  // Count scheduled TX per hour
  const counts = new Array(24).fill(0);
  simQueue.forEach(i => counts[i.fireAt.getHours()]++);
  const maxC = Math.max(1, ...counts);
  el.innerHTML = counts.map((c, h) => `
    <div class="sim-hbar-col">
      <div class="sim-hbar-bar" style="height:${Math.round((c/maxC)*52)+2}px" title="${h}:00 — ${c} tx"></div>
      <div class="sim-hbar-label">${h % 3 === 0 ? h : ''}</div>
    </div>`).join('');
}

function simLogEntry(entry) {
  const log = document.getElementById('simLog');
  if (!log) return;
  const empty = log.querySelector('.sim-log-empty');
  if (empty) empty.remove();
  const row   = document.createElement('div');
  const sign  = entry.type === 'deduction' ? '−' : '+';
  const ICONS = { payout:'💰', deposit:'⬆', deduction:'⬇', transfer:'↔' };
  row.className = `sim-log-row sim-log-row--${entry.ok ? (entry.type === 'deduction' ? 'debit' : 'credit') : 'error'}`;
  row.innerHTML = `
    <span class="sim-log-icon">${entry.ok ? (ICONS[entry.type]||'·') : '✗'}</span>
    <span class="sim-log-time">${(entry.fireAt||new Date()).toLocaleTimeString('uk-UA')}</span>
    <span class="sim-log-user">${escHtml(entry.user)}</span>
    <span class="sim-log-label">${escHtml(entry.label)}</span>
    <span class="sim-log-amt ${entry.ok ? (entry.type==='deduction'?'neg':'pos') : 'err'}">
      ${entry.ok ? sign+'&nbsp;₴'+Number(entry.amt).toLocaleString('uk-UA') : escHtml(entry.error||'err')}
    </span>`;
  log.insertBefore(row, log.firstChild);
  while (log.children.length > SIM_LOG_MAX) log.removeChild(log.lastChild);
}

function simStartClock() {
  if (simClockTmr) clearInterval(simClockTmr);
  simClockTmr = setInterval(() => {
    const el = document.getElementById('simClockDisplay');
    if (el) el.textContent = new Date().toLocaleTimeString('uk-UA');
    // Refresh "next TX" counter every second
    const upEl = document.getElementById('simStatNext');
    if (upEl && simRunning) {
      const next = simQueue.find(i => i.fireAt > new Date());
      if (next) {
        const secs = Math.round((next.fireAt - Date.now()) / 1000);
        const mm   = String(Math.floor(secs / 60)).padStart(2, '0');
        const ss   = String(secs % 60).padStart(2, '0');
        upEl.textContent = `${next.fireAt.toLocaleTimeString('uk-UA', {hour:'2-digit',minute:'2-digit'})} (через ${mm}:${ss}) · ${next.userName||'—'}`;
      } else {
        upEl.textContent = 'Очікування наступного дня…';
      }
    }
  }, 1000);
}

/* ── Button bindings ── */
document.getElementById('simStartBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('simInitMsg');
  msg.classList.add('hidden');
  try {
    const res = await api.listAccounts({ limit: 500 });
    simUsers = (res.users || res.data || []).filter(u => u.id);
    if (!simUsers.length) throw new Error('Користувачів не знайдено. Перевірте підключення до API.');
    simRunning  = true;
    simTxTotal  = 0;
    simTodayTx  = 0;
    simVolume   = 0;
    simErrors   = 0;
    const log = document.getElementById('simLog');
    if (log) log.innerHTML = '';
    simStartClock();
    simScheduleDay(new Date());
    simScheduleMidnightReset();
    updateSimUI();
    showToast(`Симулятор запущено. ${simUsers.length} учасників, ${simQueue.length} операцій сьогодні.`);
  } catch (e) {
    msg.textContent = e.message;
    msg.className   = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

document.getElementById('simStopBtn')?.addEventListener('click', () => {
  simRunning = false;
  simTimers.forEach(t => clearTimeout(t));
  simTimers = [];
  if (simMidnightTmr) clearTimeout(simMidnightTmr);
  if (simClockTmr)    clearInterval(simClockTmr);
  updateSimUI();
  showToast(`Симулятор зупинено. Виконано ${simTxTotal} операцій.`);
});

document.getElementById('simClearLogBtn')?.addEventListener('click', () => {
  const log = document.getElementById('simLog');
  if (log) log.innerHTML = '<div class="sim-log-empty">Лог очищено.</div>';
});

document.getElementById('simZeroAllBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('simInitMsg');
  if (!confirm('Обнулити баланси ВСІХ користувачів?')) return;
  msg.textContent = 'Завантаження…';
  msg.className   = 'form-msg';
  msg.classList.remove('hidden');
  try {
    const res   = await api.listAccounts({ limit: 500 });
    const users = (res.users || res.data || []).filter(u => u.account?.balance && u.account.balance !== 0);
    if (!users.length) { msg.textContent = 'Всі баланси вже нульові.'; msg.className = 'form-msg success'; return; }
    let done = 0;
    for (const u of users) {
      const bal = u.account.balance;
      if (bal !== 0) { await api.adjustUserBalance(u.id, { amount: -bal, reason: 'Обнулення симулятора' }); done++; }
      msg.textContent = `Обнулення ${done}/${users.length}…`;
    }
    msg.textContent = `Обнулено ${done} рахунків.`;
    msg.className   = 'form-msg success';
  } catch (e) { msg.textContent = `Помилка: ${e.message}`; msg.className = 'form-msg error'; }
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
   SESSION ENGINE
══════════════════════════════════════════════ */
const SESSION_IDLE_MS    = 20 * 60 * 1000;  // 20 min idle → show warning
const SESSION_WARN_MS    = 60 * 1000;       // 60 s countdown
const SESSION_MIN_EXTEND = 30 * 1000;       // throttle /api/auth/me calls

let _sesIdleTimer    = null;
let _sesAbsTimer     = null;
let _sesWarnInterval = null;
let _sesWarnActive   = false;
let _sesLastExtend   = 0;

function _sesJwtExp(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch (_) { return null; }
}

function _sesCancelWarn() {
  if (_sesWarnInterval) { clearInterval(_sesWarnInterval); _sesWarnInterval = null; }
  _sesWarnActive = false;
  const ov = document.getElementById('sessionWarnOverlay');
  if (ov) ov.classList.add('hidden');
}

function _sesShowWarn() {
  if (_sesWarnActive) return;
  _sesWarnActive = true;
  let secs = Math.round(SESSION_WARN_MS / 1000);
  const ov = document.getElementById('sessionWarnOverlay');
  const cd = document.getElementById('sessionWarnCountdown');
  if (ov) ov.classList.remove('hidden');
  if (cd) cd.textContent = secs;
  _sesWarnInterval = setInterval(() => {
    secs -= 1;
    if (cd) cd.textContent = Math.max(0, secs);
    if (secs <= 0) {
      _sesCancelWarn();
      _adminLogout('idle');
    }
  }, 1000);
}

function _sesResetIdle() {
  if (!api.token || _sesWarnActive) return;
  clearTimeout(_sesIdleTimer);
  _sesIdleTimer = setTimeout(_sesShowWarn, SESSION_IDLE_MS);
}

function _sesScheduleAbsolute() {
  clearTimeout(_sesAbsTimer);
  if (!api.token) return;
  const exp = _sesJwtExp(api.token);
  if (!exp) return;
  const ms = exp - Date.now();
  if (ms <= 0) { _adminLogout('expired'); return; }
  const warnAt = ms - SESSION_WARN_MS;
  if (warnAt > 0) {
    _sesAbsTimer = setTimeout(() => {
      _sesCancelWarn();
      _sesShowWarn();
      setTimeout(() => {
        if (_sesWarnActive) { _sesCancelWarn(); _adminLogout('expired'); }
      }, SESSION_WARN_MS + 2000);
    }, warnAt);
  } else {
    _sesAbsTimer = setTimeout(() => { _sesCancelWarn(); _adminLogout('expired'); }, Math.max(ms, 100));
  }
}

async function _sesExtend() {
  const now = Date.now();
  if (now - _sesLastExtend < SESSION_MIN_EXTEND) return;
  _sesLastExtend = now;
  try {
    await api.me();
    _sesCancelWarn();
    _sesScheduleAbsolute();
    _sesResetIdle();
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) { _sesCancelWarn(); _adminLogout('expired'); }
  }
}

function _adminLogout(reason) {
  stopSessionEngine();
  api.setToken('');
  if (reason === 'idle') showToast('Сесію завершено через бездіяльність.', 'warning');
  else if (reason === 'expired') showToast('Термін дії сесії вичерпано. Увійдіть повторно.', 'warning');
  showAuth();
}

function startSessionEngine() {
  stopSessionEngine();
  if (!api.token) return;
  _sesScheduleAbsolute();
  _sesResetIdle();
}

function stopSessionEngine() {
  clearTimeout(_sesIdleTimer);
  clearTimeout(_sesAbsTimer);
  _sesCancelWarn();
  _sesIdleTimer = null;
  _sesAbsTimer  = null;
}

['click', 'keydown', 'touchstart', 'mousemove'].forEach(evt => {
  document.addEventListener(evt, () => { if (api.token) _sesResetIdle(); }, { passive: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && api.token) _sesExtend();
});

window.addEventListener('online', () => { if (api.token) _sesExtend(); });

document.getElementById('sessionWarnExtend')?.addEventListener('click', () => {
  _sesLastExtend = 0;
  _sesExtend();
});
document.getElementById('sessionWarnLogout')?.addEventListener('click', () => {
  _sesCancelWarn();
  api.logout().catch(() => {});
  api.setToken('');
  showAuth();
});

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
tryAutoLogin();
