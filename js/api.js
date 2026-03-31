/* ═══════════════════════════════════════════════
   Army Bank Admin — api.js
   ═══════════════════════════════════════════════ */

const API_BASE = 'https://army-bank.onrender.com';
const TOKEN_KEY = 'army_admin_token';

class AdminAPI {
  get token() { return localStorage.getItem(TOKEN_KEY) || ''; }
  setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

  async request(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);

    const refreshed = res.headers.get('X-Refresh-Token');
    if (refreshed && refreshed !== this.token) this.setToken(refreshed);

    if (res.status === 401) {
      this.setToken('');
      window.dispatchEvent(new Event('admin:unauthorized'));
    }

    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!json.ok) throw new Error(json.error || 'Помилка запиту');
    return json;
  }

  get(path)         { return this.request('GET', path); }
  post(path, body)  { return this.request('POST', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }

  // ── Auth ──
  login(identity, password) { return this.post('/api/auth/login', { identity, password }); }
  logout()  { return this.post('/api/auth/logout').catch(() => {}); }
  me()      { return this.get('/api/auth/me'); }

  // ── Admin ──
  stats()   { return this.get('/api/admin/stats'); }
  chartStats(days = 30) {
    return this.get(`/api/admin/stats/charts?days=${days}`);
  }

  listUsers(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/users${q ? '?' + q : ''}`);
  }
  getUser(id)          { return this.get(`/api/admin/users/${id}`); }
  getUserTransactions(id, limit = 50) {
    return this.get(`/api/admin/users/${id}/transactions?limit=${limit}`);
  }
  updateRole(id, role) { return this.patch(`/api/admin/users/${id}/role`, { role }); }

  listTransactions(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/transactions${q ? '?' + q : ''}`);
  }
  adjustUserBalance(userId, data) {
    return this.post(`/api/admin/users/${userId}/balance-adjust`, data);
  }
  listPaymentOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/payments/orders${q ? '?' + q : ''}`);
  }
  getPaymentOrder(orderId) {
    return this.get(`/api/admin/payments/orders/${orderId}`);
  }
  assignPaymentOrder(orderId, data = {}) {
    return this.patch(`/api/admin/payments/orders/${orderId}/assign`, data);
  }
  decidePaymentOrder(orderId, data = {}) {
    return this.patch(`/api/admin/payments/orders/${orderId}/decision`, data);
  }
  requestPaymentOrderApproval(orderId, data = {}) {
    return this.post(`/api/admin/payments/orders/${orderId}/approval/request`, data);
  }
  finalizePaymentOrderApproval(orderId, data = {}) {
    return this.post(`/api/admin/payments/orders/${orderId}/approval/finalize`, data);
  }
  addPaymentOrderNote(orderId, note) {
    return this.post(`/api/admin/payments/orders/${orderId}/notes`, { note });
  }
  getPaymentOrderTimeline(orderId, limit = 200) {
    return this.get(`/api/admin/payments/orders/${orderId}/timeline?limit=${limit}`);
  }
  listPaymentRiskEvents(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/payments/risk-events${q ? '?' + q : ''}`);
  }
  resolvePaymentRiskEvent(eventId) {
    return this.post(`/api/admin/payments/risk-events/${eventId}/resolve`, {});
  }
  getFraudStats() {
    return this.get('/api/admin/payments/fraud-stats');
  }
  getPaymentSlaQueue(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/payments/sla-queue${q ? '?' + q : ''}`);
  }
  getPaymentApprovalInbox(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/payments/approval-inbox${q ? '?' + q : ''}`);
  }
  runPaymentSlaAutoEscalate(data = {}) {
    return this.post('/api/admin/payments/sla-auto-escalate', data);
  }
  getPaymentWorkload(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/payments/workload${q ? '?' + q : ''}`);
  }
  runPaymentSlaBulkAction(data = {}) {
    return this.post('/api/admin/payments/sla-bulk-action', data);
  }
  createPayout(data)   { return this.post('/api/admin/payouts', data); }

  listAuditLogs(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/audit-logs${q ? '?' + q : ''}`);
  }

  // ── Admin Cards ──
  cardsStats() { return this.get('/api/admin/cards/stats'); }
  listAdminCards(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/cards${q ? '?' + q : ''}`);
  }
  getAdminCard(cardId) { return this.get(`/api/admin/cards/${cardId}`); }
  blockAdminCard(cardId)   { return this.patch(`/api/admin/cards/${cardId}/block`, {}); }
  unblockAdminCard(cardId) { return this.patch(`/api/admin/cards/${cardId}/unblock`, {}); }
  closeAdminCard(cardId)   { return this.patch(`/api/admin/cards/${cardId}/close`, {}); }
  issueAdminCard(userId, data) { return this.post(`/api/admin/users/${userId}/cards`, data); }

  // ── Compliance ──
  complianceStats()  { return this.get('/api/admin/compliance/stats'); }
  complianceUsers(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/admin/compliance/users${q ? '?' + q : ''}`);
  }
  complianceGetUser(userId) { return this.get(`/api/admin/compliance/users/${userId}`); }
  complianceUpdateUser(userId, data) { return this.patch(`/api/admin/compliance/users/${userId}`, data); }
}

window.api = new AdminAPI();
