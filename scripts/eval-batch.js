// Пакетная оценка набора через запущенный сервер: node scripts/eval-batch.js <group_id> [checklist_id]
const base = `http://localhost:${process.env.PORT || 3000}/api`;
const group = process.argv[2] || 'DEV';
const checklist = process.argv[3] || 'cqa-chat-v1';

(async () => {
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const job = await post('/evaluations/batch', { group_id: group, checklist_id: checklist });
  if (job.error) { console.error(job.error); process.exit(1); }
  console.log(`Задача ${job.job_id}: ${job.total} диалогов`);
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await fetch(`${base}/evaluations/batch/${job.job_id}`).then(r => r.json());
    process.stdout.write(`\r  готово ${s.done}/${s.total}, ошибок ${s.failed}   `);
    if (s.finished) { console.log('\n'); s.errors.forEach(e => console.log(' ✗', e.conversation_id, e.error)); break; }
  }
  const list = await fetch(`${base}/conversations?group_id=${group}`).then(r => r.json());
  const evs = await Promise.all(list.items.filter(i => i.last_evaluation).map(i => fetch(`${base}/evaluations/${i.last_evaluation.evaluation_id}`).then(r => r.json())));
  const cost = evs.reduce((a, e) => a + (e.usage?.cost_usd || 0), 0);
  const lat = evs.reduce((a, e) => a + (e.usage?.latency_ms || 0), 0);
  const tot = evs.filter(e => e.total != null);
  console.log(`Оценено: ${evs.length}. Средний итог: ${(tot.reduce((a, e) => a + e.total, 0) / (tot.length || 1)).toFixed(2)}`);
  console.log(`Грубые ошибки: ${evs.filter(e => e.critical_error).map(e => e.conversation_id).join(', ') || 'нет'}`);
  console.log(`Стоимость: всего $${cost.toFixed(4)}, на диалог $${(cost / (evs.length || 1)).toFixed(4)}. Среднее время: ${(lat / (evs.length || 1) / 1000).toFixed(1)} с`);
})();
