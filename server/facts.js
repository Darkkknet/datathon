// Детерминированные факты о диалоге, которые считает код (а не модель).
// Передаются в промпт как подсказка и показываются в интерфейсе.
const { parseTs } = require('./datasource');

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m} мин ${s} с`;
}

function computeFacts(conv, checklist) {
  const tr = conv.transcript;
  const threshold = checklist.first_response_threshold_sec ?? 180;
  const op = tr.filter(t => t.speaker === 'operator');
  const firstOp = op[0] || null;
  const facts = {
    language: conv.language,
    channel: conv.channel,
    operator_turns: op.length,
    first_operator_turn_id: firstOp ? firstOp.id : null,
    last_operator_turn_id: op.length ? op[op.length - 1].id : null,
    system_events: tr.filter(t => t.speaker === 'system').map(t => ({ id: t.id, text: t.text.slice(0, 120) })),
    long_waits: [],
  };

  // Паузы: от сообщения клиента до следующего ответа оператора дольше порога
  let pendingClient = null;
  for (const t of tr) {
    if (t.speaker === 'client' && pendingClient == null) pendingClient = t;
    if (t.speaker === 'operator') {
      if (pendingClient) {
        const a = parseTs(pendingClient.timestamp), b = parseTs(t.timestamp);
        if (a != null && b != null && b - a > threshold)
          facts.long_waits.push({ from_id: pendingClient.id, to_id: t.id, seconds: Math.round(b - a), text: fmt(b - a) });
      }
      pendingClient = null;
    }
  }

  // Время до первой реакции оператора с момента подключения/первого сообщения клиента
  const firstClient = tr.find(t => t.speaker === 'client');
  if (firstClient && firstOp) {
    const a = parseTs(firstClient.timestamp), b = parseTs(firstOp.timestamp);
    if (a != null && b != null) facts.first_response_sec = Math.max(0, Math.round(b - a));
  }
  return facts;
}

function factsToText(f) {
  const lines = [
    `Язык диалога по данным: ${f.language}. Канал: ${f.channel}.`,
    `Реплик оператора: ${f.operator_turns}.` + (f.first_operator_turn_id != null ? ` Первая реплика оператора: [${f.first_operator_turn_id}].` : ' Оператор не писал.'),
  ];
  if (f.first_response_sec != null) lines.push(`От первого сообщения клиента до первой реплики оператора: ${fmt(f.first_response_sec)} (включая работу бота).`);
  if (f.long_waits.length) lines.push('Паузы дольше порога между сообщением клиента и ответом оператора: ' +
    f.long_waits.map(w => `[${w.from_id}]→[${w.to_id}] ${w.text}`).join('; ') + '.');
  else lines.push('Пауз дольше порога между сообщением клиента и ответом оператора не найдено.');
  return lines.join('\n');
}

module.exports = { computeFacts, factsToText };
