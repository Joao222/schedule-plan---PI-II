// Front-end em JavaScript puro (sem build). Consome a API REST em /api.
'use strict';

// ======================= estado & utilidades =======================
const state = {
  token: sessionStorage.getItem('token'),
  user: JSON.parse(sessionStorage.getItem('user') || 'null'),
  month: new Date().toISOString().slice(0, 7), // AAAA-MM
  models: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const brDate = (d) => (d ? d.split('-').reverse().join('/') : '');
const longDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
};
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthLabel = (ym) => { const s = new Date(ym + '-15T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return s[0].toUpperCase() + s.slice(1); };
const hours = (h) => `${String(h).replace('.', ',')}h`;

const TYPE = { treinamento: 'Treinamento', folga: 'Folga', plantao: 'Plantão' };
const STATUS = { agendado: 'Agendado', compareceu: 'Compareceu', nao_compareceu: 'Não compareceu', cancelado: 'Cancelado' };
const SCALE_STATUS = { ok: 'Dentro da escala', atencao: 'Atenção', excedendo: 'Excedendo' };
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function announce(msg) { const r = $('#live-polite'); r.textContent = ''; setTimeout(() => { r.textContent = msg; }, 50); }
let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast'); t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && state.token) { logout('Sua sessão expirou. Entre novamente.'); throw new Error('Sessão expirada'); }
  if (raw) { if (!res.ok) throw new Error((await res.json()).error); return res; }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro inesperado.');
  return data;
}

async function download(path, filename) {
  try {
    const res = await api(path, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast(`Relatório "${filename}" baixado.`);
  } catch (e) { toast(e.message, 'error'); }
}

// ======================= diálogo genérico acessível =======================
function openDialog({ title, body, submitLabel = 'Salvar', onSubmit, onOpen }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  $('#dialog-error').textContent = '';
  $('#dialog-submit').textContent = submitLabel;
  $('#dialog-submit').hidden = !onSubmit;
  $('#dialog-cancel').textContent = onSubmit ? 'Cancelar' : 'Fechar';
  const opener = document.activeElement;
  const form = $('#dialog-form');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!onSubmit) return dlg.close();
    const firstInvalid = $$('input, select, textarea', form).find((el) => !el.checkValidity());
    if (firstInvalid) { $('#dialog-error').textContent = `Verifique o campo "${labelOf(firstInvalid)}".`; firstInvalid.focus(); return; }
    const btn = $('#dialog-submit'); btn.disabled = true;
    try { await onSubmit(new FormData(form), form); dlg.close(); }
    catch (e) { $('#dialog-error').textContent = e.message; }
    finally { btn.disabled = false; }
  };
  $('#dialog-cancel').onclick = () => dlg.close();
  dlg.onclose = () => opener?.focus?.();
  dlg.showModal();
  onOpen?.(form);
  ($('[autofocus]', form) || $('input, select, textarea, button', $('#dialog-body')) || $('#dialog-cancel')).focus();
}
function labelOf(el) { return (el.labels?.[0]?.textContent || el.name).replace('*', '').trim(); }
const confirmDialog = (title, message) => new Promise((resolve) => {
  let ok = false;
  openDialog({ title, body: `<p>${esc(message)}</p>`, submitLabel: 'Confirmar', onSubmit: async () => { ok = true; } });
  $('#dialog').addEventListener('close', () => resolve(ok), { once: true });
});

// ======================= acessibilidade: fonte e contraste =======================
(function a11yPrefs() {
  const root = document.documentElement;
  let scale = Number(localStorage.getItem('fontScale') || 0);
  const apply = () => { root.dataset.font = String(scale); localStorage.setItem('fontScale', scale); };
  apply();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-font]'); if (!b) return;
    const v = Number(b.dataset.font); scale = v === 0 ? 0 : Math.max(-1, Math.min(3, scale + v)); apply();
    announce(`Tamanho do texto: ${['pequeno', 'padrão', 'grande', 'maior', 'máximo'][scale + 1]}`);
  });
  const btn = document.getElementById('btn-contrast');
  const setContrast = (on) => { root.classList.toggle('high-contrast', on); btn.setAttribute('aria-pressed', String(on)); localStorage.setItem('contrast', on ? '1' : '0'); };
  setContrast(localStorage.getItem('contrast') === '1');
  btn.addEventListener('click', () => { setContrast(!root.classList.contains('high-contrast')); announce(root.classList.contains('high-contrast') ? 'Alto contraste ativado' : 'Alto contraste desativado'); });
})();

// ======================= roteamento =======================
const ROUTES = {
  admin: [
    ['agenda', 'Agenda'], ['escalas', 'Escalas'], ['jornadas', 'Jornadas'], ['usuarios', 'Usuários'], ['relatorios', 'Relatórios'],
  ],
  operador: [['minha-agenda', 'Minha agenda'], ['minha-escala', 'Minha escala'], ['minhas-jornadas', 'Minhas jornadas']],
};

function render() {
  const main = $('#main');
  if (!state.token || !state.user) { $('#topbar').hidden = true; return renderLogin(main); }
  $('#topbar').hidden = false;
  $('#who').textContent = `${state.user.name} (${state.user.role === 'admin' ? 'Administrador' : 'Operador'})`;
  const routes = ROUTES[state.user.role];
  let route = location.hash.slice(1);
  if (!routes.some(([r]) => r === route)) route = routes[0][0];
  $('#nav').innerHTML = `<ul>${routes.map(([r, label]) =>
    `<li><a href="#${r}" ${r === route ? 'aria-current="page"' : ''}>${esc(label)}</a></li>`).join('')}</ul>`;
  const title = routes.find(([r]) => r === route)[1];
  document.title = `${title} — Agenda & Escalas`;
  main.innerHTML = `<div class="container"><h1>${esc(title)}</h1><div id="view"><p aria-busy="true">Carregando…</p></div></div>`;
  VIEWS[route]($('#view')).catch((e) => { $('#view').innerHTML = `<p class="form-error" role="alert">${esc(e.message)}</p>`; });
}
window.addEventListener('hashchange', () => { render(); $('#main').focus(); });

