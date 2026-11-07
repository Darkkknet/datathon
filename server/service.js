// Бизнес-логика: оценка диалога, пакетная оценка, апелляции и решения.
const store = require('./store');
const { score, validateItems } = require('./scoring');
const { computeFacts } = require('./facts');
const { evaluateWithLLM } = require('./llm');

async function evaluateConversation({ conversation_id, checklist_id, checklist_version, model }) {
  const conv = store.getConversation(conversation_id);
  if (!conv) throw httpErr(404, 'Диалог не найден');
  const cl = store.getChecklist(checklist_id || 'cqa-chat-v1', checklist_version);
  if (!cl) throw httpErr(404, 'Чек-лист не найден');

  const facts = computeFacts(conv, cl);
  const llm = await evaluateWithLLM(cl, conv, facts, model);
  const s = score(cl, llm.items);
  const ev = {
    evaluation_id: store.newId('ev'),
    conversation_id, checklist_id: cl.id, checklist_version: cl.version,
    model: llm.model, created_at: new Date().toISOString(), status: 'done',
    facts,
    items: s.items, sections: s.sections, total: s.total, critical_error: s.critical_error,
    original_items: s.items.map(i => ({ ...i })),
    original_total: s.total, original_critical_error: s.critical_error,
    usage: { ...llm.usage, cost_usd: llm.cost_usd, latency_ms: llm.latency_ms, attempts: llm.attempts },
  };
  return store.putEvaluation(ev);
}

// ---- пакетная оценка с ограничением параллельности ----
const jobs = {};
function startBatch({ conversation_ids, checklist_id, model, concurrency = 5 }) {
  const job_id = store.newId('job');
  const job = jobs[job_id] = { job_id, total: conversation_ids.length, done: 0, failed: 0, errors: [], finished: false, started_at: Date.now() };
  const queue = [...conversation_ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { await evaluateConversation({ conversation_id: id, checklist_id, model }); job.done++; }
      catch (e) { job.failed++; job.errors.push({ conversation_id: id, error: e.message }); }
    }
  };
  Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker))
    .then(() => { job.finished = true; job.elapsed_ms = Date.now() - job.started_at; });
  return job;
}
function getJob(id) { return jobs[id] || null; }

// ---- апелляции ----
function createAppeal({ evaluation_id, criterion_id, comment, evidence_ids }) {
  const ev = store.getEvaluation(evaluation_id);
  if (!ev) throw httpErr(404, 'Оценка не найдена');
  if (!ev.items.find(i => i.criterion_id === criterion_id)) throw httpErr(400, 'Нет такого критерия в оценке');
  if (!comment || !comment.trim()) throw httpErr(400, 'Добавьте комментарий');
  const open = store.listAppeals({ evaluation_id }).find(a => a.criterion_id === criterion_id && a.status === 'open');
  if (open) throw httpErr(400, 'По этому критерию уже есть открытая апелляция');
  return store.putAppeal({
    appeal_id: store.newId('ap'), evaluation_id, conversation_id: ev.conversation_id, criterion_id,
    comment: comment.trim(), evidence_ids: evidence_ids || [], status: 'open', created_at: new Date().toISOString(), decision: null,
  });
}

function decideAppeal(appeal_id, { action, new_answer, new_scale_value, reason }) {
  const ap = store.getAppeal(appeal_id);
  if (!ap) throw httpErr(404, 'Апелляция не найдена');
  if (ap.status !== 'open') throw httpErr(400, 'Апелляция уже рассмотрена');
  if (!reason || !reason.trim()) throw httpErr(400, 'Укажите причину решения');
  if (!['confirm', 'change'].includes(action)) throw httpErr(400, 'action: confirm или change');

  const ev = store.getEvaluation(ap.evaluation_id);
  const cl = store.getChecklist(ev.checklist_id, ev.checklist_version);
  const total_before = ev.total;

  if (action === 'change') {
    const c = cl.criteria.find(x => x.id === ap.criterion_id);
    const items = ev.items.map(i => {
      if (i.criterion_id !== ap.criterion_id) return i;
      const answer = c.type === 'scale' && new_answer !== 'na' ? 'scored' : new_answer;
      return { ...i, answer, scale_value: c.type === 'scale' && answer !== 'na' ? Number(new_scale_value) : null,
        overridden: true, explanation: i.explanation, reviewer_reason: reason.trim() };
    });
    const errs = validateItems(cl, items, null);
    if (errs.length) throw httpErr(400, errs.join('; '));
    const s = score(cl, items);
    // сохранить причину проверяющего в пересчитанных элементах
    s.items.forEach(si => { const src = items.find(x => x.criterion_id === si.criterion_id); if (src.reviewer_reason) si.reviewer_reason = src.reviewer_reason; });
    Object.assign(ev, { items: s.items, sections: s.sections, total: s.total, critical_error: s.critical_error });
    store.putEvaluation(ev);
  }

  ap.status = 'resolved';
  ap.decision = { action, new_answer: action === 'change' ? new_answer : null,
    new_scale_value: action === 'change' ? (new_scale_value ?? null) : null,
    reason: reason.trim(), decided_at: new Date().toISOString(), total_before, total_after: ev.total };
  store.putAppeal(ap);
  return { appeal: ap, evaluation: ev };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { evaluateConversation, startBatch, getJob, createAppeal, decideAppeal, httpErr };
