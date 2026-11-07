// Единственное место расчёта баллов и итога. См. docs/contracts.md, раздел «Расчёт итога».

function round(x, digits) {
  const f = Math.pow(10, digits);
  return Math.round((x + Number.EPSILON) * f) / f;
}

function scaleMax(criterion) {
  return Math.max(...criterion.scale.map(s => Number(s.value)));
}

// Проверка ответа модели (или ручного решения) против чек-листа.
// items: [{criterion_id, answer, scale_value, explanation, evidence_ids, checked_range}]
function validateItems(checklist, items, nTurns) {
  const errors = [];
  const byId = new Map();
  for (const it of items || []) {
    if (byId.has(it.criterion_id)) errors.push(`Критерий ${it.criterion_id} встречается дважды`);
    byId.set(it.criterion_id, it);
  }
  for (const c of checklist.criteria) {
    const it = byId.get(c.id);
    if (!it) { errors.push(`Нет ответа по критерию ${c.id}`); continue; }
    if (it.answer === 'na') {
      if (!c.na_allowed) errors.push(`${c.id}: N/A не разрешён для этого критерия`);
    } else if (c.type === 'scale') {
      const allowed = c.scale.map(s => Number(s.value));
      if (!allowed.includes(Number(it.scale_value)))
        errors.push(`${c.id}: ступень ${it.scale_value} не из шкалы [${allowed.join(', ')}]`);
    } else if (!['yes', 'no'].includes(it.answer)) {
      errors.push(`${c.id}: ответ должен быть yes, no${c.na_allowed ? ' или na' : ''}`);
    }
    if (nTurns != null && Array.isArray(it.evidence_ids)) {
      for (const id of it.evidence_ids)
        if (!Number.isInteger(id) || id < 0 || id >= nTurns) errors.push(`${c.id}: реплики №${id} нет в транскрипте`);
    }
  }
  for (const id of byId.keys())
    if (!checklist.criteria.find(c => c.id === id)) errors.push(`Лишний критерий ${id}`);
  return errors;
}

// Возвращает { items, sections, total, critical_error }
function score(checklist, items) {
  const digits = checklist.rounding ?? 2;
  const maxTotal = checklist.max_total ?? 100;
  const byId = new Map(items.map(i => [i.criterion_id, i]));

  const share = (c, it) => {
    if (c.type === 'scale') return Number(it.scale_value) / scaleMax(c);
    return it.answer === 'yes' ? 1 : 0;
  };

  const applicable = checklist.criteria.filter(c => c.weight > 0 && c.type !== 'critical_flag' && byId.get(c.id)?.answer !== 'na');
  const W = applicable.reduce((s, c) => s + Number(c.weight), 0);

  const outItems = checklist.criteria.map(c => {
    const it = byId.get(c.id) || {};
    const base = {
      criterion_id: c.id, section: c.section, title: c.title, type: c.type,
      answer: it.answer, scale_value: c.type === 'scale' && it.answer !== 'na' ? Number(it.scale_value) : null,
      scale_max: c.type === 'scale' ? scaleMax(c) : null,
      weight: Number(c.weight || 0),
      explanation: it.explanation || '', evidence_ids: it.evidence_ids || [], checked_range: it.checked_range || null,
      overridden: !!it.overridden,
    };
    if (c.type === 'critical_flag' || !(c.weight > 0) || it.answer === 'na' || W === 0) {
      return { ...base, effective_weight: 0, points: null };
    }
    const ew = Number(c.weight) * maxTotal / W;
    return { ...base, effective_weight: round(ew, digits), points: round(ew * share(c, it), digits), _ew: ew, _pts: ew * share(c, it) };
  });

  const sections = (checklist.sections || []).map(s => {
    const its = outItems.filter(i => i.section === s.id && i._ew);
    if (!its.length) return { id: s.id, title: s.title, points: null, max: null };
    return { id: s.id, title: s.title,
      points: round(its.reduce((a, i) => a + i._pts, 0), digits),
      max: round(its.reduce((a, i) => a + i._ew, 0), digits) };
  });

  const total = W === 0 ? null : round(outItems.reduce((a, i) => a + (i._pts || 0), 0), digits);
  const critical_error = checklist.criteria.some(c => c.type === 'critical_flag' && byId.get(c.id)?.answer === 'yes');

  for (const i of outItems) { delete i._ew; delete i._pts; }
  return { items: outItems, sections, total, critical_error };
}

module.exports = { score, validateItems, round };