function logout(msg) {
  state.token = null; state.user = null; state.month = new Date().toISOString().slice(0, 7); sessionStorage.clear();
  history.replaceState(null, '', location.pathname); render(); if (msg) toast(msg, 'error');
}
$('#btn-logout').addEventListener('click', () => logout());
$('#btn-password').addEventListener('click', () => openDialog({
  title: 'Alterar senha',
  body: `${field('current', 'Senha atual', 'password', '', 'required autocomplete="current-password"')}
         ${field('next', 'Nova senha (mín. 8 caracteres)', 'password', '', 'required minlength="8" autocomplete="new-password"')}`,
  onSubmit: async (fd) => { await api('/auth/change-password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } }); toast('Senha alterada com sucesso.'); },
}));

// ======================= componentes de formulário =======================
let fieldSeq = 0;
function field(name, label, type = 'text', value = '', attrs = '') {
  const id = `f-${name}-${++fieldSeq}`;
  const req = /required/.test(attrs) ? ' <span aria-hidden="true">*</span>' : '';
  return `<div class="field"><label for="${id}">${esc(label)}${req}</label>
    <input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}></div>`;
}
function select(name, label, options, value = '', attrs = '') {
  const id = `f-${name}-${++fieldSeq}`;
  const req = /required/.test(attrs) ? ' <span aria-hidden="true">*</span>' : '';
  return `<div class="field"><label for="${id}">${esc(label)}${req}</label>
    <select id="${id}" name="${name}" ${attrs}>${options.map(([v, l]) =>
      `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
}
function textarea(name, label, value = '') {
  const id = `f-${name}-${++fieldSeq}`;
  return `<div class="field"><label for="${id}">${esc(label)}</label><textarea id="${id}" name="${name}" rows="3">${esc(value)}</textarea></div>`;
}
const badge = (kind, text) => `<span class="badge ${esc(kind)}">${esc(text)}</span>`;

function monthNav(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'month-nav';
  wrap.innerHTML = `<button type="button" class="btn ghost" data-m="-1" aria-label="Mês anterior">◀</button>
    <h2 class="month-label" aria-live="polite">${esc(monthLabel(state.month))}</h2>
    <button type="button" class="btn ghost" data-m="1" aria-label="Próximo mês">▶</button>
    <button type="button" class="btn ghost" data-m="0">Hoje</button>`;
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const n = Number(b.dataset.m);
    state.month = n === 0 ? new Date().toISOString().slice(0, 7) : shiftMonth(state.month, n);
    $('.month-label', wrap).textContent = monthLabel(state.month);
    onChange();
  });
  return wrap;
}

// ======================= login =======================
function renderLogin(main) {
  document.title = 'Entrar — Agenda & Escalas';
  main.innerHTML = `<div class="login-wrap"><section class="card login" aria-labelledby="login-title">
    <h1 id="login-title"><span aria-hidden="true" class="logo">▦</span> Agenda &amp; Escalas</h1>
    <p class="muted">Treinamentos, folgas e gestão de escalas.</p>
    <form id="login-form" novalidate>
      ${field('email', 'E-mail', 'email', '', 'required autocomplete="username" autofocus')}
      ${field('password', 'Senha', 'password', '', 'required autocomplete="current-password"')}
      <p class="form-error" id="login-error" role="alert"></p>
      <button class="btn primary block" type="submit">Entrar</button>
    </form>
    <details class="demo"><summary>Acessos de demonstração</summary>
      <ul><li><strong>Administrador:</strong> admin@empresa.com / Admin@123</li>
      <li><strong>Operador:</strong> operador@empresa.com / Operador@123</li></ul></details>
  </section></div>`;
  const form = $('#login-form');
  $('input', form).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const err = $('#login-error');
    if (!fd.get('email') || !fd.get('password')) { err.textContent = 'Informe e-mail e senha.'; return; }
    try {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
      state.token = token; state.user = user;
      sessionStorage.setItem('token', token); sessionStorage.setItem('user', JSON.stringify(user));
      history.replaceState(null, '', location.pathname); render(); $('#main').focus(); announce(`Bem-vindo, ${user.name}.`);
    } catch (ex) { err.textContent = ex.message; $('input[name=password]', form).focus(); }
  });
}

// ======================= calendário mensal =======================
/**
 * @param events lista de eventos
 * @param shifts escala prevista (opcional, para o operador)
 */
