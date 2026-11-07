// Сборка промпта из текущего чек-листа, вызов Claude, валидация ответа, 1 повтор при ошибке.
const fs = require('fs');
const path = require('path');
const { validateItems } = require('./scoring');
const { factsToText } = require('./facts');

const SYSTEM_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts', 'system.md'), 'utf8');

// Цены USD за 1 млн токенов (проверьте актуальность перед защитой)
const PRICES = {
  'claude-sonnet-5-5': { in: 2, out: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cache_read: 0.01, cache_write: 0.125 },
  'claude-opus-5-5': { in: 4, out: 20, cache_read: 0.2, cache_write: 5 },
};

function checklistToText(cl) {
  const out = [];
  for (const s of cl.sections || []) {
    const crits = cl.criteria.filter(c => c.section === s.id);
    if (!crits.length) continue;
    out.push(`### ${s.title}`);
    for (const c of crits) {
      let kind;
      if (c.type === 'scale') kind = `ШКАЛА ${c.scale.map(x => x.value).join('/')}${c.na_allowed ? ' или N/A' : ''}`;
      else if (c.type === 'critical_flag') kind = 'ДА/НЕТ (флаг грубой ошибки, без баллов)';
      else kind = `ДА/НЕТ${c.na_allowed ? '/N/A' : ''}`;
      out.push(`- **${c.id}. ${c.title}** — ${kind}, вес ${c.weight}`);
      if (c.yes_rule) out.push(`  - Да: ${c.yes_rule}`);
      if (c.type === 'scale') for (const s2 of c.scale) out.push(`  - ${s2.value}: ${s2.label}`);
      if (c.na_allowed && c.na_rule) out.push(`  - N/A: ${c.na_rule}`);
      if (c.note) out.push(`  - Примечание: ${c.note}`);
    }
  }
  const orphan = cl.criteria.filter(c => !(cl.sections || []).some(s => s.id === c.section));
  for (const c of orphan) out.push(`- **${c.id}. ${c.title}** — вес ${c.weight}. ${c.yes_rule || ''}`);
  return out.join('\n');
}

function buildSystem(cl) {
  const extra = [];
  if (cl.first_response_threshold_sec) extra.push(`Порог ожидания ответа оператора: ${Math.round(cl.first_response_threshold_sec / 60)} мин. Теги и вложения в оценку не входят.`);
  if (cl.extra_rules) extra.push(cl.extra_rules);
  return SYSTEM_TEMPLATE
    .replace('{{CHECKLIST_NAME}}', cl.name)
    .replace('{{CHECKLIST_VERSION}}', String(cl.version))
    .replace('{{CHECKLIST}}', checklistToText(cl))
    .replace('{{EXTRA_RULES}}', extra.length ? '## Дополнительно\n' + extra.join('\n') : '');
}

function transcriptToText(conv) {
  return conv.transcript.map(t => {
    const time = conv.channel === 'voice call' && t.offset_sec != null ? `+${t.offset_sec}s` : t.timestamp;
    return `[${t.id}] ${time} ${t.speaker}: ${t.text}`;
  }).join('\n');
}

function toolSchema(cl) {
  return {
    name: 'submit_evaluation',
    description: 'Отправить оценку оператора по всем критериям чек-листа',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion_id: { type: 'string', enum: cl.criteria.map(c => c.id) },
              answer: { type: 'string', enum: ['yes', 'no', 'na', 'scored'], description: 'Для шкальных: scored или na' },
              scale_value: { type: ['number', 'null'], description: 'Ступень шкалы для шкальных критериев' },
              explanation: { type: 'string' },
              evidence_ids: { type: 'array', items: { type: 'integer' } },
              checked_range: { type: ['array', 'null'], items: { type: 'integer' } },
            },
            required: ['criterion_id', 'answer', 'explanation', 'evidence_ids'],
          },
        },
      },
      required: ['items'],
    },
  };
}

async function callClaude({ model, system, user, tool, messagesExtra = [] }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.ANTHROPIC_API_KEY}`,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }, ...messagesExtra],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${json?.error?.message || JSON.stringify(json)}`);
  const block = json.content.find(b => b.type === 'tool_use');
  return { input: block?.input, toolUseId: block?.id, usage: json.usage || {} };
}

