/* ═══════════════════════════════════════════════
   Army Bank Admin — agent.js
   Local task-runner: no external AI, pure Python
   ═══════════════════════════════════════════════ */

const AGENT_BASE = `${API_BASE}/api/admin/agent`;

let agentRunning = false;
let agentAbort = null;

// ── Init ───────────────────────────────────────────────────────────────────────

async function initAgentPage() {
  renderAgentLog([]);
  updateAgentBadge('idle');
  document.getElementById('agentClearBtn')?.addEventListener('click', () => {
    renderAgentLog([]);
    updateAgentBadge('idle');
  });

  try {
    const res = await fetch(`${AGENT_BASE}/tasks`, {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    renderAgentTaskList(json.data);
  } catch (e) {
    renderAgentTaskList([]);
    appendAgentLog({ level: 'error', text: `Не вдалося завантажити список агентів: ${e.message}` });
  }
}

// ── Task list ──────────────────────────────────────────────────────────────────

function renderAgentTaskList(tasks) {
  const el = document.getElementById('agentTaskList');
  if (!el) return;

  if (!tasks.length) {
    el.innerHTML = '<p style="color:var(--text-muted);padding:12px 0">Задачі недоступні</p>';
    return;
  }

  el.innerHTML = tasks.map(t => `
    <div class="agent-task-card" data-id="${t.id}">
      <div class="agent-task-icon">${t.icon}</div>
      <div class="agent-task-body">
        <div class="agent-task-name">${t.name}</div>
        <div class="agent-task-desc">${t.desc}</div>
      </div>
      <button class="agent-run-btn" data-id="${t.id}" title="Запустити">▶</button>
    </div>
  `).join('');

  el.querySelectorAll('.agent-run-btn').forEach(btn => {
    btn.addEventListener('click', () => runAgent(btn.dataset.id, tasks));
  });
}

// ── Run ────────────────────────────────────────────────────────────────────────

async function runAgent(taskId, tasks) {
  if (agentRunning) return;

  const task = tasks.find(t => t.id === taskId);
  const name = task ? task.name : taskId;

  agentRunning = true;
  updateAgentBadge('running', name);
  renderAgentLog([]);
  setAgentButtonsDisabled(true);

  appendAgentLog({ level: 'dim', text: `════ ${name} ════` });

  try {
    const ctrl = new AbortController();
    agentAbort = ctrl;

    const res = await fetch(`${AGENT_BASE}/run/${taskId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}` },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'log') {
            appendAgentLog(msg);
          } else if (msg.type === 'done') {
            appendAgentLog({ level: 'ok', text: `✓ ${msg.summary || 'Завершено'}` });
            appendAgentLog({ level: 'dim', text: `════ кінець ════` });
            updateAgentBadge('done');
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      appendAgentLog({ level: 'error', text: `Помилка: ${e.message}` });
      updateAgentBadge('error');
    }
  } finally {
    agentRunning = false;
    agentAbort = null;
    setAgentButtonsDisabled(false);
  }
}

// ── Log helpers ────────────────────────────────────────────────────────────────

const LEVEL_COLOR = {
  ok:    'var(--green)',
  error: 'var(--red)',
  warn:  '#d97706',
  dim:   'var(--text-muted)',
  info:  'var(--text)',
};

function appendAgentLog(msg) {
  const log = document.getElementById('agentLog');
  if (!log) return;

  // Remove placeholder
  const ph = log.querySelector('.agent-log-placeholder');
  if (ph) ph.remove();

  const line = document.createElement('div');
  line.className = 'agent-log-line';
  const ts = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const color = LEVEL_COLOR[msg.level] || LEVEL_COLOR.info;

  line.innerHTML =
    `<span class="agent-log-ts">${ts}</span>` +
    `<span class="agent-log-text" style="color:${color}">${escAgentHtml(msg.text || '')}</span>`;

  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function renderAgentLog(lines) {
  const log = document.getElementById('agentLog');
  if (!log) return;
  if (!lines.length) {
    log.innerHTML = '<div class="agent-log-placeholder">Виберіть задачу для запуску →</div>';
    return;
  }
  log.innerHTML = '';
  lines.forEach(l => appendAgentLog(l));
}

function escAgentHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Status badge ───────────────────────────────────────────────────────────────

function updateAgentBadge(state, label) {
  const badge = document.getElementById('agentStatusBadge');
  if (!badge) return;
  badge.className = 'sim-badge';
  if (state === 'running') {
    badge.classList.add('sim-badge--on');
    badge.textContent = label ? `Виконую: ${label}` : 'Виконую...';
  } else if (state === 'done') {
    badge.style.background = '#d1fae5';
    badge.style.color = '#065f46';
    badge.textContent = 'Готово';
  } else if (state === 'error') {
    badge.style.background = '#fee2e2';
    badge.style.color = '#991b1b';
    badge.textContent = 'Помилка';
  } else {
    badge.classList.add('sim-badge--off');
    badge.textContent = 'Готовий';
    badge.style.background = '';
    badge.style.color = '';
  }
}

function setAgentButtonsDisabled(disabled) {
  document.querySelectorAll('.agent-run-btn').forEach(btn => {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? '0.4' : '';
    btn.style.cursor = disabled ? 'not-allowed' : '';
  });
}

window.initAgentPage = initAgentPage;
