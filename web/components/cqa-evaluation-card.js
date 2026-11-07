// <cqa-evaluation-card conversation-id="..."> — транскрипт, оценка по критериям,
// переход к реплике/фрагменту звонка, апелляция, история оценок.
import { api, esc, answerLabel, answerClass, fmtTotal, speakerLabel, timeLabel, getPref, setPref, toast } from '../api.js';

class CqaEvaluationCard extends HTMLElement {
  async connectedCallback() {
    this.convId = this.getAttribute('conversation-id');
    this.innerHTML = '<div class="empty"><span class="spinner"></span> Загрузка…</div>';
    try {
      const [conv, evals, checklists] = await Promise.all([api.conversation(this.convId), api.conversationEvaluations(this.convId), api.checklists()]);
      this.conv = conv; this.evals = evals; this.checklists = checklists;
      if (evals[0]) this.ev = await api.evaluation(evals[0].evaluation_id);
      this.render();
    } catch (e) { this.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
  }

  async selectEvaluation(id) { this.ev = await api.evaluation(id); this.render(); }

  render() {
    const c = this.conv, ev = this.ev;
    const isCall = c.channel === 'voice call';
    const clSel = getPref('checklist', this.checklists[0]?.id);
    this.innerHTML = `
      <div class="toolbar">
        <a href="#/list" class="btn">← К списку</a>
        <h1 style="margin:0">${esc(c.conversation_id)}</h1>
        <span class="pill pill-info">${isCall ? 'Звонок' : 'Чат'}</span>
        <span class="pill pill-info">${esc(c.language)}</span>
        <span class="spacer"></span>
        <label class="inline">Чек-лист
          <select id="cl">${this.checklists.map(x => `<option value="${esc(x.id)}" ${x.id === clSel ? 'selected' : ''}>${esc(x.name)} · v${x.version}</option>`).join('')}</select></label>
        <button class="primary" id="run">${ev ? 'Переоценить' : 'Оценить'}</button>
      </div>
      <div class="layout">
        <div>${ev ? this.renderEvaluation(ev) : '<div class="card empty">Диалог ещё не оценён. Выберите чек-лист и нажмите «Оценить».</div>'}</div>
        <div class="card sticky">
          <div class="toolbar" style="margin-bottom:8px"><h3>Транскрипт</h3><span class="small muted">${c.transcript.length} реплик · оператор <span class="pill" style="background:#eef6f2">зелёный</span></span></div>
          ${isCall ? `<audio id="audio" controls preload="none" src="${api.audioUrl(c.conversation_id)}"></audio>
            <div class="small muted" id="audioMsg" style="margin:-4px 0 8px">Клик по ▶ у реплики или по ссылке в обосновании перематывает запись. <a href="${esc(c.audio_url)}" target="_blank" rel="noopener">Открыть запись отдельно</a></div>` : ''}
          <div class="transcript" id="tr">${c.transcript.map(t => `
            <div class="turn ${t.speaker}" id="t-${t.id}">
              <div class="num">${t.id}</div>
              <div><div class="meta">${speakerLabel[t.speaker] || t.speaker} · ${esc(timeLabel(t, c.channel))}${isCall && t.offset_sec != null ? ` <button class="play" data-seek="${t.offset_sec}" title="Слушать с этого места">▶</button>` : ''}</div>
              <div>${esc(t.text)}</div></div>
            </div>`).join('')}</div>
        </div>
      </div>`;
    this.bind();
  }

  renderEvaluation(ev) {
    const changed = ev.total !== ev.original_total;
    const appeals = ev.appeals || [];
    const bySection = {};
    for (const it of ev.items) (bySection[it.section] ||= []).push(it);
    const secTitle = id => ev.sections.find(s => s.id === id)?.title || id;
    const f = ev.facts || {};
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="summary">
          <div class="block"><div class="small muted">Итог</div><div class="total">${fmtTotal(ev.total)}</div>
            ${changed ? `<div class="small muted">исходно ${fmtTotal(ev.original_total)} → после апелляций</div>` : '<div class="small muted">из 100</div>'}</div>
          <div class="block"><div class="small muted">Грубые ошибки</div>${ev.critical_error ? '<span class="flag">ВЫЯВЛЕНЫ</span>' : '<span class="pill pill-good">нет</span>'}</div>
          ${ev.sections.filter(s => s.max != null).map(s => `<div class="block"><div class="small muted">${esc(s.title)}</div><b>${fmtTotal(s.points)}</b> <span class="muted small">/ ${fmtTotal(s.max)}</span></div>`).join('')}
        </div>
        <div class="toolbar small muted" style="margin:12px 0 0">
          <span>Чек-лист v${ev.checklist_version} · ${esc(ev.model)} · ${new Date(ev.created_at).toLocaleString('ru-RU')}</span>
          ${ev.usage?.cost_usd != null ? `<span>· $${ev.usage.cost_usd.toFixed(4)} · ${(ev.usage.latency_ms / 1000).toFixed(1)} с${ev.usage.attempts > 1 ? ' · повтор' : ''}</span>` : ''}
          ${this.evals.length > 1 ? `<span class="spacer"></span><label class="inline">История <select id="hist">${this.evals.map(e => `<option value="${e.evaluation_id}" ${e.evaluation_id === ev.evaluation_id ? 'selected' : ''}>${new Date(e.created_at).toLocaleTimeString('ru-RU')} · v${e.checklist_version} · ${fmtTotal(e.total)}</option>`).join('')}</select></label>` : ''}
        </div>
        <div class="facts" style="margin-top:8px">Факты системы: первая реплика оператора <b>${f.first_operator_turn_id != null ? '№' + f.first_operator_turn_id : 'нет'}</b>${f.first_response_sec != null ? `, до первой реакции <b>${Math.floor(f.first_response_sec / 60)} мин ${f.first_response_sec % 60} с</b>` : ''}, пауз > порога: <b>${f.long_waits?.length || 0}</b></div>
      </div>
      ${Object.entries(bySection).map(([sid, items]) => {
        const s = ev.sections.find(x => x.id === sid);
        return `<div class="section-title"><span>${esc(secTitle(sid))}</span>${s?.max != null ? `<span class="small">${fmtTotal(s.points)} / ${fmtTotal(s.max)}</span>` : ''}</div>
          ${items.map(it => this.renderItem(it, appeals.filter(a => a.criterion_id === it.criterion_id), ev)).join('')}`;
      }).join('')}`;
  }

  renderItem(it, appeals, ev) {
    const orig = ev.original_items?.find(o => o.criterion_id === it.criterion_id);
    const open = appeals.find(a => a.status === 'open');
    const resolved = appeals.filter(a => a.status === 'resolved');
    const pts = it.type === 'critical_flag' ? 'без баллов'
      : it.points == null ? `вес ${it.weight} · исключён (N/A)`
      : `${fmtTotal(it.points)} из ${fmtTotal(it.effective_weight)} · вес ${it.weight}`;
    return `<div class="crit ${it.overridden ? 'overridden' : ''}" data-crit="${esc(it.criterion_id)}">
      <div class="crit-head">
        <h3>${esc(it.title)}</h3>
        <span class="pill ${answerClass(it)}">${answerLabel(it)}</span>
        <span class="pts">${pts}</span>
      </div>
      <div class="expl">${esc(it.explanation)}</div>
      <div>${it.evidence_ids.map(id => `<button class="ev" data-ev="${id}">реплика №${id}</button>`).join('')}
        ${it.checked_range ? `<button class="ev" data-range="${it.checked_range.join('-')}">проверен участок №${it.checked_range[0]}–${it.checked_range[1]}</button>` : ''}</div>
      ${it.overridden && orig ? `<div class="small" style="margin-top:6px">Исходная оценка модели: <span class="pill ${answerClass(orig)}">${answerLabel(orig)}</span>${it.reviewer_reason ? ` · Причина изменения: ${esc(it.reviewer_reason)}` : ''}</div>` : ''}
      ${resolved.map(a => `<div class="appeal-box small"><b>Апелляция рассмотрена:</b> «${esc(a.comment)}» → ${a.decision.action === 'confirm' ? 'оценка подтверждена' : 'оценка изменена'}. Причина: ${esc(a.decision.reason)}. Итог ${fmtTotal(a.decision.total_before)} → ${fmtTotal(a.decision.total_after)}</div>`).join('')}
      ${open ? `<div class="appeal-box small"><b>Апелляция на рассмотрении:</b> «${esc(open.comment)}» · <a href="#/appeals">открыть очередь проверяющего</a></div>`
        : `<div style="margin-top:6px"><button class="small" data-appeal="${esc(it.criterion_id)}">Оспорить</button></div>
           <div class="appeal-box" data-form="${esc(it.criterion_id)}" hidden>
             <textarea rows="2" placeholder="Почему вы не согласны с оценкой? Можно указать номера реплик."></textarea>
             <div class="toolbar" style="margin:6px 0 0"><button class="primary small" data-submit="${esc(it.criterion_id)}">Отправить апелляцию</button><button class="small" data-cancel="${esc(it.criterion_id)}">Отмена</button></div>
           </div>`}
    </div>`;
  }

  bind() {
    this.querySelector('#run').onclick = () => this.run();
    this.querySelector('#cl').onchange = e => setPref('checklist', e.target.value);
    const hist = this.querySelector('#hist');
    if (hist) hist.onchange = () => this.selectEvaluation(hist.value);
    this.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => this.focusTurns([Number(b.dataset.ev)]));
    this.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
      const [a, z] = b.dataset.range.split('-').map(Number);
      this.focusTurns(Array.from({ length: z - a + 1 }, (_, k) => a + k), true);
    });
    this.querySelectorAll('[data-seek]').forEach(b => b.onclick = () => this.seek(Number(b.dataset.seek)));
    this.querySelectorAll('[data-appeal]').forEach(b => b.onclick = () => {
      b.parentElement.hidden = true;
      const f = this.querySelector(`[data-form="${b.dataset.appeal}"]`); f.hidden = false; f.querySelector('textarea').focus();
    });
    this.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => {
      this.querySelector(`[data-form="${b.dataset.cancel}"]`).hidden = true;
      this.querySelector(`[data-appeal="${b.dataset.cancel}"]`).parentElement.hidden = false;
    });
    this.querySelectorAll('[data-submit]').forEach(b => b.onclick = () => this.submitAppeal(b.dataset.submit));
    const audio = this.querySelector('#audio');
    if (audio) audio.onerror = () => { this.querySelector('#audioMsg').innerHTML = `Запись не удалось загрузить через сервер. <a href="${esc(this.conv.audio_url)}" target="_blank" rel="noopener">Открыть запись в новой вкладке</a>`; };
  }

  focusTurns(ids, range = false) {
    this.querySelectorAll('.turn.hl, .turn.inrange').forEach(t => t.classList.remove('hl', 'inrange'));
    ids.forEach((id, k) => {
      const el = this.querySelector(`#t-${id}`);
      if (!el) return;
      if (range) el.classList.add('inrange');
      if (!range || k === 0) el.classList.add('hl');
    });
    const first = this.querySelector(`#t-${ids[0]}`);
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = this.conv.transcript[ids[0]];
    if (this.conv.channel === 'voice call' && t?.offset_sec != null) this.seek(t.offset_sec);
    this.dispatchEvent(new CustomEvent('cqa:evidence-click', { bubbles: true, detail: { msg_id: ids[0] } }));
  }

  seek(sec) {
    const a = this.querySelector('#audio');
    if (!a) return;
    const go = () => { a.currentTime = sec; a.play().catch(() => {}); };
    if (a.readyState >= 1) go(); else { a.addEventListener('loadedmetadata', go, { once: true }); a.load(); }
  }

  async run() {
    const btn = this.querySelector('#run');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Оцениваю…';
    try {
      const checklist_id = this.querySelector('#cl').value;
      const ev = await api.evaluate({ conversation_id: this.convId, checklist_id });
      this.evals = await api.conversationEvaluations(this.convId);
      this.ev = await api.evaluation(ev.evaluation_id);
      toast(`Оценено: итог ${fmtTotal(ev.total)}`);
      this.render();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Оценить'; }
  }

  async submitAppeal(critId) {
    const text = this.querySelector(`[data-form="${critId}"] textarea`).value.trim();
    if (!text) return toast('Добавьте комментарий', 'err');
    const ids = [...text.matchAll(/(?:№|#)\s?(\d+)/g)].map(m => Number(m[1]));
    try {
      await api.createAppeal({ evaluation_id: this.ev.evaluation_id, criterion_id: critId, comment: text, evidence_ids: ids });
      toast('Апелляция сохранена');
      this.ev = await api.evaluation(this.ev.evaluation_id);
      this.render();
    } catch (e) { toast(e.message, 'err'); }
  }
}
customElements.define('cqa-evaluation-card', CqaEvaluationCard);
