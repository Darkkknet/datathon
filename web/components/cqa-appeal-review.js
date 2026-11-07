// <cqa-appeal-review> — очередь проверяющего: спорная оценка, комментарий, фрагмент диалога, решение.
import { api, esc, answerLabel, answerClass, fmtTotal, speakerLabel, timeLabel, toast } from '../api.js';

class CqaAppealReview extends HTMLElement {
  connectedCallback() { this.status = 'open'; this.load(); }

  async load() {
    this.innerHTML = '<div class="empty"><span class="spinner"></span> Загрузка…</div>';
    try { this.items = await api.appeals(this.status === 'all' ? '' : this.status); this.render(); }
    catch (e) { this.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
  }

  render() {
    this.innerHTML = `
      <h1>Апелляции · рабочее место проверяющего</h1>
      <div class="toolbar">
        ${[['open', 'Открытые'], ['resolved', 'Рассмотренные'], ['all', 'Все']].map(([v, t]) => `<button class="${this.status === v ? 'primary' : ''}" data-st="${v}">${t}</button>`).join('')}
      </div>
      ${this.items.length ? this.items.map(a => this.renderAppeal(a)).join('') : '<div class="card empty">Нет апелляций</div>'}`;
    this.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { this.status = b.dataset.st; this.load(); });
    this.querySelectorAll('form[data-ap]').forEach(f => this.bindForm(f));
  }

  options(crit) {
    if (!crit) return [];
    if (crit.type === 'scale') return [...crit.scale.map(s => [`s:${s.value}`, `${s.value} — ${s.label}`]), ...(crit.na_allowed ? [['na', 'N/A']] : [])];
    return [['yes', 'Да'], ['no', 'Нет'], ...(crit.na_allowed ? [['na', 'N/A']] : [])];
  }

  renderAppeal(a) {
    const it = a.original_item || a.item;
    const hl = new Set([...(a.item?.evidence_ids || []), ...(a.evidence_ids || [])]);
    return `<div class="card" style="margin-bottom:12px">
      <div class="toolbar" style="margin-bottom:8px">
        <a href="#/conv/${encodeURIComponent(a.conversation_id)}"><b>${esc(a.conversation_id)}</b></a>
        <span class="pill pill-info">${a.channel === 'voice call' ? 'Звонок' : 'Чат'} · ${esc(a.language || '')}</span>
        <span class="spacer"></span>
        <span class="small muted">${new Date(a.created_at).toLocaleString('ru-RU')}</span>
        ${a.status === 'open' ? '<span class="pill pill-mid">на рассмотрении</span>' : '<span class="pill pill-good">рассмотрена</span>'}
      </div>
      <div class="grid2">
        <div>
          <div class="small muted">Спорный критерий</div>
          <h3>${esc(a.criterion?.title || a.criterion_id)} <span class="pill ${answerClass(it)}">${answerLabel(it)}</span></h3>
          <div class="small muted" style="margin:4px 0">${esc(a.criterion?.yes_rule || '')}</div>
          <div><b class="small">Обоснование модели:</b> ${esc(it?.explanation)}</div>
          <div class="appeal-box"><b class="small">Комментарий оператора:</b> ${esc(a.comment)}</div>
          <div class="small muted" style="margin-top:8px">Итог диалога сейчас: <b>${fmtTotal(a.total)}</b> (исходно ${fmtTotal(a.original_total)})</div>
        </div>
        <div>
          <div class="small muted">Фрагмент диалога</div>
          <div style="max-height:260px;overflow:auto">${a.fragment.map(t => `<div class="turn ${t.speaker} ${hl.has(t.id) ? 'hl' : ''}"><div class="num">${t.id}</div><div><div class="meta">${speakerLabel[t.speaker]} · ${esc(timeLabel(t, a.channel))}</div>${esc(t.text)}</div></div>`).join('') || '<span class="muted small">Нет ссылок на реплики</span>'}</div>
        </div>
      </div>
      ${a.status === 'open' ? `
      <form data-ap="${a.appeal_id}" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
        <div class="toolbar">
          <label class="inline"><input type="radio" name="action" value="confirm" checked> Подтвердить оценку</label>
          <label class="inline"><input type="radio" name="action" value="change"> Изменить на</label>
          <select name="newval" disabled>${this.options(a.criterion).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select>
        </div>
        <textarea name="reason" rows="2" placeholder="Причина решения (обязательно)"></textarea>
        <div class="toolbar" style="margin:8px 0 0"><button class="primary" type="submit">Сохранить решение</button></div>
      </form>` : `
      <div class="appeal-box" style="margin-top:12px"><b>Решение:</b> ${a.decision.action === 'confirm' ? 'оценка подтверждена' : `оценка изменена на «${a.item ? answerLabel(a.item) : esc(a.decision.new_answer)}»`}.
        Причина: ${esc(a.decision.reason)}. Итог: ${fmtTotal(a.decision.total_before)} → <b>${fmtTotal(a.decision.total_after)}</b></div>`}
    </div>`;
  }

  bindForm(f) {
    const sel = f.querySelector('[name=newval]');
    f.querySelectorAll('[name=action]').forEach(r => r.onchange = () => { sel.disabled = f.querySelector('[name=action]:checked').value !== 'change'; });
    f.onsubmit = async e => {
      e.preventDefault();
      const reason = f.querySelector('[name=reason]').value.trim();
      if (!reason) return toast('Укажите причину решения', 'err');
      const action = f.querySelector('[name=action]:checked').value;
      const body = { action, reason };
      if (action === 'change') {
        const v = sel.value;
        if (v.startsWith('s:')) { body.new_answer = 'scored'; body.new_scale_value = Number(v.slice(2)); } else body.new_answer = v;
      }
      try {
        const r = await api.decide(f.dataset.ap, body);
        toast(`Решение сохранено. Итог ${fmtTotal(r.appeal.decision.total_before)} → ${fmtTotal(r.appeal.decision.total_after)}`);
        this.load();
      } catch (err) { toast(err.message, 'err'); }
    };
  }
}
customElements.define('cqa-appeal-review', CqaAppealReview);
