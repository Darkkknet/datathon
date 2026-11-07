// Маршрутизация по hash и сборка страниц из Web Components.
import { api, esc } from './api.js';
import './components/cqa-conversation-list.js';
import './components/cqa-evaluation-card.js';
import './components/cqa-checklist-editor.js';
import './components/cqa-appeal-review.js';

const view = document.getElementById('view');

function render() {
  const [, route, id] = (location.hash || '#/list').split('/');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route || (route === 'conv' && a.dataset.route === 'list')));
  if (route === 'conv' && id) view.innerHTML = `<cqa-evaluation-card conversation-id="${esc(decodeURIComponent(id))}"></cqa-evaluation-card>`;
  else if (route === 'checklist') view.innerHTML = '<cqa-checklist-editor></cqa-checklist-editor>';
  else if (route === 'appeals') view.innerHTML = '<cqa-appeal-review></cqa-appeal-review>';
  else view.innerHTML = '<cqa-conversation-list></cqa-conversation-list>';
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();

api.health().then(h => {
  document.getElementById('mode').textContent = h.model === 'mock' ? 'Режим: MOCK (нет ключа API)' : `Модель: ${h.model}`;
}).catch(() => { document.getElementById('mode').textContent = 'Сервер недоступен'; });