function cost(model, u) {
  const p = PRICES[model];
  if (!p) return null;
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out +
    (u.cache_read_input_tokens || 0) * p.cache_read + (u.cache_creation_input_tokens || 0) * p.cache_write) / 1e6;
}

function addUsage(a, b) {
  const out = { ...a };
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
    out[k] = (a[k] || 0) + (b[k] || 0);
  out.calls = (a.calls || 0) + 1;
  return out;
}

function normalizeItems(cl, items) {
  return (items || []).map(it => {
    const c = cl.criteria.find(x => x.id === it.criterion_id);
    const o = { ...it };
    if (c?.type === 'scale' && o.answer !== 'na') { o.answer = 'scored'; o.scale_value = Number(o.scale_value); }
    if (c?.type !== 'scale') o.scale_value = null;
    if (!Array.isArray(o.evidence_ids)) o.evidence_ids = [];
    return o;
  });
}

// Mock-режим (без ключа): простая эвристика, чтобы интерфейс работал. Помечается model = "mock".
function mockItems(cl, conv, facts) {
  const firstOp = facts.first_operator_turn_id;
  return cl.criteria.map(c => {
    const ev = firstOp != null ? [firstOp] : [];
    if (c.type === 'critical_flag') return { criterion_id: c.id, answer: 'no', explanation: '[MOCK] Грубых нарушений не найдено.', evidence_ids: [] };
    if (c.type === 'scale') {
      const top = Math.max(...c.scale.map(s => s.value));
      return { criterion_id: c.id, answer: 'scored', scale_value: top, explanation: '[MOCK] Оценка-заглушка без ИИ.', evidence_ids: ev };
    }
    if (c.na_allowed && /идентиф|identif/i.test(c.title)) return { criterion_id: c.id, answer: 'na', explanation: '[MOCK] Запрос не требовал идентификации.', evidence_ids: [] };
    return { criterion_id: c.id, answer: firstOp != null ? 'yes' : 'no', explanation: '[MOCK] Оценка-заглушка без ИИ.', evidence_ids: ev };
  });
}

// ---------- OpenAI-совместимые провайдеры (Gemini бесплатно, OpenRouter, Groq и т.п.) ----------
const PROVIDERS = {
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: 'GEMINI_API_KEY', model: 'gemini-3.8-flash' },
  openai: { url: process.env.OPENAI_BASE_URL ? process.env.OPENAI_BASE_URL.replace(/\/$/, '') + '/chat/completions' : 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
};

