// Простое хранилище: один JSON-файл storage/db.json. Без внешних зависимостей.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'storage', 'db.json');

let db = null;

function load() {
  if (db) return db;
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } else {
    db = { checklists: [], conversations: {}, evaluations: {}, appeals: {}, seq: 0 };
  }
  if (!db.checklists.length) {
    const initial = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'checklist_v1.json'), 'utf8'));
    db.checklists.push({ ...initial, version: 1, saved_at: new Date().toISOString() });
    save();
  }
  return db;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}
function flush() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_PATH);
}

function newId(prefix) {
  load().seq += 1;
  return `${prefix}_${Date.now().toString(36)}${db.seq}`;
}

// ---- чек-листы (версии) ----
function listChecklists() {
  const latest = {};
  for (const c of load().checklists) if (!latest[c.id] || latest[c.id].version < c.version) latest[c.id] = c;
  return Object.values(latest).map(c => ({ ...c, versions: db.checklists.filter(x => x.id === c.id).map(x => x.version) }));
}
function getChecklist(id, version) {
  const all = load().checklists.filter(c => c.id === id);
  if (!all.length) return null;
  if (version == null) return all.reduce((a, b) => (a.version > b.version ? a : b));
  return all.find(c => c.version === Number(version)) || null;
}
function saveChecklist(data) {
  const prev = getChecklist(data.id);
  const version = prev ? prev.version + 1 : 1;
  const rec = { ...data, version, saved_at: new Date().toISOString() };
  load().checklists.push(rec);
  save();
  return rec;
}

// ---- диалоги ----
function upsertConversations(records, groupId) {
  load();
  for (const r of records) db.conversations[r.conversation_id] = { ...r, group_id: groupId };
  save();
}
function getConversation(id) { return load().conversations[id] || null; }
function listConversations() { return Object.values(load().conversations); }

// ---- оценки ----
function putEvaluation(ev) { load().evaluations[ev.evaluation_id] = ev; save(); return ev; }
function getEvaluation(id) { return load().evaluations[id] || null; }
function evaluationsFor(convId) {
  return Object.values(load().evaluations).filter(e => e.conversation_id === convId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function latestEvaluation(convId) { return evaluationsFor(convId)[0] || null; }

// ---- апелляции ----
function putAppeal(a) { load().appeals[a.appeal_id] = a; save(); return a; }
function getAppeal(id) { return load().appeals[id] || null; }
function listAppeals(filter = {}) {
  return Object.values(load().appeals)
    .filter(a => (!filter.status || a.status === filter.status) && (!filter.evaluation_id || a.evaluation_id === filter.evaluation_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

module.exports = {
  load, flush, newId,
  listChecklists, getChecklist, saveChecklist,
  upsertConversations, getConversation, listConversations,
  putEvaluation, getEvaluation, evaluationsFor, latestEvaluation,
  putAppeal, getAppeal, listAppeals,
};
