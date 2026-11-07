// <cqa-checklist-editor> — редактирование чек-листа: критерии, формулировки, вес, тип, N/A, шкала.
// Каждое сохранение создаёт новую версию. Кнопка «Применить» переоценивает диалоги новой версией.
import { api, esc, getPref, setPref, toast } from '../api.js';

const TYPES = [['binary', 'Да / Нет'], ['scale', 'Шкала'], ['critical_flag', 'Грубая ошибка (флаг, без баллов)']];

class CqaChecklistEditor extends HTMLElement {
  async connectedCallback() {
    this.innerHTML = '<div class="empty"><span class="spinner"></span> Загрузка…</div>';
    try {
      this.list = await api.checklists();
      const id = getPref('checklist', this.list[0]?.id);
      await this.open(id);
    } catch (e) { this.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
  }

  async open(id, version) {
    const cl = await api.checklist(id, version);
    this.cl = JSON.parse(JSON.stringify(cl));
    this.meta = this.list.find(x => x.id === id);
    this.dirty = false;
    this.render();
  }

  weightSum() { return this.cl.criteria.filter(c => c.type !== 'critical_flag').reduce((a, c) => a + (Number(c.weight) || 0), 0); }

  render() {
    const cl = this.cl;
    const sum = this.weightSum();
    this.innerHTML = `
      <h1>Чек-лист</h1>
      <div class="card toolbar">
        <label class="inline">Чек-лист
          <select id="pick">${this.list.map(x => `<option value="${esc(x.id)}" ${x.id === cl.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="inline">Версия
          <select id="ver">${(this.meta?.versions || [cl.version]).map(v => `<option ${v === cl.version ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <span class="spacer"></span>
        <span class="small ${sum === 100 ? 'muted' : ''}" style="${sum === 100 ? '' : 'color:var(--mid)'}">Сумма весов: <b>${sum}</b>${sum === 100 ? '' : ' (итог всё равно нормируется к 100)'}</span>
        <button id="save" class="primary">Сохранить как v${(Math.max(...(this.meta?.versions || [cl.version]))) + 1}</button>
        <button id="apply">Применить к диалогам набора</button>
        <div class="progress" id="prog" hidden><div style="width:0"></div></div><span class="small muted" id="progText"></span>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="grid2">
          <label class="field"><span>Название</span><input data-k="name" value="${esc(cl.name)}"></label>
          <label class="field"><span>ID чек-листа (смените, чтобы создать новый чек-лист)</span><input data-k="id" value="${esc(cl.id)}"></label>
          <label class="field"><span>Порог ожидания ответа, сек</span><input type="number" data-k="first_response_threshold_sec" value="${cl.first_response_threshold_sec ?? 180}"></label>
          <label class="field"><span>Округление итога, знаков</span><input type="number" data-k="rounding" value="${cl.rounding ?? 2}"></label>
        </div>
        <label class="field" style="margin-top:10px"><span>Дополнительные правила для модели (необязательно)</span><textarea data-k="extra_rules" rows="2">${esc(cl.extra_rules || '')}</textarea></label>
        <h2>Секции</h2>
        ${cl.sections.map((s, i) => `<div class="toolbar" style="margin-bottom:6px">
          <input data-sec="${i}" data-sk="id" value="${esc(s.id)}" size="10" title="ID секции">
          <input data-sec="${i}" data-sk="title" value="${esc(s.title)}" style="flex:1">
          <button class="small danger" data-delsec="${i}">Удалить</button></div>`).join('')}
        <button class="small" id="addsec">+ Секция</button>
      </div>

      <h2>Критерии (${cl.criteria.length})</h2>
      ${cl.criteria.map((c, i) => this.renderCrit(c, i)).join('')}
      <button id="add">+ Добавить критерий</button>
    `;
    this.bind();
  }

  renderCrit(c, i) {
    return `<div class="card" style="margin-bottom:10px">
      <div class="toolbar">
        <input data-c="${i}" data-ck="id" value="${esc(c.id)}" size="6" title="ID критерия">
        <input data-c="${i}" data-ck="title" value="${esc(c.title)}" style="flex:1;font-weight:600">
        <button class="small danger" data-del="${i}">Удалить</button>
      </div>
      <div class="toolbar">
        <label class="inline">Секция <select data-c="${i}" data-ck="section">${this.cl.sections.map(s => `<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select></label>
        <label class="inline">Тип <select data-c="${i}" data-ck="type">${TYPES.map(([v, t]) => `<option value="${v}" ${v === c.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        ${c.type !== 'critical_flag' ? `<label class="inline">Вес <input type="number" min="0" data-c="${i}" data-ck="weight" value="${c.weight}" style="width:70px"></label>` : ''}
        <label class="inline"><input type="checkbox" data-c="${i}" data-ck="na_allowed" ${c.na_allowed ? 'checked' : ''}> N/A разрешён</label>
      </div>
      ${c.type !== 'scale' ? `<label class="field"><span>Когда ставить «Да»</span><textarea rows="2" data-c="${i}" data-ck="yes_rule">${esc(c.yes_rule || '')}</textarea></label>` : ''}
      ${c.type === 'scale' ? `<label class="field"><span>Шкала: одна ступень в строке, формат «балл | описание». Верхняя ступень = полный вес.</span>
        <textarea rows="${(c.scale?.length || 3) + 1}" data-c="${i}" data-ck="scale">${esc((c.scale || []).map(s => `${s.value} | ${s.label}`).join('\n'))}</textarea></label>` : ''}
      ${c.na_allowed ? `<label class="field" style="margin-top:6px"><span>Когда ставить N/A</span><textarea rows="2" data-c="${i}" data-ck="na_rule">${esc(c.na_rule || '')}</textarea></label>` : ''}
      <label class="field" style="margin-top:6px"><span>Примечание для проверяющего и модели (необязательно)</span><textarea rows="1" data-c="${i}" data-ck="note">${esc(c.note || '')}</textarea></label>
    </div>`;
  }

  bind() {
    const mark = () => { this.dirty = true; };
    this.querySelector('#pick').onchange = e => { setPref('checklist', e.target.value); this.open(e.target.value); };
    this.querySelector('#ver').onchange = e => this.open(this.cl.id, Number(e.target.value));
    this.querySelectorAll('[data-k]').forEach(el => el.oninput = () => {
      const k = el.dataset.k;
      this.cl[k] = el.type === 'number' ? Number(el.value) : el.value; mark();
    });
    this.querySelectorAll('[data-sec]').forEach(el => el.oninput = () => { this.cl.sections[el.dataset.sec][el.dataset.sk] = el.value; mark(); });
    this.querySelectorAll('[data-delsec]').forEach(b => b.onclick = () => {
      const s = this.cl.sections[b.dataset.delsec];
      if (this.cl.criteria.some(c => c.section === s.id)) return toast('Сначала перенесите критерии из этой секции', 'err');
      this.cl.sections.splice(b.dataset.delsec, 1); mark(); this.render();
    });
    this.querySelector('#addsec').onclick = () => { this.cl.sections.push({ id: `s${this.cl.sections.length + 1}`, title: 'Новая секция' }); mark(); this.render(); };
    this.querySelectorAll('[data-c]').forEach(el => {
      const handler = () => {
        const c = this.cl.criteria[el.dataset.c], k = el.dataset.ck;
        if (k === 'na_allowed') { c.na_allowed = el.checked; mark(); return this.render(); }
        if (k === 'weight') c.weight = Number(el.value);
        else if (k === 'scale') c.scale = el.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const [v, ...rest] = l.split('|'); return { value: Number(v.trim()), label: rest.join('|').trim() };
        }).filter(s => !Number.isNaN(s.value)).sort((a, b) => b.value - a.value);
        else if (k === 'type') {
          c.type = el.value;
          if (c.type === 'scale' && !c.scale?.length) c.scale = [{ value: 10, label: 'Отлично' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Не выполнено' }];
          if (c.type === 'critical_flag') c.weight = 0;
          mark(); return this.render();
        } else c[k] = el.value;
        mark();
        if (k === 'weight') this.querySelector('#save').previousElementSibling.innerHTML = `Сумма весов: <b>${this.weightSum()}</b>`;
      };
      el.oninput = handler;
      if (el.tagName === 'SELECT' || el.type === 'checkbox') { el.oninput = null; el.onchange = handler; }
    });
    this.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      if (!confirmInline(b)) return;
      this.cl.criteria.splice(b.dataset.del, 1); mark(); this.render();
    });
    this.querySelector('#add').onclick = () => {
      const n = this.cl.criteria.length + 1;
      let id = `c${String(n).padStart(2, '0')}`;
      while (this.cl.criteria.some(c => c.id === id)) id += 'a';
      this.cl.criteria.push({ id, section: this.cl.sections[0]?.id, title: 'Новый критерий', type: 'binary', weight: 10, na_allowed: false, yes_rule: '' });
      mark(); this.render();
      this.querySelector(`[data-c="${this.cl.criteria.length - 1}"][data-ck="title"]`).focus();
    };
    this.querySelector('#save').onclick = () => this.save();
    this.querySelector('#apply').onclick = () => this.apply();
  }

  async save() {
    for (const c of this.cl.criteria) {
      if (c.type === 'scale' && (c.scale?.length || 0) < 2) return toast(`${c.title}: у шкалы минимум 2 ступени`, 'err');
      if (c.type !== 'scale' && !c.yes_rule?.trim()) return toast(`${c.title}: заполните, когда ставить «Да»`, 'err');
    }
    try {
      const saved = await api.saveChecklist(this.cl);
      toast(`Сохранено: ${saved.name} v${saved.version}`);
      setPref('checklist', saved.id);
      this.list = await api.checklists();
      await this.open(saved.id);
      return saved;
    } catch (e) { toast(e.message, 'err'); return null; }
  }

  async apply() {
    if (this.dirty) { const s = await this.save(); if (!s) return; }
    const group = getPref('group', '');
    const list = await api.conversations(group ? { group_id: group } : {});
    const ids = list.items.map(i => i.conversation_id);
    if (!ids.length) return toast('Нет диалогов для оценки', 'err');
    const prog = this.querySelector('#prog'), text = this.querySelector('#progText');
    prog.hidden = false;
    this.querySelector('#apply').disabled = true;
    const job = await api.batch({ conversation_ids: ids, checklist_id: this.cl.id });
    for (;;) {
      await new Promise(r => setTimeout(r, 1500));
      const s = await api.batchStatus(job.job_id);
      prog.firstElementChild.style.width = `${((s.done + s.failed) / s.total) * 100}%`;
      text.textContent = `${s.done + s.failed} / ${s.total}${group ? ` (набор ${group})` : ''}`;
      if (s.finished) { toast(`Чек-лист v${this.cl.version} применён: ${s.done} диалогов${s.failed ? `, ошибок ${s.failed}` : ''}`); break; }
    }
    this.querySelector('#apply').disabled = false;
  }
}

// Двойной клик для удаления без системного диалога confirm()
function confirmInline(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; btn.textContent = 'Точно удалить?';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Удалить'; } }, 2500);
  return false;
}

customElements.define('cqa-checklist-editor', CqaChecklistEditor);
