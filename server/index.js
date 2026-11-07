// HTTP-сервер без внешних зависимостей: REST API (/api/...) + статика из web/.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- .env ---
(function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const store = require('./store');
const ds = require('./datasource');
const svc = require('./service');
const { activeModel, provider } = require('./llm');

store.load();

// Автозагрузка локальных наборов из data/*.json при старте, если база пустая
if (!store.listConversations().length) {
  const dir = path.join(ROOT, 'data');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try { const r = ds.loadFile(path.join(dir, f)); store.upsertConversations(r.records, r.group_id || path.basename(f, '.json')); console.log(`Загружено ${r.records.length} диалогов из data/${f}`); }
    catch (e) { console.warn(`Не удалось прочитать data/${f}: ${e.message}`); }
  }
}

// --- маршруты ---
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

function summary(c) {
  const ev = store.latestEvaluation(c.conversation_id);
  const appeals = ev ? store.listAppeals({ evaluation_id: ev.evaluation_id }) : [];
  return { conversation_id: c.conversation_id, channel: c.channel, language: c.language, group_id: c.group_id,
    turns: c.transcript.length, has_audio: !!c.audio_url,
    last_evaluation: ev ? { evaluation_id: ev.evaluation_id, total: ev.total, critical_error: ev.critical_error, checklist_version: ev.checklist_version, model: ev.model, created_at: ev.created_at } : null,
    open_appeals: appeals.filter(a => a.status === 'open').length };
}

route('GET', '/api/health', () => ({ ok: true, model: activeModel(), provider: provider(), data_api: !!process.env.DATA_API_URL }));

route('POST', '/api/datasets/load', async (req, body) => {
  if (!body.group_id) throw svc.httpErr(400, 'Укажите group_id');
  const r = await ds.fetchGroup(body.group_id.trim());
  store.upsertConversations(r.records, r.group_id);
  return { group_id: r.group_id, loaded: r.records.length };
});
route('POST', '/api/datasets/upload', async (req, body) => {
  const r = ds.parsePayload(body.json || body);
  const g = body.group_id || r.group_id || 'UPLOAD';
  store.upsertConversations(r.records, g);
  return { group_id: g, loaded: r.records.length };
});

route('GET', '/api/conversations', (req, body, q) => {
  let list = store.listConversations();
  if (q.group_id) list = list.filter(c => c.group_id === q.group_id);
  if (q.language) list = list.filter(c => c.language === q.language);
  if (q.channel) list = list.filter(c => c.channel === q.channel);
  const groups = [...new Set(store.listConversations().map(c => c.group_id))];
  return { groups, items: list.map(summary).sort((a, b) => a.conversation_id.localeCompare(b.conversation_id)) };
});
route('GET', '/api/conversations/:id', (req, body, q, p) => {
  const c = store.getConversation(p.id);
  if (!c) throw svc.httpErr(404, 'Диалог не найден');
  return c;
});
route('GET', '/api/conversations/:id/evaluations', (req, body, q, p) => store.evaluationsFor(p.id));

route('GET', '/api/checklists', () => store.listChecklists());
route('GET', '/api/checklists/:id', (req, body, q, p) => {
  const c = store.getChecklist(p.id, q.version);
  if (!c) throw svc.httpErr(404, 'Чек-лист не найден');
  return c;
});
route('POST', '/api/checklists', (req, body) => {
  if (!body.id || !body.name || !Array.isArray(body.criteria) || !body.criteria.length) throw svc.httpErr(400, 'Нужны id, name и хотя бы один критерий');
  const ids = new Set();
  for (const c of body.criteria) {
    if (!c.id || ids.has(c.id)) throw svc.httpErr(400, `Пустой или повторяющийся id критерия: ${c.id}`);
    ids.add(c.id);
    if (!['binary', 'scale', 'critical_flag'].includes(c.type)) throw svc.httpErr(400, `${c.id}: неизвестный тип`);
    if (c.type === 'scale' && (!Array.isArray(c.scale) || c.scale.length < 2)) throw svc.httpErr(400, `${c.id}: у шкалы должно быть минимум 2 ступени`);
    if (c.type === 'critical_flag') c.weight = 0;
    c.weight = Number(c.weight) || 0;
  }
  const { version, saved_at, versions, ...data } = body;
  return store.saveChecklist(data);
});

