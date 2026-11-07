// <cqa-conversation-list> — список диалогов, загрузка наборов, пакетная оценка.
import { api, esc, fmtTotal, getPref, setPref, toast } from '../api.js';

class CqaConversationList extends HTMLElement {
  connectedCallback() {
    this.filters = { group_id: getPref('group', ''), language: '', channel: '' };
    this.innerHTML = '<div class="empty"><span class="spinner"></span> Загрузка…</div>';
    this.load();
  }

  async load() {
    try {
      const [data, checklists] = await Promise.all([api.conversations(this.cleanFilters()), api.checklists()]);
      this.data = data; this.checklists = checklists;
      if (this.filters.group_id && !data.groups.includes(this.filters.group_id)) { this.filters.group_id = ''; return this.load(); }
      this.render();
    } catch (e) { this.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
  }
  cleanFilters() { return Object.fromEntries(Object.entries(this.filters).filter(([, v]) => v)); }

  render() {
    const { groups, items } = this.data;
    const clSel = getPref('checklist', this.checklists[0]?.id);
    const evaluated = items.filter(i => i.last_evaluation);
    const avg = evaluated.filter(i => i.last_evaluation.total != null);
    this.innerHTML = `
      <h1>Диалоги</h1>
      <div class="card toolbar">
        <label class="inline">Набор
          <select data-f="group_id"><option value="">все</option>${groups.map(g => `<option ${g === this.filters.group_id ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <label class="inline">Язык
          <select data-f="language"><option value="">все</option>${['RU', 'KZ', 'EN'].map(l => `<option ${l === this.filters.language ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="inline">Канал
          <select data-f="channel"><option value="">все</option>${[['agent chat', 'Чат'], ['voice call', 'Звонок']].map(([v, t]) => `<option value="${v}" ${v === this.filters.channel ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <span class="spacer"></span>
        <input id="gid" placeholder="group_id, напр. DEV" size="14">
        <button id="loadGroup">Загрузить из API</button>
        <label class="btn" style="cursor:pointer">Загрузить JSON<input type="file" id="file" accept=".json" hidden></label>
      </div>
      <div class="card toolbar">
        <label class="inline">Чек-лист
          <select id="cl">${this.checklists.map(c => `<option value="${esc(c.id)}" ${c.id === clSel ? 'selected' : ''}>${esc(c.name)} · v${c.version}</option>`).join('')}</select></label>
        <button class="primary" id="batch">Оценить все показанные (${items.length})</button>
        <div class="progress" id="prog" hidden><div style="width:0"></div></div>
        <span class="small muted" id="progText"></span>
        <span class="spacer"></span>
        <span class="small muted">Оценено: ${evaluated.length} из ${items.length}${avg.length ? ` · средний итог ${fmtTotal(avg.reduce((a, i) => a + i.last_evaluation.total, 0) / avg.length)}` : ''}</span>
      </div>
      ${items.length ? `<table class="list">
        <thead><tr><th>ID</th><th>Канал</th><th>Язык</th><th>Реплик</th><th>Итог</th><th>Грубая ошибка</th><th>Чек-лист</th><th>Апелляции</th></tr></thead>
        <tbody>${items.map(i => {
          const e = i.last_evaluation;
          return `<tr class="row" data-id="${esc(i.conversation_id)}">
            <td><b>${esc(i.conversation_id)}</b></td>
            <td>${i.channel === 'voice call' ? 'Звонок' : 'Чат'}</td>
            <td>${esc(i.language)}</td>
            <td>${i.turns}</td>
            <td>${e ? `<b>${fmtTotal(e.total)}</b>` : '<span class="muted">не оценён</span>'}</td>
            <td>${e ? (e.critical_error ? '<span class="flag">ДА</span>' : '<span class="muted">нет</span>') : ''}</td>
            <td class="small muted">${e ? `v${e.checklist_version}${e.model === 'mock' ? ' · mock' : ''}` : ''}</td>
            <td>${i.open_appeals ? `<span class="pill pill-mid">${i.open_appeals} открыто</span>` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table>` : '<div class="card empty">Нет диалогов. Загрузите набор по group_id или JSON-файл.</div>'}
    `;
    this.querySelectorAll('[data-f]').forEach(s => s.onchange = () => {
      this.filters[s.dataset.f] = s.value;
      if (s.dataset.f === 'group_id') setPref('group', s.value);
      this.load();
    });
    this.querySelector('#cl').onchange = e => setPref('checklist', e.target.value);
    this.querySelectorAll('tr.row').forEach(r => r.onclick = () => { location.hash = `#/conv/${encodeURIComponent(r.dataset.id)}`; });
    this.querySelector('#loadGroup').onclick = () => this.loadGroup();
    this.querySelector('#file').onchange = e => this.uploadFile(e.target.files[0]);
    this.querySelector('#batch').onclick = () => this.runBatch(items.map(i => i.conversation_id));
  }

  async loadGroup() {
    const g = this.querySelector('#gid').value.trim();
    if (!g) return toast('Введите group_id', 'err');
    const btn = this.querySelector('#loadGroup');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Загрузка';
    try {
      const r = await api.loadGroup(g);
      toast(`Загружено ${r.loaded} диалогов (${r.group_id})`);
      this.filters.group_id = r.group_id; setPref('group', r.group_id);
      this.load();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Загрузить из API'; }
  }

  async uploadFile(file) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const g = json?.data?.dataset_group_id || prompt('Название набора (group_id):', file.name.replace(/\.json$/, '')) || 'UPLOAD';
      const r = await api.uploadDataset(json, g);
      toast(`Загружено ${r.loaded} диалогов (${r.group_id})`);
      this.filters.group_id = r.group_id; setPref('group', r.group_id);
      this.load();
    } catch (e) { toast('Не удалось прочитать файл: ' + e.message, 'err'); }
  }

  async runBatch(ids) {
    if (!ids.length) return;
    const checklist_id = this.querySelector('#cl').value;
    const btn = this.querySelector('#batch'); btn.disabled = true;
    const prog = this.querySelector('#prog'); prog.hidden = false;
    const text = this.querySelector('#progText');
    try {
      const job = await api.batch({ conversation_ids: ids, checklist_id });
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await api.batchStatus(job.job_id);
        prog.firstElementChild.style.width = `${((s.done + s.failed) / s.total) * 100}%`;
        text.textContent = `${s.done + s.failed} / ${s.total}${s.failed ? `, ошибок ${s.failed}` : ''}`;
        if (s.finished) {
          toast(`Готово: ${s.done} оценено${s.failed ? `, ${s.failed} с ошибкой` : ''}`, s.failed ? 'err' : 'ok');
          if (s.failed) console.warn('Ошибки пакетной оценки', s.errors);
          break;
        }
      }
    } catch (e) { toast(e.message, 'err'); }
    this.load();
  }
}
customElements.define('cqa-conversation-list', CqaConversationList);
