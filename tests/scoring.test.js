const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { score, validateItems } = require('../server/scoring');
const cl = require(path.join(__dirname, '..', 'config', 'checklist_v1.json'));

const all = (over = {}) => cl.criteria.map(c => ({
  criterion_id: c.id,
  answer: c.type === 'scale' ? 'scored' : c.type === 'critical_flag' ? 'no' : 'yes',
  scale_value: c.type === 'scale' ? Math.max(...c.scale.map(s => s.value)) : null,
  evidence_ids: [],
  ...(over[c.id] || {}),
}));

test('все «Да» и верхние ступени → 100', () => {
  assert.strictEqual(score(cl, all()).total, 100);
});

test('пример из чек-листа: N/A у c03 и c07 → 87.33', () => {
  const r = score(cl, all({ c03: { answer: 'na' }, c07: { answer: 'na' }, c04: { scale_value: 15 }, c06: { scale_value: 7 } }));
  assert.strictEqual(r.total, 87.33);
  const ew = r.items.filter(i => i.points != null).reduce((a, i) => a + i.effective_weight, 0);
  assert.ok(Math.abs(ew - 100) < 0.05, 'перераспределённые веса дают 100');
});

test('«Нет» даёт ноль', () => {
  const r = score(cl, all({ c01: { answer: 'no' } }));
  assert.strictEqual(r.total, 90);
});

test('все весовые критерии N/A невозможно (есть не-N/A), но при W=0 итог null', () => {
  const tiny = { ...cl, criteria: cl.criteria.filter(c => c.na_allowed || c.type === 'critical_flag') };
  const r = score(tiny, tiny.criteria.map(c => ({ criterion_id: c.id, answer: c.type === 'critical_flag' ? 'no' : 'na' })));
  assert.strictEqual(r.total, null);
});

test('грубая ошибка не меняет итог, но ставит флаг', () => {
  const r = score(cl, all({ c08: { answer: 'yes' } }));
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.critical_error, true);
});

test('секции считаются', () => {
  const r = score(cl, all({ c03: { answer: 'na' } }));
  const safety = r.sections.find(s => s.id === 'safety');
  assert.strictEqual(safety.points, safety.max);
});

test('валидация: N/A там, где нельзя; ступень не из шкалы; лишний/пропущенный критерий', () => {
  assert.ok(validateItems(cl, all({ c01: { answer: 'na' } }), 20).some(e => e.includes('c01')));
  assert.ok(validateItems(cl, all({ c04: { scale_value: 12 } }), 20).some(e => e.includes('c04')));
  assert.ok(validateItems(cl, all().slice(1), 20).some(e => e.includes('c01')));
  assert.ok(validateItems(cl, all({ c01: { evidence_ids: [99] } }), 20).some(e => e.includes('99')));
  assert.deepStrictEqual(validateItems(cl, all(), 20), []);
});

test('новый критерий со шкалой 0–5 считается без правки кода', () => {
  const cl2 = { ...cl, criteria: [...cl.criteria.filter(c => c.id !== 'c05'),
    { id: 'c09', section: 'flow', title: 'Новый', type: 'scale', weight: 15, na_allowed: false,
      scale: [{ value: 5, label: 'a' }, { value: 3, label: 'b' }, { value: 0, label: 'c' }] }] };
  const items = all().filter(i => i.criterion_id !== 'c05').concat([{ criterion_id: 'c09', answer: 'scored', scale_value: 3 }]);
  assert.deepStrictEqual(validateItems(cl2, items, 10), []);
  assert.strictEqual(score(cl2, items).total, 94); // 85 + 15*0.6
});