route('POST', '/api/evaluations', async (req, body) => svc.evaluateConversation(body));
route('POST', '/api/evaluations/batch', (req, body) => {
  let ids = body.conversation_ids;
  if (!ids) ids = store.listConversations().filter(c => !body.group_id || c.group_id === body.group_id).map(c => c.conversation_id);
  return svc.startBatch({ conversation_ids: ids, checklist_id: body.checklist_id, model: body.model, concurrency: body.concurrency || Number(process.env.BATCH_CONCURRENCY) || (provider() === 'anthropic' ? 5 : 2) });
});
route('GET', '/api/evaluations/batch/:id', (req, body, q, p) => svc.getJob(p.id) || (() => { throw svc.httpErr(404, 'Задача не найдена'); })());
route('GET', '/api/evaluations/:id', (req, body, q, p) => {
  const ev = store.getEvaluation(p.id);
  if (!ev) throw svc.httpErr(404, 'Оценка не найдена');
  return { ...ev, appeals: store.listAppeals({ evaluation_id: ev.evaluation_id }) };
});

route('POST', '/api/appeals', (req, body) => svc.createAppeal(body));
route('GET', '/api/appeals', (req, body, q) => store.listAppeals({ status: q.status }).map(a => {
  const ev = store.getEvaluation(a.evaluation_id);
  const conv = store.getConversation(a.conversation_id);
  const item = ev?.items.find(i => i.criterion_id === a.criterion_id);
  const orig = ev?.original_items?.find(i => i.criterion_id === a.criterion_id);
  const ids = [...new Set([...(item?.evidence_ids || []), ...(a.evidence_ids || [])])];
  const fragIds = new Set();
  for (const id of ids) for (let k = id - 2; k <= id + 2; k++) fragIds.add(k);
  if (item?.checked_range) for (let k = item.checked_range[0]; k <= item.checked_range[1]; k++) fragIds.add(k);
  const fragment = conv ? conv.transcript.filter(t => fragIds.has(t.id)) : [];
  const cl = ev ? store.getChecklist(ev.checklist_id, ev.checklist_version) : null;
  return { ...a, item, original_item: orig, total: ev?.total, original_total: ev?.original_total,
    criterion: cl?.criteria.find(c => c.id === a.criterion_id), fragment, channel: conv?.channel, language: conv?.language };
}));
route('POST', '/api/appeals/:id/decision', (req, body, q, p) => svc.decideAppeal(p.id, body));

// Прокси для аудио звонков (обходит CORS). Разрешены только хосты из записей набора.
route('GET', '/api/audio', async (req, body, q, p, res) => {
  const conv = store.getConversation(q.conversation_id);
  if (!conv?.audio_url) throw svc.httpErr(404, 'У диалога нет записи');
  const upstream = await fetch(conv.audio_url, { signal: AbortSignal.timeout(60000) });
  if (!upstream.ok) throw svc.httpErr(502, `Запись недоступна: ${upstream.status}`);
  const type = upstream.headers.get('content-type') || 'audio/mpeg';
  const buf = Buffer.from(await upstream.arrayBuffer());
  // Если API вернул JSON с base64 — попробуем достать звук
  if (type.includes('json')) {
    const j = JSON.parse(buf.toString('utf8'));
    const b64 = j.data?.audio || j.data?.content || j.audio || j.content || j.$content;
    const ct = j.data?.content_type || j['$content-type'] || 'audio/mpeg';
    if (typeof b64 === 'string') { res.writeHead(200, { 'content-type': ct }); res.end(Buffer.from(b64, 'base64')); return res; }
    if (typeof (j.data?.url || j.url) === 'string') { res.writeHead(302, { location: j.data?.url || j.url }); res.end(); return res; }
    throw svc.httpErr(502, 'Неизвестный формат ответа записи');
  }
  res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'accept-ranges': 'none' });
  res.end(buf);
  return res;
});

// --- статика ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveStatic(req, res) {
  const u = new URL(req.url, 'http://x');
  let f = path.normalize(path.join(ROOT, 'web', decodeURIComponent(u.pathname)));
  if (!f.startsWith(path.join(ROOT, 'web'))) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(svc.httpErr(400, 'Тело запроса — не JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/')) return serveStatic(req, res);
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-headers', 'content-type'); res.setHeader('access-control-allow-methods', 'GET,POST'); res.writeHead(204); return res.end(); }
  try {
    for (const r of routes) {
      const m = r.method === req.method && u.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await r.handler(req, body, Object.fromEntries(u.searchParams), params, res);
      if (out === res) return;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Нет такого адреса API' }));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`\n  CQA запущен: http://localhost:${PORT}`);
  console.log(`  Модель: ${activeModel() === 'mock' ? 'MOCK (нет ключа API в .env)' : activeModel() + ' (' + provider() + ')'}\n`);
});
process.on('SIGINT', () => { store.flush(); process.exit(0); });