function provider() {
  const p = (process.env.PROVIDER || '').toLowerCase();
  if (p === 'mock') return 'mock';
  if (p && p !== 'anthropic') return p;
  if (p === 'anthropic' || process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'mock';
}

function plainSchema(cl) {
  // без type-массивов: некоторые провайдеры (Gemini) их не принимают
  const s = toolSchema(cl).input_schema;
  const it = s.properties.items.items.properties;
  it.scale_value = { type: 'number', description: 'Ступень шкалы для шкальных критериев, иначе 0' };
  it.checked_range = { type: 'array', items: { type: 'integer' }, description: '[с, по] проверенный участок, или пустой массив' };
  return s;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOpenAICompat({ prov, model, system, messages, cl }) {
  const cfg = PROVIDERS[prov];
  if (!cfg) throw new Error(`Неизвестный PROVIDER=${prov}`);
  const key = process.env[cfg.key];
  if (!key) throw new Error(`Не задан ${cfg.key} в .env`);
  const body = {
    model, temperature: 0,
    messages: [{ role: 'system', content: system + '\n\nЕсли инструменты недоступны, ответь ТОЛЬКО JSON вида {"items":[...]}.' }, ...messages],
    tools: [{ type: 'function', function: { name: 'submit_evaluation', description: 'Отправить оценку по всем критериям', parameters: plainSchema(cl) } }],
    tool_choice: 'required',
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 5) { // бесплатные лимиты: ждём и повторяем
      const wait = Number(res.headers.get('retry-after')) * 1000 || 15000 * (attempt + 1);
      await sleep(wait); continue;
    }
    if (!res.ok) throw new Error(`${prov} API ${res.status}: ${json?.error?.message || (Array.isArray(json) && json[0]?.error?.message) || JSON.stringify(json).slice(0, 300)}`);
    const msg = json.choices?.[0]?.message || {};
    let input = null;
    const call = msg.tool_calls?.[0];
    if (call?.function?.arguments) input = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
    else if (msg.content) { const m = String(msg.content).match(/\{[\s\S]*\}/); if (m) input = JSON.parse(m[0]); }
    const u = json.usage || {};
    return { input, raw: msg, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
  }
}

function cleanOpenAIItems(items) {
  return (items || []).map(i => ({ ...i,
    checked_range: Array.isArray(i.checked_range) && i.checked_range.length === 2 ? i.checked_range : null }));
}

async function evaluateOpenAICompat(prov, cl, conv, facts, modelOverride, started) {
  const model = modelOverride || process.env[`${prov.toUpperCase()}_MODEL`] || PROVIDERS[prov]?.model;
  const system = buildSystem(cl);
  const user = `## Факты, посчитанные системой\n${factsToText(facts)}\n\n## Транскрипт (${conv.conversation_id})\n${transcriptToText(conv)}`;
  const messages = [{ role: 'user', content: user }];
  let usage = {};
  let r = await callOpenAICompat({ prov, model, system, messages, cl });
  usage = addUsage(usage, r.usage);
  let items = normalizeItems(cl, cleanOpenAIItems(r.input?.items));
  let errors = validateItems(cl, items, conv.transcript.length);
  let attempts = 1;
  if (errors.length) {
    attempts = 2;
    messages.push({ role: 'assistant', content: JSON.stringify(r.input || {}) },
      { role: 'user', content: 'Ответ не прошёл проверку:\n- ' + errors.join('\n- ') + '\nИсправь и отправь полную оценку заново через submit_evaluation.' });
    r = await callOpenAICompat({ prov, model, system, messages, cl });
    usage = addUsage(usage, r.usage);
    items = normalizeItems(cl, cleanOpenAIItems(r.input?.items));
    errors = validateItems(cl, items, conv.transcript.length);
    if (errors.length) throw new Error('Модель вернула невалидную оценку: ' + errors.join('; '));
  }
  return { model, items, usage, cost_usd: prov === 'gemini' ? 0 : null, latency_ms: Date.now() - started, attempts };
}

function activeModel() {
  const p = provider();
  if (p === 'mock') return 'mock';
  if (p === 'anthropic') return process.env.MODEL || 'claude-sonnet-5-5';
  return process.env[`${p.toUpperCase()}_MODEL`] || PROVIDERS[p]?.model || p;
}

async function evaluateWithLLM(cl, conv, facts, modelOverride) {
  const started = Date.now();
  const prov = modelOverride === 'mock' ? 'mock' : provider();
  if (prov === 'mock') {
    return { model: 'mock', items: mockItems(cl, conv, facts), usage: { calls: 0 }, cost_usd: 0, latency_ms: Date.now() - started, attempts: 1 };
  }
  if (prov !== 'anthropic') return evaluateOpenAICompat(prov, cl, conv, facts, modelOverride, started);
  const model = modelOverride || process.env.MODEL || 'claude-sonnet-5-5';
  const system = buildSystem(cl);
  const tool = toolSchema(cl);
  const user = `## Факты, посчитанные системой\n${factsToText(facts)}\n\n## Транскрипт (${conv.conversation_id})\n${transcriptToText(conv)}`;

  let usage = {};
  let r = await callClaude({ model, system, user, tool });
  usage = addUsage(usage, r.usage);
  let items = normalizeItems(cl, r.input?.items);
  let errors = validateItems(cl, items, conv.transcript.length);
  let attempts = 1;

  if (errors.length) {
    attempts = 2;
    const extra = [
      { role: 'assistant', content: [{ type: 'tool_use', id: r.toolUseId, name: tool.name, input: r.input || {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.toolUseId, is_error: true,
        content: 'Ответ не прошёл проверку:\n- ' + errors.join('\n- ') + '\nИсправь и отправь полную оценку заново.' }] },
    ];
    r = await callClaude({ model, system, user, tool, messagesExtra: extra });
    usage = addUsage(usage, r.usage);
    items = normalizeItems(cl, r.input?.items);
    errors = validateItems(cl, items, conv.transcript.length);
    if (errors.length) throw new Error('Модель вернула невалидную оценку: ' + errors.join('; '));
  }
  return { model, items, usage, cost_usd: cost(model, usage), latency_ms: Date.now() - started, attempts };
}

module.exports = { evaluateWithLLM, buildSystem, transcriptToText, checklistToText, PRICES, provider, activeModel };