function calendar(events, shifts = [], { showUser = false } = {}) {
  const { from, to } = monthRange(state.month);
  const first = new Date(from + 'T12:00:00');
  const lastDay = Number(to.slice(8));
  const byDate = {};
  for (const e of events) (byDate[e.date] ||= []).push(e);
  const shiftBy = Object.fromEntries(shifts.map((s) => [s.date, s]));
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<td class="empty" aria-hidden="true"></td>');
  for (let d = 1; d <= lastDay; d++) {
    const date = `${state.month}-${String(d).padStart(2, '0')}`;
    const evs = byDate[date] || [];
    const s = shiftBy[date];
    const shiftHtml = s ? (s.work ? `<span class="shift work">Escala ${esc(s.start)}–${esc(s.end)}${s.crossesMidnight ? ' <abbr title="do dia seguinte">(+1 dia)</abbr>' : ''}</span>` : '<span class="shift off">Folga da escala</span>') : '';
    const evHtml = evs.slice(0, 4).map((e) => `<li><button type="button" class="chip ${e.type} st-${e.status}" data-event="${e.id}">
      <span class="sr-only">${esc(TYPE[e.type])}: </span>${esc(e.start_time || '')} ${esc(e.title)}${showUser ? ` — ${esc(e.user_name.split(' ')[0])}` : ''}
      <span class="sr-only">, ${esc(STATUS[e.status])}</span></button></li>`).join('');
    const more = evs.length > 4 ? `<li class="muted">+${evs.length - 4} na lista</li>` : '';
    cells.push(`<td class="${date === today() ? 'today' : ''}">
      <div class="day-num">${d}${date === today() ? ' <span class="sr-only">(hoje)</span>' : ''}</div>
      <span class="sr-only">${esc(longDate(date))}</span>
      ${shiftHtml}<ul class="day-events">${evHtml}${more}</ul></td>`);
  }
  while (cells.length % 7) cells.push('<td class="empty" aria-hidden="true"></td>');
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
  return `<div class="table-scroll" role="region" aria-label="Calendário de ${esc(monthLabel(state.month))}" tabindex="0">
    <table class="calendar"><caption class="sr-only">Calendário de ${esc(monthLabel(state.month))}</caption>
    <thead><tr>${WEEKDAYS.map((w) => `<th scope="col"><abbr title="${w}">${w.slice(0, 3)}</abbr></th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function eventDetails(e) {
  return `<dl class="details">
    <dt>Tipo</dt><dd>${esc(TYPE[e.type])}</dd>
    <dt>Data</dt><dd>${esc(longDate(e.date))}</dd>
    ${e.start_time ? `<dt>Horário</dt><dd>${esc(e.start_time)}${e.end_time ? ' às ' + esc(e.end_time) : ''}</dd>` : ''}
    ${e.user_name ? `<dt>Colaborador</dt><dd>${esc(e.user_name)}</dd>` : ''}
    ${e.description ? `<dt>Descrição</dt><dd>${esc(e.description)}</dd>` : ''}
    <dt>Situação</dt><dd>${badge('st-' + e.status, STATUS[e.status])}</dd></dl>`;
}

// ======================= VIEWS =======================
const VIEWS = {};

// ---------- ADMIN: agenda ----------
VIEWS.agenda = async (view) => {
  const [users, teams] = await Promise.all([api('/users'), api('/teams')]);
  const operators = users.filter((u) => u.active);
  view.innerHTML = `<div class="toolbar">
      <button type="button" class="btn primary" id="new-event">+ Novo agendamento</button>
      <form class="filters" id="ag-filters" aria-label="Filtros da agenda">
        ${select('type', 'Tipo', [['', 'Todos'], ...Object.entries(TYPE)])}
        ${select('status', 'Situação', [['', 'Todas'], ...Object.entries(STATUS)])}
        ${select('team_id', 'Equipe', [['', 'Todas'], ...teams.map((t) => [t.id, t.name])])}
        ${select('user_id', 'Colaborador', [['', 'Todos'], ...operators.map((u) => [u.id, u.name])])}
      </form></div>
    <div id="nav-slot"></div><div id="cal"></div>
    <h2>Lista de agendamentos do mês</h2><div id="list"></div>`;
  $('#nav-slot').append(monthNav(load));
  $('#ag-filters').addEventListener('change', load);
  $('#new-event').addEventListener('click', () => eventForm(null, operators, teams, load));
  let events = [];
  async function load() {
    const q = new URLSearchParams({ ...monthRange(state.month), ...Object.fromEntries(new FormData($('#ag-filters'))) });
    [...q.entries()].forEach(([k, v]) => { if (!v) q.delete(k); });
    events = await api('/events?' + q);
    $('#cal').innerHTML = calendar(events, [], { showUser: true });
    $('#list').innerHTML = events.length ? `<div class="table-scroll" role="region" aria-label="Lista de agendamentos" tabindex="0"><table>
      <caption class="sr-only">Agendamentos de ${esc(monthLabel(state.month))}</caption>
      <thead><tr><th scope="col">Data</th><th scope="col">Horário</th><th scope="col">Tipo</th><th scope="col">Título</th><th scope="col">Colaborador</th><th scope="col">Situação</th><th scope="col"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${events.map((e) => `<tr><td>${brDate(e.date)}</td><td>${esc(e.start_time || '—')}${e.end_time ? '–' + esc(e.end_time) : ''}</td>
        <td>${badge(e.type, TYPE[e.type])}</td><th scope="row">${esc(e.title)}</th><td>${esc(e.user_name)}</td><td>${badge('st-' + e.status, STATUS[e.status])}</td>
        <td class="actions"><button type="button" class="btn small" data-edit="${e.id}">Editar<span class="sr-only"> ${esc(e.title)} de ${esc(e.user_name)}</span></button>
        <button type="button" class="btn small danger" data-del="${e.id}">Excluir<span class="sr-only"> ${esc(e.title)} de ${esc(e.user_name)}</span></button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty-state">Nenhum agendamento encontrado para os filtros escolhidos.</p>';
    announce(`${events.length} agendamentos em ${monthLabel(state.month)}.`);
  }
  view.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-event],[data-edit]')?.dataset;
    const evId = Number(id?.event || id?.edit);
    if (evId) return eventForm(events.find((x) => x.id === evId), operators, teams, load);
    const del = e.target.closest('[data-del]');
    if (del && await confirmDialog('Excluir agendamento', 'Deseja realmente excluir este agendamento?')) {
      await api(`/events/${del.dataset.del}`, { method: 'DELETE' }); toast('Agendamento excluído.'); load();
    }
  });
  await load();
};

function eventForm(ev, users, teams, onSaved) {
  const isNew = !ev;
  const e = ev || { type: 'treinamento', date: today(), status: 'agendado' };
  const userPicker = isNew
    ? `<fieldset class="field"><legend>Colaboradores <span aria-hidden="true">*</span></legend>
        ${select('team_pick', 'Selecionar equipe inteira', [['', '—'], ...teams.map((t) => [t.id, t.name])])}
        <div class="checklist" id="user-checks">${users.map((u) => `<label><input type="checkbox" name="user_ids" value="${u.id}" data-team="${u.team_id ?? ''}"> ${esc(u.name)}</label>`).join('')}</div></fieldset>`
    : select('user_id', 'Colaborador', users.map((u) => [u.id, u.name]), e.user_id, 'required');
  openDialog({
    title: isNew ? 'Novo agendamento' : 'Editar agendamento',
    body: `${select('type', 'Tipo', Object.entries(TYPE), e.type, 'required')}
      ${field('title', 'Título', 'text', e.title || '', 'required maxlength="120"')}
      ${userPicker}
      <div class="grid-3">${field('date', 'Data', 'date', e.date, 'required')}
      ${field('start_time', 'Início', 'time', e.start_time || '')}${field('end_time', 'Fim', 'time', e.end_time || '')}</div>
      ${textarea('description', 'Descrição / local', e.description || '')}
      ${isNew ? '' : select('status', 'Situação', Object.entries(STATUS), e.status)}`,
    onOpen: (form) => {
      $('[name=team_pick]', form)?.addEventListener('change', (x) => {
        $$('[name=user_ids]', form).forEach((c) => { c.checked = c.dataset.team === x.target.value; });
        announce(`${$$('[name=user_ids]:checked', form).length} colaboradores selecionados.`);
      });
    },
    onSubmit: async (fd) => {
      const body = Object.fromEntries([...fd.entries()].filter(([k]) => !['user_ids', 'team_pick'].includes(k)));
      if (isNew) {
        body.user_ids = fd.getAll('user_ids').map(Number);
        if (!body.user_ids.length) throw new Error('Selecione pelo menos um colaborador.');
        await api('/events', { method: 'POST', body });
        toast(`${body.user_ids.length} agendamento(s) criado(s).`);
      } else {
        await api(`/events/${e.id}`, { method: 'PUT', body });
        toast('Agendamento atualizado.');
      }
      onSaved();
    },
  });
}

