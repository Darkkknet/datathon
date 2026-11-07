// Загрузка наборов диалогов: из API организаторов (по group_id) или из JSON-файла.
const fs = require('fs');
const path = require('path');

function parseTs(ts) {
  if (/^\d{1,3}:\d{2}$/.test(ts)) { const [m, s] = ts.split(':').map(Number); return m * 60 + s; }
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t / 1000;
}

// Добавляет id и offset_sec (секунды от первой реплики) каждой реплике. Исходный timestamp не меняется.
function normalize(record) {
  const t0 = parseTs(record.transcript[0]?.timestamp);
  const transcript = record.transcript.map((t, i) => {
    const s = parseTs(t.timestamp);
    return { ...t, id: i, offset_sec: s != null && t0 != null ? Math.max(0, Math.round((s - t0) * 10) / 10) : null };
  });
  return { ...record, transcript };
}

function parsePayload(json) {
  const recs = json?.data?.records || json?.records || (Array.isArray(json) ? json : null);
  if (!recs) throw new Error(json?.error || 'В ответе нет data.records');
  return { group_id: json?.data?.dataset_group_id || null, records: recs.map(normalize) };
}

async function fetchGroup(groupId) {
  const base = process.env.DATA_API_URL;
  if (!base) throw new Error('Не задан DATA_API_URL в .env');
  const url = new URL(base);
  url.searchParams.set('group_id', groupId);
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`API организаторов ответил ${res.status}`);
  const json = await res.json();
  if (json.isSuccess === false) throw new Error(json.error || 'isSuccess=false');
  const out = parsePayload(json);
  // сохраняем копию, чтобы работать офлайн
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${groupId}.json`), JSON.stringify(json));
  return { ...out, group_id: out.group_id || groupId };
}

function loadFile(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsePayload(json);
}

module.exports = { fetchGroup, loadFile, parsePayload, normalize, parseTs };
