// Все запросы к бэкенду — только здесь. Для Dynamics 365 задайте window.CQA_API_BASE.
const BASE = (window.CQA_API_BASE || '') + '/api';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Ошибка ${res.status}`);
  return json;
}

export const api = {
  health: () => req('GET', '/health'),
  conversations: (q = {}) => req('GET', '/conversations?' + new URLSearchParams(q)),
  conversation: id => req('GET', `/conversations/${encodeURIComponent(id)}`),
  conversationEvaluations: id => req('GET', `/conversations/${encodeURIComponent(id)}/evaluations`),
  loadGroup: group_id => req('POST', '/datasets/load', { group_id }),
  uploadDataset: (json, group_id) => req('POST', '/datasets/upload', { json, group_id }),
  checklists: () => req('GET', '/checklists'),
  checklist: (id, version) => req('GET', `/checklists/${encodeURIComponent(id)}` + (version ? `?version=${version}` : '')),
  saveChecklist: data => req('POST', '/checklists', data),
  evaluate: body => req('POST', '/evaluations', body),
  evaluation: id => req('GET', `/evaluations/${encodeURIComponent(id)}`),
  batch: body => req('POST', '/evaluations/batch', body),
  batchStatus: id => req('GET', `/evaluations/batch/${id}`),
  appeals: status => req('GET', '/appeals' + (status ? `?status=${status}` : '')),
  createAppeal: body => req('POST', '/appeals', body),
  decide: (id, body) => req('POST', `/appeals/${id}/decision`, body),
  audioUrl: convId => `${BASE}/audio?conversation_id=${encodeURIComponent(convId)}`,
};

// ---- общие помощники интерфейса ----
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function answerLabel(item) {
  if (!item || item.answer == null) return '—';
  if (item.answer === 'na') return 'N/A';
  if (item.type === 'scale' || item.answer === 'scored') return `${item.scale_value} из ${item.scale_max ?? '?'}`;
  return item.answer === 'yes' ? 'Да' : 'Нет';
}
export function answerClass(item) {
  if (!item) return '';
  if (item.answer === 'na') return 'pill-na';
  if (item.type === 'critical_flag') return item.answer === 'yes' ? 'pill-bad' : 'pill-good';
  if (item.answer === 'scored') {
    const r = item.scale_value / (item.scale_max || 1);
    return r >= 1 ? 'pill-good' : r >= 0.5 ? 'pill-mid' : 'pill-bad';
  }
  return item.answer === 'yes' ? 'pill-good' : 'pill-bad';
}
export const fmtTotal = t => (t == null ? '—' : Number(t).toFixed(2));
export const speakerLabel = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export function getPref(key, def) { try { return localStorage.getItem('cqa.' + key) ?? def; } catch { return def; } }
export function setPref(key, val) { try { localStorage.setItem('cqa.' + key, val); } catch { /* ignore */ } }

export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  el.style.bottom = `${20 + document.querySelectorAll('.toast').length * 52}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function timeLabel(t, channel) {
  if (channel === 'voice call' && t.offset_sec != null) {
    const m = Math.floor(t.offset_sec / 60), s = Math.floor(t.offset_sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return t.timestamp;
}