// ---------- ADMIN: escalas ----------
VIEWS.escalas = async (view) => {
  if (!state.models.length) state.models = await api('/scale-models');
  view.innerHTML = `
    <section aria-labelledby="sec-compl" class="card">
      <h2 id="sec-compl">Quem está excedendo a escala</h2>
      <p class="muted">Compara as jornadas registradas com a escala prevista e com os limites da CLT (jornada diária + 2h extras, 44h semanais, 11h de interjornada, 36h/48h nas escalas 12x36 e 24x48, e descanso semanal após 6 dias).</p>
      <div id="nav-slot"></div>
      <div id="compliance"></div>
    </section>
    <section aria-labelledby="sec-teams">
      <div class="toolbar"><h2 id="sec-teams">Times de escala</h2><button type="button" class="btn primary" id="new-team">+ Nova equipe</button></div>
      <div id="teams" class="team-grid"></div>
    </section>
    <section aria-labelledby="sec-grid" class="card">
      <h2 id="sec-grid">Grade da escala do mês</h2>
      <div id="grid-filter"></div>
      <div id="grid"></div>
    </section>
    <section aria-labelledby="sec-models">
      <h2 id="sec-models">Modelos de escala disponíveis (Brasil)</h2>
      <div class="table-scroll" role="region" aria-label="Modelos de escala" tabindex="0"><table>
        <thead><tr><th scope="col">Modelo</th><th scope="col">Descrição</th><th scope="col">Horas/dia padrão</th><th scope="col">Descanso mínimo</th><th scope="col">Base legal</th></tr></thead>
        <tbody>${state.models.map((m) => `<tr><th scope="row">${esc(m.id)}</th><td>${esc(m.label)}</td><td>${hours(m.dailyHours)}</td><td>${m.minRestHours}h</td><td>${esc(m.legal)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  $('#nav-slot').append(monthNav(() => { loadCompliance(); loadGrid(); }));
  $('#new-team').addEventListener('click', () => teamForm(null, reloadAll));

  let teams = [], users = [];
  async function reloadAll() {
    [teams, users] = await Promise.all([api('/teams'), api('/users')]);
    $('#teams').innerHTML = teams.length ? teams.map((t) => `<article class="card team" aria-labelledby="team-${t.id}">
      <h3 id="team-${t.id}">${esc(t.name)}</h3>
      <p>${badge('model', t.scale_model)} Turno às ${esc(t.shift_start)} · ${hours(t.daily_hours)} por dia</p>
      ${t.description ? `<p class="muted">${esc(t.description)}</p>` : ''}
      <p><strong>${t.members.length}</strong> integrante(s):</p>
      <ul class="members">${t.members.map((m) => `<li>${esc(m.name)}</li>`).join('') || '<li class="muted">Sem integrantes</li>'}</ul>
      <div class="actions">
        <button type="button" class="btn small" data-members="${t.id}">Alterar integrantes<span class="sr-only"> de ${esc(t.name)}</span></button>
        <button type="button" class="btn small" data-team-edit="${t.id}">Editar<span class="sr-only"> ${esc(t.name)}</span></button>
        <button type="button" class="btn small danger" data-team-del="${t.id}">Excluir<span class="sr-only"> ${esc(t.name)}</span></button>
      </div></article>`).join('') : '<p class="empty-state">Nenhuma equipe cadastrada.</p>';
    const gf = $('#grid-filter');
    const current = $('select', gf)?.value || teams[0]?.id || '';
    gf.innerHTML = select('grid_team', 'Equipe', teams.map((t) => [t.id, `${t.name} (${t.scale_model})`]), current);
    $('select', gf).addEventListener('change', loadGrid);
    await Promise.all([loadCompliance(), loadGrid()]);
  }

  async function loadCompliance() {
    const { results } = await api('/scales/compliance?' + new URLSearchParams(monthRange(state.month)));
    const exceeding = results.filter((r) => r.status === 'excedendo').length;
    $('#compliance').innerHTML = `
      <ul class="kpis" aria-label="Resumo">
        <li class="kpi bad"><span class="kpi-value">${exceeding}</span> excedendo</li>
        <li class="kpi warn"><span class="kpi-value">${results.filter((r) => r.status === 'atencao').length}</span> em atenção</li>
        <li class="kpi good"><span class="kpi-value">${results.filter((r) => r.status === 'ok').length}</span> dentro da escala</li>
      </ul>
      <div class="table-scroll" role="region" aria-label="Conformidade das escalas" tabindex="0"><table>
      <caption class="sr-only">Conformidade das escalas em ${esc(monthLabel(state.month))}, ordenado por gravidade</caption>
      <thead><tr><th scope="col">Colaborador</th><th scope="col">Equipe</th><th scope="col">Escala</th><th scope="col" class="num">Previstas</th><th scope="col" class="num">Trabalhadas</th><th scope="col" class="num">Saldo</th><th scope="col">Situação</th><th scope="col">Irregularidades</th></tr></thead>
      <tbody>${results.map((r) => `<tr class="row-${r.status}">
        <th scope="row">${esc(r.user_name)}</th><td>${esc(r.team_name)}</td><td>${esc(r.scale_model)}</td>
        <td class="num">${hours(r.expected_hours)}</td><td class="num">${hours(r.worked_hours)}</td>
        <td class="num">${r.balance_hours > 0 ? '+' : ''}${hours(r.balance_hours)}</td>
        <td>${badge('sc-' + r.status, SCALE_STATUS[r.status])}</td>
        <td>${r.violations.length ? `<details><summary>${r.violations.length} ocorrência(s)</summary><ul>${r.violations.map((v) => `<li>${esc(v.message)}</li>`).join('')}</ul></details>` : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
    announce(`${exceeding} colaborador(es) excedendo a escala em ${monthLabel(state.month)}.`);
  }

  async function loadGrid() {
    const teamId = $('#grid-filter select')?.value;
    if (!teamId) { $('#grid').innerHTML = ''; return; }
    const { from, to } = monthRange(state.month);
    const [sched, events] = await Promise.all([
      api(`/schedule?from=${from}&to=${to}&team_id=${teamId}`),
      api(`/events?from=${from}&to=${to}&team_id=${teamId}&type=folga`),
    ]);
    const leaves = new Set(events.filter((e) => e.status !== 'cancelado').map((e) => `${e.user_id}|${e.date}`));
    const days = [...new Set(sched.map((s) => s.date))].sort();
    const members = [...new Map(sched.map((s) => [s.user_id, s.user_name])).entries()];
    if (!members.length) { $('#grid').innerHTML = '<p class="empty-state">Equipe sem integrantes.</p>'; return; }
    const cell = Object.fromEntries(sched.map((s) => [`${s.user_id}|${s.date}`, s]));
    $('#grid').innerHTML = `<p class="legend"><span class="g work">T</span> Trabalho <span class="g off">F</span> Folga da escala <span class="g leave">FA</span> Folga agendada</p>
      <div class="table-scroll" role="region" aria-label="Grade da escala" tabindex="0"><table class="scale-grid">
      <caption class="sr-only">Escala prevista por colaborador e dia</caption>
      <thead><tr><th scope="col">Colaborador</th>${days.map((d) => `<th scope="col" class="${d === today() ? 'today' : ''}"><abbr title="${esc(longDate(d))}">${Number(d.slice(8))}<br>${WEEKDAYS[new Date(d + 'T12:00:00').getDay()].slice(0, 1)}</abbr></th>`).join('')}</tr></thead>
      <tbody>${members.map(([uid, name]) => `<tr><th scope="row">${esc(name)}</th>${days.map((d) => {
        const s = cell[`${uid}|${d}`];
        if (leaves.has(`${uid}|${d}`)) return '<td class="g leave"><abbr title="Folga agendada">FA</abbr></td>';
        return s.work ? `<td class="g work"><abbr title="Trabalho ${esc(s.start)} às ${esc(s.end)}${s.crossesMidnight ? ' do dia seguinte' : ''}">T</abbr></td>` : '<td class="g off"><abbr title="Folga da escala">F</abbr></td>';
      }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  view.addEventListener('click', async (e) => {
    const t = (attr) => teams.find((x) => x.id === Number(e.target.closest(`[${attr}]`)?.getAttribute(attr)));
    if (t('data-team-edit')) return teamForm(t('data-team-edit'), reloadAll);
    if (t('data-members')) return membersForm(t('data-members'), users, reloadAll);
    const del = t('data-team-del');
    if (del && await confirmDialog('Excluir equipe', `Excluir a equipe "${del.name}"? Os integrantes ficarão sem equipe.`)) {
      await api(`/teams/${del.id}`, { method: 'DELETE' }); toast('Equipe excluída.'); reloadAll();
    }
  });
  await reloadAll();
};

function teamForm(team, onSaved) {
  const t = team || { scale_model: '5x2', cycle_start: today(), shift_start: '08:00' };
  openDialog({
    title: team ? `Editar equipe ${team.name}` : 'Nova equipe de escala',
    body: `${field('name', 'Nome da equipe', 'text', t.name || '', 'required maxlength="80"')}
      ${select('scale_model', 'Modelo de escala', state.models.map((m) => [m.id, m.label]), t.scale_model, 'required')}
      <p class="hint" id="model-hint"></p>
      <div class="grid-3">${field('cycle_start', 'Início do ciclo', 'date', t.cycle_start, 'required aria-describedby="cycle-help"')}
      ${field('shift_start', 'Início do turno', 'time', t.shift_start, 'required')}
      ${field('daily_hours', 'Horas por dia', 'number', t.daily_hours ?? '', 'step="0.01" min="0.5" max="24" required')}</div>
      <p class="hint" id="cycle-help">O início do ciclo define o primeiro dia de trabalho. Para revezar turmas (ex.: 12x36 A e B), use datas consecutivas.</p>
      ${textarea('description', 'Descrição', t.description || '')}`,
    onOpen: (form) => {
      const sel = $('[name=scale_model]', form); const hrs = $('[name=daily_hours]', form);
      const upd = (setHours) => {
        const m = state.models.find((x) => x.id === sel.value);
        $('#model-hint').textContent = m.legal;
        if (setHours) hrs.value = m.dailyHours;
      };
      upd(!team); sel.addEventListener('change', () => upd(true));
    },
    onSubmit: async (fd) => {
      const body = Object.fromEntries(fd); body.daily_hours = Number(body.daily_hours);
      await api(team ? `/teams/${team.id}` : '/teams', { method: team ? 'PUT' : 'POST', body });
      toast(team ? 'Equipe atualizada.' : 'Equipe criada.'); onSaved();
    },
  });
}

function membersForm(team, users, onSaved) {
  const ops = users.filter((u) => u.active);
  openDialog({
    title: `Integrantes de ${team.name}`,
    body: `<fieldset><legend>Marque os integrantes da equipe</legend>
      <p class="hint">Colaboradores de outras equipes serão transferidos para esta.</p>
      <div class="checklist">${ops.map((u) => `<label><input type="checkbox" name="user_ids" value="${u.id}" ${u.team_id === team.id ? 'checked' : ''}>
        ${esc(u.name)} ${u.team_id && u.team_id !== team.id ? `<span class="muted">(atual: ${esc(u.team_name)})</span>` : ''}</label>`).join('')}</div></fieldset>`,
    onSubmit: async (fd) => {
      await api(`/teams/${team.id}/members`, { method: 'PUT', body: { user_ids: fd.getAll('user_ids').map(Number) } });
      toast('Integrantes atualizados.'); onSaved();
    },
  });
}

// ---------- ADMIN: jornadas ----------
VIEWS.jornadas = async (view) => {
  const users = (await api('/users')).filter((u) => u.active && u.team_id);
  view.innerHTML = `<p class="muted">Registre as jornadas efetivamente trabalhadas (ponto). Esses registros alimentam o controle de excesso de escala.</p>
    <form class="card form-inline" id="log-form" aria-labelledby="log-title" novalidate>
      <h2 id="log-title">Registrar jornada</h2>
      <div class="grid-5">
        ${select('user_id', 'Colaborador', users.map((u) => [u.id, `${u.name} — ${u.team_name}`]), '', 'required')}
        ${field('date', 'Data', 'date', today(), 'required')}
        ${field('clock_in', 'Entrada', 'time', '08:00', 'required')}
        ${field('clock_out', 'Saída', 'time', '17:00', 'required')}
        ${field('break_minutes', 'Intervalo (min)', 'number', '60', 'min="0" max="719"')}
      </div>
      ${field('note', 'Observação', 'text', '', 'maxlength="200"')}
      <p class="form-error" role="alert" id="log-error"></p>
      <button class="btn primary" type="submit">Registrar</button>
    </form>
    <div id="nav-slot"></div><div id="logs"></div>`;
  $('#nav-slot').append(monthNav(load));
  $('#log-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try { await api('/work-logs', { method: 'POST', body }); $('#log-error').textContent = ''; toast('Jornada registrada.'); load(); }
    catch (ex) { $('#log-error').textContent = ex.message; }
  });
  async function load() {
    const logs = await api('/work-logs?' + new URLSearchParams(monthRange(state.month)));
    $('#logs').innerHTML = logsTable(logs, true);
  }
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-log-del]');
    if (b && await confirmDialog('Excluir registro', 'Excluir este registro de jornada?')) {
      await api(`/work-logs/${b.dataset.logDel}`, { method: 'DELETE' }); toast('Registro excluído.'); load();
    }
  });
  await load();
};

function logsTable(logs, admin) {
  if (!logs.length) return '<p class="empty-state">Nenhuma jornada registrada neste mês.</p>';
  const total = logs.reduce((a, l) => a + l.hours, 0);
  return `<div class="table-scroll" role="region" aria-label="Jornadas registradas" tabindex="0"><table>
    <caption>Jornadas de ${esc(monthLabel(state.month))} — total ${hours(Math.round(total * 100) / 100)}</caption>
    <thead><tr><th scope="col">Data</th>${admin ? '<th scope="col">Colaborador</th>' : ''}<th scope="col">Entrada</th><th scope="col">Saída</th><th scope="col" class="num">Intervalo</th><th scope="col" class="num">Horas</th><th scope="col">Obs.</th>${admin ? '<th scope="col"><span class="sr-only">Ações</span></th>' : ''}</tr></thead>
    <tbody>${logs.map((l) => `<tr><td>${brDate(l.date)}</td>${admin ? `<td>${esc(l.user_name)}</td>` : ''}<td>${esc(l.clock_in)}</td><td>${esc(l.clock_out)}</td>
      <td class="num">${l.break_minutes} min</td><td class="num">${hours(l.hours)}</td><td>${esc(l.note || '')}</td>
      ${admin ? `<td><button type="button" class="btn small danger" data-log-del="${l.id}">Excluir<span class="sr-only"> registro de ${esc(l.user_name)} em ${brDate(l.date)}</span></button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
}

// ---------- ADMIN: usuários ----------
VIEWS.usuarios = async (view) => {
  view.innerHTML = `<div class="toolbar"><button type="button" class="btn primary" id="new-user">+ Novo usuário</button></div><div id="users"></div>`;
  let users = [], teams = [];
  async function load() {
    [users, teams] = await Promise.all([api('/users'), api('/teams')]);
    $('#users').innerHTML = `<div class="table-scroll" role="region" aria-label="Usuários" tabindex="0"><table>
      <caption class="sr-only">Usuários cadastrados</caption>
      <thead><tr><th scope="col">Nome</th><th scope="col">E-mail</th><th scope="col">Perfil</th><th scope="col">Equipe</th><th scope="col">Situação</th><th scope="col"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${users.map((u) => `<tr><th scope="row">${esc(u.name)}</th><td>${esc(u.email)}</td>
        <td>${badge(u.role, u.role === 'admin' ? 'Administrador' : 'Operador')}</td><td>${esc(u.team_name || '—')}</td>
        <td>${u.active ? badge('sc-ok', 'Ativo') : badge('st-cancelado', 'Inativo')}</td>
        <td class="actions"><button type="button" class="btn small" data-user-edit="${u.id}">Editar<span class="sr-only"> ${esc(u.name)}</span></button>
        ${u.id !== state.user.id ? `<button type="button" class="btn small danger" data-user-del="${u.id}">Excluir<span class="sr-only"> ${esc(u.name)}</span></button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  const form = (u) => openDialog({
    title: u ? `Editar ${u.name}` : 'Novo usuário',
    body: `${field('name', 'Nome completo', 'text', u?.name || '', 'required autocomplete="off"')}
      ${field('email', 'E-mail', 'email', u?.email || '', 'required autocomplete="off"')}
      ${select('role', 'Perfil', [['operador', 'Operador'], ['admin', 'Administrador']], u?.role || 'operador', 'required')}
      ${select('team_id', 'Equipe de escala', [['', 'Sem equipe'], ...teams.map((t) => [t.id, `${t.name} (${t.scale_model})`])], u?.team_id || '')}
      ${field('password', u ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial (mín. 8 caracteres)', 'password', '', `${u ? '' : 'required'} minlength="8" autocomplete="new-password"`)}
      ${u ? select('active', 'Situação', [['1', 'Ativo'], ['0', 'Inativo']], u.active ? '1' : '0') : ''}`,
    onSubmit: async (fd) => {
      const body = Object.fromEntries(fd);
      body.team_id = body.team_id ? Number(body.team_id) : null;
      if (!body.password) delete body.password;
      if ('active' in body) body.active = body.active === '1';
      await api(u ? `/users/${u.id}` : '/users', { method: u ? 'PUT' : 'POST', body });
      toast(u ? 'Usuário atualizado.' : 'Usuário criado.'); load();
    },
  });
  $('#new-user').addEventListener('click', () => form());
  view.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-user-edit]'); if (ed) return form(users.find((u) => u.id === Number(ed.dataset.userEdit)));
    const del = e.target.closest('[data-user-del]');
    if (del) {
      const u = users.find((x) => x.id === Number(del.dataset.userDel));
      if (await confirmDialog('Excluir usuário', `Excluir ${u.name}? Os agendamentos e jornadas dele também serão removidos. Prefira inativar.`)) {
        await api(`/users/${u.id}`, { method: 'DELETE' }); toast('Usuário excluído.'); load();
      }
    }
  });
  await load();
};

// ---------- ADMIN: relatórios ----------
VIEWS.relatorios = async (view) => {
  const teams = await api('/teams');
  const { from, to } = monthRange(state.month);
  view.innerHTML = `<form class="card" id="rep-form" aria-labelledby="rep-title" novalidate>
      <h2 id="rep-title">Parâmetros</h2>
      <div class="grid-4">
        ${select('report', 'Relatório', [['events', 'Agendamentos (treinamentos, folgas, plantões)'], ['attendance', 'Presença por colaborador'], ['compliance', 'Conformidade das escalas']], 'events')}
        ${field('from', 'De', 'date', from, 'required')}
        ${field('to', 'Até', 'date', to, 'required')}
        ${select('team_id', 'Equipe', [['', 'Todas'], ...teams.map((t) => [t.id, t.name])])}
      </div>
      <div class="grid-4" id="ev-filters">
        ${select('type', 'Tipo', [['', 'Todos'], ...Object.entries(TYPE)])}
        ${select('status', 'Situação', [['', 'Todas'], ...Object.entries(STATUS)])}
      </div>
      <div class="actions">
        <button class="btn primary" type="submit">Visualizar</button>
        <button class="btn" type="button" id="rep-csv">Baixar CSV (Excel)</button>
        <button class="btn" type="button" id="rep-print">Imprimir / salvar PDF</button>
      </div>
    </form>
    <div id="rep-out" class="printable"></div>`;
  const form = $('#rep-form');
  const params = () => {
    const fd = Object.fromEntries(new FormData(form)); const report = fd.report; delete fd.report;
    if (report !== 'events') { delete fd.type; delete fd.status; }
    Object.keys(fd).forEach((k) => { if (!fd[k]) delete fd[k]; });
    return { report, qs: new URLSearchParams(fd) };
  };
  $('[name=report]', form).addEventListener('change', (e) => { $('#ev-filters').hidden = e.target.value !== 'events'; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { report, qs } = params();
    try {
      const rows = await api(`/reports/${report}?${qs}`);
      $('#rep-out').innerHTML = reportTable(report, rows, qs);
      announce(`Relatório gerado com ${rows.length} linhas.`);
      $('#rep-out h2')?.focus();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  $('#rep-csv').addEventListener('click', () => { const { report, qs } = params(); qs.set('format', 'csv'); download(`/reports/${report}?${qs}`, `relatorio-${report}-${qs.get('from')}_${qs.get('to')}.csv`); });
  $('#rep-print').addEventListener('click', () => window.print());
  form.requestSubmit();
};

function reportTable(report, rows, qs) {
  const title = { events: 'Agendamentos', attendance: 'Presença por colaborador', compliance: 'Conformidade das escalas' }[report];
  const head = `<h2 tabindex="-1">${title} — ${brDate(qs.get('from'))} a ${brDate(qs.get('to'))}</h2>`;
  if (!rows.length) return head + '<p class="empty-state">Sem dados no período.</p>';
  let cols;
  if (report === 'events') cols = [['Data', (r) => brDate(r.date)], ['Horário', (r) => `${r.start_time || ''}${r.end_time ? '–' + r.end_time : ''}`], ['Tipo', (r) => TYPE[r.type]], ['Título', (r) => r.title], ['Colaborador', (r) => r.user_name], ['Equipe', (r) => r.team_name || '—'], ['Situação', (r) => STATUS[r.status]]];
  if (report === 'attendance') cols = [['Colaborador', (r) => r.user_name], ['Equipe', (r) => r.team_name || '—'], ['Agendamentos', (r) => r.total], ['Treinamentos', (r) => r.treinamentos || 0], ['Folgas', (r) => r.folgas || 0], ['Compareceu', (r) => r.compareceu || 0], ['Não compareceu', (r) => r.nao_compareceu || 0], ['Pendentes', (r) => r.pendente || 0], ['Presença', (r) => (r.taxa_presenca == null ? '—' : r.taxa_presenca + '%')]];
  if (report === 'compliance') cols = [['Colaborador', (r) => r.user_name], ['Equipe', (r) => r.team_name], ['Escala', (r) => r.scale_model], ['Previstas', (r) => hours(r.expected_hours)], ['Trabalhadas', (r) => hours(r.worked_hours)], ['Saldo', (r) => hours(r.balance_hours)], ['Situação', (r) => SCALE_STATUS[r.status]], ['Irregularidades', (r) => r.violations.length]];
  return `${head}<p class="muted">${rows.length} registro(s).</p><div class="table-scroll" role="region" aria-label="${title}" tabindex="0"><table>
    <caption class="sr-only">${title}</caption>
    <thead><tr>${cols.map(([l]) => `<th scope="col">${l}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([, f]) => `<td>${esc(f(r))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- OPERADOR: minha agenda ----------
VIEWS['minha-agenda'] = async (view) => {
  view.innerHTML = `<section aria-labelledby="pend-title" class="card"><h2 id="pend-title">Validar presença</h2><div id="pending"></div></section>
    <div id="nav-slot"></div>
    <div class="toolbar"><div role="group" aria-label="Modo de visualização" class="seg">
      <button type="button" class="btn small" data-mode="list" aria-pressed="true">Lista</button>
      <button type="button" class="btn small" data-mode="cal" aria-pressed="false">Calendário</button></div></div>
    <div id="agenda"></div>`;
  let mode = 'list', events = [], shifts = [];
  $('#nav-slot').append(monthNav(load));
  async function loadPending() {
    // Pendentes: agendamentos até hoje ainda não validados (últimos 60 dias)
    const from = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const pend = (await api(`/events?from=${from}&to=${today()}&status=agendado`)).filter((e) => e.type !== 'folga');
    $('#pending').innerHTML = pend.length ? `<ul class="pending-list">${pend.map((e) => `<li class="pending-item">
      <div><strong>${esc(e.title)}</strong> ${badge(e.type, TYPE[e.type])}<br><span class="muted">${esc(longDate(e.date))}${e.start_time ? ', ' + esc(e.start_time) : ''}${e.end_time ? '–' + esc(e.end_time) : ''}</span></div>
      <div class="actions" role="group" aria-label="Presença em ${esc(e.title)}">
        <button type="button" class="btn small success" data-att="compareceu" data-id="${e.id}">Compareci</button>
        <button type="button" class="btn small danger" data-att="nao_compareceu" data-id="${e.id}">Não compareci</button></div></li>`).join('')}</ul>`
      : '<p class="empty-state">Nenhuma presença pendente de validação. 🎉</p>';
  }
  async function load() {
    const r = monthRange(state.month);
    [events, shifts] = await Promise.all([api('/events?' + new URLSearchParams(r)), api('/schedule?' + new URLSearchParams(r))]);
    draw();
  }
  function draw() {
    $$('[data-mode]', view).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    if (mode === 'cal') { $('#agenda').innerHTML = calendar(events, shifts); return; }
    $('#agenda').innerHTML = events.length ? `<ol class="agenda-list">${events.map((e) => `<li class="agenda-item ${e.type}">
      <div class="agenda-date"><span class="d">${Number(e.date.slice(8))}</span><span class="m">${esc(new Date(e.date + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'short' }))}</span></div>
      <div class="agenda-body"><h3>${esc(e.title)}</h3>
        <p>${badge(e.type, TYPE[e.type])} ${badge('st-' + e.status, STATUS[e.status])}</p>
        <p class="muted">${esc(longDate(e.date))}${e.start_time ? ` · ${esc(e.start_time)}${e.end_time ? '–' + esc(e.end_time) : ''}` : ''}${e.description ? ' · ' + esc(e.description) : ''}</p>
        ${e.type !== 'folga' && e.status !== 'cancelado' && e.date <= today() ? `<div class="actions" role="group" aria-label="Presença em ${esc(e.title)}">
          <button type="button" class="btn small success" data-att="compareceu" data-id="${e.id}" ${e.status === 'compareceu' ? 'aria-pressed="true"' : 'aria-pressed="false"'}>Compareci</button>
          <button type="button" class="btn small danger" data-att="nao_compareceu" data-id="${e.id}" ${e.status === 'nao_compareceu' ? 'aria-pressed="true"' : 'aria-pressed="false"'}>Não compareci</button></div>` : ''}
      </div></li>`).join('')}</ol>` : '<p class="empty-state">Nenhum agendamento neste mês.</p>';
  }
  view.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-mode]'); if (m) { mode = m.dataset.mode; return draw(); }
    const chip = e.target.closest('[data-event]');
    if (chip) { const ev = events.find((x) => x.id === Number(chip.dataset.event)); return openDialog({ title: ev.title, body: eventDetails(ev) }); }
    const b = e.target.closest('[data-att]'); if (!b) return;
    try {
      await api(`/events/${b.dataset.id}/attendance`, { method: 'PATCH', body: { status: b.dataset.att } });
      toast(`Presença registrada: ${STATUS[b.dataset.att]}.`);
      await Promise.all([loadPending(), load()]);
      $('#pend-title').focus?.();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  $('#pend-title').tabIndex = -1;
  await Promise.all([loadPending(), load()]);
};

// ---------- OPERADOR: minha escala ----------
VIEWS['minha-escala'] = async (view) => {
  const [team] = await api('/teams');
  if (!team) { view.innerHTML = '<p class="empty-state">Você ainda não foi alocado em uma equipe de escala. Procure o administrador.</p>'; return; }
  view.innerHTML = `<section class="card" aria-labelledby="t-title"><h2 id="t-title">${esc(team.name)}</h2>
    <p>${badge('model', team.scale_model)} ${esc(team.model?.label || '')}</p>
    <p>Turno a partir das <strong>${esc(team.shift_start)}</strong>, ${hours(team.daily_hours)} por dia de trabalho.</p>
    <p class="muted">${esc(team.model?.legal || '')}</p>
    <p>Colegas de equipe: ${team.members.map((m) => esc(m.name)).join(', ')}</p></section>
    <div id="nav-slot"></div><div id="cal"></div>`;
  $('#nav-slot').append(monthNav(load));
  async function load() {
    const r = new URLSearchParams(monthRange(state.month));
    const [shifts, events] = await Promise.all([api('/schedule?' + r), api('/events?' + r)]);
    $('#cal').innerHTML = calendar(events, shifts);
    const work = shifts.filter((s) => s.work).length;
    announce(`${work} dias de trabalho em ${monthLabel(state.month)}.`);
  }
  view.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-event]'); if (!chip) return;
    const r = new URLSearchParams(monthRange(state.month));
    const ev = (await api('/events?' + r)).find((x) => x.id === Number(chip.dataset.event));
    openDialog({ title: ev.title, body: eventDetails(ev) });
  });
  await load();
};

// ---------- OPERADOR: minhas jornadas ----------
VIEWS['minhas-jornadas'] = async (view) => {
  view.innerHTML = '<p class="muted">Jornadas registradas pelo administrador para você.</p><div id="nav-slot"></div><div id="logs"></div>';
  $('#nav-slot').append(monthNav(load));
  async function load() { $('#logs').innerHTML = logsTable(await api('/work-logs?' + new URLSearchParams(monthRange(state.month))), false); }
  await load();
};

// ======================= início =======================
render();
