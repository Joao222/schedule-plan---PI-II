// API REST + servidor de arquivos estáticos.
const express = require('express');
const path = require('node:path');
const { db, audit } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const { SCALE_MODELS, buildSchedule, analyzeUser, logMinutes, round } = require('./scales');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Cabeçalhos de segurança básicos
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
  });
  next();
});

// ---------------- utilidades ----------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r?.catch) r.catch(next); } catch (e) { next(e); } };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVENT_TYPES = ['treinamento', 'folga', 'plantao'];
const EVENT_STATUS = ['agendado', 'compareceu', 'nao_compareceu', 'cancelado'];

function req_(cond, msg) { if (!cond) throw new HttpError(400, msg); }
function optTime(v, field) { if (v == null || v === '') return null; req_(TIME_RE.test(v), `${field} deve estar no formato HH:MM`); return v; }
function period(q) {
  const today = new Date().toISOString().slice(0, 10);
  const from = q.from || today.slice(0, 8) + '01';
  const to = q.to || new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7), 0)).toISOString().slice(0, 10);
  req_(DATE_RE.test(from) && DATE_RE.test(to), 'Datas devem estar no formato AAAA-MM-DD');
  req_(from <= to, 'Data inicial deve ser anterior à final');
  req_((Date.parse(to) - Date.parse(from)) / 86400000 <= 366, 'Período máximo de 1 ano');
  return { from, to };
}
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, team_id: u.team_id, active: !!u.active });

function toCsv(rows, columns) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = columns.map((c) => esc(c.label)).join(';');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(';'));
  return '﻿' + [head, ...body].join('\r\n'); // BOM + ";" para abrir corretamente no Excel pt-BR
}
function sendReport(res, req, name, rows, columns) {
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows, columns));
  }
  res.json(rows);
}

// ---------------- autenticação ----------------
function authenticate(req, res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token);
  if (!payload) return next(new HttpError(401, 'Sessão inválida ou expirada. Faça login novamente.'));
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(payload.sub);
  if (!user) return next(new HttpError(401, 'Usuário inativo ou inexistente.'));
  req.user = user;
  next();
}
const requireAdmin = (req, res, next) => next(req.user.role === 'admin' ? undefined : new HttpError(403, 'Acesso restrito ao perfil administrador.'));

// Limite simples de tentativas de login (por IP)
const attempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip; const now = Date.now();
  const a = attempts.get(key) || { count: 0, reset: now + 15 * 60000 };
  if (now > a.reset) { a.count = 0; a.reset = now + 15 * 60000; }
  if (a.count >= 10) return next(new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.'));
  a.count++; attempts.set(key, a); next();
}

const api = express.Router();

api.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

api.post('/auth/login', loginRateLimit, wrap((req, res) => {
  const { email, password } = req.body || {};
  req_(email && password, 'Informe e-mail e senha.');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !user.active || !verifyPassword(String(password), user.password_hash)) {
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  attempts.delete(req.ip);
  audit(user.id, 'login');
  res.json({ token: signToken({ sub: user.id, role: user.role }), user: publicUser(user) });
}));

api.use(authenticate);

api.get('/auth/me', (req, res) => res.json(publicUser(req.user)));

api.post('/auth/change-password', wrap((req, res) => {
  const { current, next: nextPwd } = req.body || {};
  req_(verifyPassword(String(current || ''), req.user.password_hash), 'Senha atual incorreta.');
  req_(typeof nextPwd === 'string' && nextPwd.length >= 8, 'A nova senha deve ter pelo menos 8 caracteres.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(nextPwd), req.user.id);
  audit(req.user.id, 'change_password');
  res.json({ ok: true });
}));

// ---------------- modelos de escala ----------------
api.get('/scale-models', (req, res) => {
  res.json(Object.entries(SCALE_MODELS).map(([id, m]) => ({ id, ...m })));
});

// ---------------- usuários (admin) ----------------
api.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.name`).all()
    .map((u) => ({ ...publicUser(u), team_name: u.team_name })));
});

function validateUser(body, isNew) {
  const { name, email, role, password, team_id } = body || {};
  req_(name && String(name).trim().length >= 2, 'Nome é obrigatório.');
  req_(EMAIL_RE.test(String(email || '')), 'E-mail inválido.');
  req_(['admin', 'operador'].includes(role), 'Perfil deve ser "admin" ou "operador".');
  if (isNew || password) req_(typeof password === 'string' && password.length >= 8, 'Senha deve ter pelo menos 8 caracteres.');
  if (team_id) req_(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(team_id), 'Equipe inexistente.');
  return { name: String(name).trim(), email: String(email).trim(), role, password, team_id: team_id || null };
}

api.post('/users', requireAdmin, wrap((req, res) => {
  const u = validateUser(req.body, true);
  req_(!db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email), 'Já existe usuário com este e-mail.');
  const r = db.prepare('INSERT INTO users (name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?)')
    .run(u.name, u.email, hashPassword(u.password), u.role, u.team_id);
  audit(req.user.id, 'user_create', { id: Number(r.lastInsertRowid) });
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
}));

api.put('/users/:id', requireAdmin, wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) throw new HttpError(404, 'Usuário não encontrado.');
  const u = validateUser({ ...publicUser(existing), ...req.body }, false);
  const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(u.email, existing.id);
  req_(!dup, 'Já existe usuário com este e-mail.');
  const active = req.body.active === undefined ? existing.active : (req.body.active ? 1 : 0);
  if (existing.id === req.user.id) req_(active && u.role === 'admin', 'Você não pode desativar ou rebaixar seu próprio usuário.');
  db.prepare('UPDATE users SET name=?, email=?, role=?, team_id=?, active=? WHERE id=?')
    .run(u.name, u.email, u.role, u.team_id, active, existing.id);
  if (u.password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(u.password), existing.id);
  audit(req.user.id, 'user_update', { id: existing.id });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id)));
}));

api.delete('/users/:id', requireAdmin, wrap((req, res) => {
  req_(Number(req.params.id) !== req.user.id, 'Você não pode excluir seu próprio usuário.');
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Usuário não encontrado.');
  audit(req.user.id, 'user_delete', { id: Number(req.params.id) });
  res.status(204).end();
}));

// ---------------- equipes de escala (admin) ----------------
function teamWithMembers(t) {
  const members = db.prepare("SELECT id, name, email, role FROM users WHERE team_id = ? AND active = 1 ORDER BY name").all(t.id);
  return { ...t, model: SCALE_MODELS[t.scale_model], members };
}

api.get('/teams', (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT * FROM teams ORDER BY name').all()
    : db.prepare('SELECT * FROM teams WHERE id = ?').all(req.user.team_id ?? -1);
  res.json(rows.map(teamWithMembers));
});

function validateTeam(body) {
  const { name, scale_model, cycle_start, shift_start, daily_hours, description } = body || {};
  req_(name && String(name).trim(), 'Nome da equipe é obrigatório.');
  req_(SCALE_MODELS[scale_model], 'Modelo de escala inválido.');
  req_(DATE_RE.test(cycle_start || ''), 'Início do ciclo deve estar no formato AAAA-MM-DD.');
  const shift = optTime(shift_start, 'Início do turno') || '08:00';
  const hours = daily_hours === undefined || daily_hours === '' ? SCALE_MODELS[scale_model].dailyHours : Number(daily_hours);
  req_(hours > 0 && hours <= 24, 'Horas por dia devem estar entre 0 e 24.');
  return { name: String(name).trim(), scale_model, cycle_start, shift_start: shift, daily_hours: hours, description: description || null };
}

api.post('/teams', requireAdmin, wrap((req, res) => {
  const t = validateTeam(req.body);
  req_(!db.prepare('SELECT 1 FROM teams WHERE name = ?').get(t.name), 'Já existe equipe com este nome.');
  const r = db.prepare('INSERT INTO teams (name, scale_model, cycle_start, shift_start, daily_hours, description) VALUES (?,?,?,?,?,?)')
    .run(t.name, t.scale_model, t.cycle_start, t.shift_start, t.daily_hours, t.description);
  audit(req.user.id, 'team_create', { id: Number(r.lastInsertRowid) });
  res.status(201).json(teamWithMembers(db.prepare('SELECT * FROM teams WHERE id = ?').get(r.lastInsertRowid)));
}));

api.put('/teams/:id', requireAdmin, wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!existing) throw new HttpError(404, 'Equipe não encontrada.');
  const t = validateTeam({ ...existing, ...req.body });
  req_(!db.prepare('SELECT 1 FROM teams WHERE name = ? AND id <> ?').get(t.name, existing.id), 'Já existe equipe com este nome.');
  db.prepare('UPDATE teams SET name=?, scale_model=?, cycle_start=?, shift_start=?, daily_hours=?, description=? WHERE id=?')
    .run(t.name, t.scale_model, t.cycle_start, t.shift_start, t.daily_hours, t.description, existing.id);
  audit(req.user.id, 'team_update', { id: existing.id });
  res.json(teamWithMembers(db.prepare('SELECT * FROM teams WHERE id = ?').get(existing.id)));
}));

// Substitui a lista de integrantes da equipe
api.put('/teams/:id/members', requireAdmin, wrap((req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) throw new HttpError(404, 'Equipe não encontrada.');
  const ids = (req.body?.user_ids || []).map(Number);
  req_(ids.every(Number.isInteger), 'Lista de integrantes inválida.');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET team_id = NULL WHERE team_id = ?').run(team.id);
    const upd = db.prepare('UPDATE users SET team_id = ? WHERE id = ?');
    for (const id of ids) upd.run(team.id, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req.user.id, 'team_members', { id: team.id, user_ids: ids });
  res.json(teamWithMembers(team));
}));

api.delete('/teams/:id', requireAdmin, wrap((req, res) => {
  const r = db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Equipe não encontrada.');
  audit(req.user.id, 'team_delete', { id: Number(req.params.id) });
  res.status(204).end();
}));

// Escala prevista (gerada a partir do modelo)
api.get('/schedule', wrap((req, res) => {
  const { from, to } = period(req.query);
  let teams;
  if (req.user.role === 'admin') {
    teams = req.query.team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').all(req.query.team_id) : db.prepare('SELECT * FROM teams').all();
  } else {
    teams = db.prepare('SELECT * FROM teams WHERE id = ?').all(req.user.team_id ?? -1);
  }
  const out = [];
  for (const t of teams) {
    let members = db.prepare('SELECT id, name FROM users WHERE team_id = ? AND active = 1').all(t.id);
    if (req.user.role !== 'admin') members = members.filter((m) => m.id === req.user.id);
    else if (req.query.user_id) members = members.filter((m) => m.id === Number(req.query.user_id));
    out.push(...buildSchedule(t, members, from, to));
  }
  res.json(out);
}));

// Conformidade: quem está excedendo o tempo de escala
function compliance(from, to, teamId) {
  const teams = teamId ? db.prepare('SELECT * FROM teams WHERE id = ?').all(teamId) : db.prepare('SELECT * FROM teams ORDER BY name').all();
  const results = [];
  for (const t of teams) {
    const members = db.prepare('SELECT id, name FROM users WHERE team_id = ? AND active = 1 ORDER BY name').all(t.id);
    for (const m of members) {
      // Margem de 1 dia antes para avaliar interjornada/DSR na virada do período
      const logs = db.prepare('SELECT * FROM work_logs WHERE user_id = ? AND date BETWEEN ? AND ?').all(m.id, from, to);
      const leaves = db.prepare("SELECT date FROM events WHERE user_id = ? AND type = 'folga' AND status <> 'cancelado' AND date BETWEEN ? AND ?")
        .all(m.id, from, to).map((r) => r.date);
      results.push(analyzeUser(t, m, logs, leaves, from, to));
    }
  }
  const order = { excedendo: 0, atencao: 1, ok: 2 };
  return results.sort((a, b) => order[a.status] - order[b.status] || b.balance_hours - a.balance_hours);
}

api.get('/scales/compliance', requireAdmin, wrap((req, res) => {
  const { from, to } = period(req.query);
  res.json({ from, to, results: compliance(from, to, req.query.team_id) });
}));

// ---------------- agenda (eventos) ----------------
function eventQuery(user, q) {
  const { from, to } = period(q);
  const where = ['e.date BETWEEN ? AND ?']; const params = [from, to];
  if (user.role !== 'admin') { where.push('e.user_id = ?'); params.push(user.id); }
  else if (q.user_id) { where.push('e.user_id = ?'); params.push(q.user_id); }
  if (q.type) { where.push('e.type = ?'); params.push(q.type); }
  if (q.status) { where.push('e.status = ?'); params.push(q.status); }
  if (q.team_id && user.role === 'admin') { where.push('u.team_id = ?'); params.push(q.team_id); }
  return db.prepare(`SELECT e.*, u.name AS user_name, t.name AS team_name FROM events e
    JOIN users u ON u.id = e.user_id LEFT JOIN teams t ON t.id = u.team_id
    WHERE ${where.join(' AND ')} ORDER BY e.date, e.start_time, u.name`).all(...params);
}

api.get('/events', wrap((req, res) => res.json(eventQuery(req.user, req.query))));

function validateEvent(body) {
  const { user_id, type, title, date, start_time, end_time, description, status } = body || {};
  req_(db.prepare('SELECT 1 FROM users WHERE id = ?').get(user_id), 'Colaborador inexistente.');
  req_(EVENT_TYPES.includes(type), 'Tipo deve ser treinamento, folga ou plantao.');
  req_(title && String(title).trim(), 'Título é obrigatório.');
  req_(DATE_RE.test(date || ''), 'Data deve estar no formato AAAA-MM-DD.');
  const st = optTime(start_time, 'Hora inicial'); const et = optTime(end_time, 'Hora final');
  req_(!status || EVENT_STATUS.includes(status), 'Status inválido.');
  return { user_id: Number(user_id), type, title: String(title).trim(), date, start_time: st, end_time: et, description: description || null, status: status || 'agendado' };
}

api.post('/events', requireAdmin, wrap((req, res) => {
  // Permite agendar para vários colaboradores de uma vez (ex.: treinamento de equipe)
  const userIds = Array.isArray(req.body.user_ids) && req.body.user_ids.length ? req.body.user_ids : [req.body.user_id];
  const created = [];
  db.exec('BEGIN');
  try {
    for (const uid of userIds) {
      const e = validateEvent({ ...req.body, user_id: uid });
      const r = db.prepare('INSERT INTO events (user_id, type, title, date, start_time, end_time, description, status, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(e.user_id, e.type, e.title, e.date, e.start_time, e.end_time, e.description, e.status, req.user.id);
      created.push(Number(r.lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req.user.id, 'event_create', { ids: created });
  res.status(201).json(created.map((id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id)));
}));

api.put('/events/:id', requireAdmin, wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) throw new HttpError(404, 'Agendamento não encontrado.');
  const e = validateEvent({ ...existing, ...req.body });
  db.prepare('UPDATE events SET user_id=?, type=?, title=?, date=?, start_time=?, end_time=?, description=?, status=? WHERE id=?')
    .run(e.user_id, e.type, e.title, e.date, e.start_time, e.end_time, e.description, e.status, existing.id);
  audit(req.user.id, 'event_update', { id: existing.id });
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(existing.id));
}));

api.delete('/events/:id', requireAdmin, wrap((req, res) => {
  const r = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Agendamento não encontrado.');
  audit(req.user.id, 'event_delete', { id: Number(req.params.id) });
  res.status(204).end();
}));

// Operador valida comparecimento nos próprios agendamentos
api.patch('/events/:id/attendance', wrap((req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) throw new HttpError(404, 'Agendamento não encontrado.');
  if (req.user.role !== 'admin' && ev.user_id !== req.user.id) throw new HttpError(403, 'Você só pode validar seus próprios agendamentos.');
  const { status } = req.body || {};
  req_(['compareceu', 'nao_compareceu', 'agendado'].includes(status), 'Status deve ser compareceu, nao_compareceu ou agendado.');
  req_(ev.status !== 'cancelado', 'Agendamento cancelado não pode ser validado.');
  const today = new Date().toISOString().slice(0, 10);
  if (req.user.role !== 'admin') req_(ev.date <= today, 'Só é possível validar presença na data do agendamento ou depois.');
  db.prepare("UPDATE events SET status = ?, validated_at = CASE WHEN ? = 'agendado' THEN NULL ELSE datetime('now') END WHERE id = ?")
    .run(status, status, ev.id);
  audit(req.user.id, 'event_attendance', { id: ev.id, status });
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id));
}));

// ---------------- jornadas registradas (ponto) ----------------
api.get('/work-logs', wrap((req, res) => {
  const { from, to } = period(req.query);
  const params = [from, to]; let extra = '';
  if (req.user.role !== 'admin') { extra = 'AND w.user_id = ?'; params.push(req.user.id); }
  else if (req.query.user_id) { extra = 'AND w.user_id = ?'; params.push(req.query.user_id); }
  const rows = db.prepare(`SELECT w.*, u.name AS user_name FROM work_logs w JOIN users u ON u.id = w.user_id
    WHERE w.date BETWEEN ? AND ? ${extra} ORDER BY w.date DESC, u.name`).all(...params);
  res.json(rows.map((r) => ({ ...r, hours: round(logMinutes(r) / 60) })));
}));

api.post('/work-logs', requireAdmin, wrap((req, res) => {
  const { user_id, date, clock_in, clock_out, break_minutes, note } = req.body || {};
  req_(db.prepare('SELECT 1 FROM users WHERE id = ?').get(user_id), 'Colaborador inexistente.');
  req_(DATE_RE.test(date || ''), 'Data inválida.');
  req_(TIME_RE.test(clock_in || '') && TIME_RE.test(clock_out || ''), 'Entrada e saída devem estar no formato HH:MM.');
  const brk = Number(break_minutes || 0); req_(brk >= 0 && brk < 720, 'Intervalo inválido.');
  const r = db.prepare('INSERT INTO work_logs (user_id, date, clock_in, clock_out, break_minutes, note) VALUES (?,?,?,?,?,?)')
    .run(user_id, date, clock_in, clock_out, brk, note || null);
  audit(req.user.id, 'work_log_create', { id: Number(r.lastInsertRowid) });
  const row = db.prepare('SELECT * FROM work_logs WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ ...row, hours: round(logMinutes(row) / 60) });
}));

api.delete('/work-logs/:id', requireAdmin, wrap((req, res) => {
  const r = db.prepare('DELETE FROM work_logs WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Registro não encontrado.');
  res.status(204).end();
}));

// ---------------- relatórios (admin) ----------------
const TYPE_LABEL = { treinamento: 'Treinamento', folga: 'Folga', plantao: 'Plantão' };
const STATUS_LABEL = { agendado: 'Agendado', compareceu: 'Compareceu', nao_compareceu: 'Não compareceu', cancelado: 'Cancelado' };
const brDate = (d) => d ? d.split('-').reverse().join('/') : '';

api.get('/reports/events', requireAdmin, wrap((req, res) => {
  sendReport(res, req, 'agendamentos', eventQuery(req.user, req.query), [
    { label: 'Data', value: (r) => brDate(r.date) }, { label: 'Início', key: 'start_time' }, { label: 'Fim', key: 'end_time' },
    { label: 'Tipo', value: (r) => TYPE_LABEL[r.type] }, { label: 'Título', key: 'title' },
    { label: 'Colaborador', key: 'user_name' }, { label: 'Equipe', key: 'team_name' },
    { label: 'Status', value: (r) => STATUS_LABEL[r.status] }, { label: 'Validado em', key: 'validated_at' },
  ]);
}));

api.get('/reports/attendance', requireAdmin, wrap((req, res) => {
  const { from, to } = period(req.query);
  const rows = db.prepare(`SELECT u.id AS user_id, u.name AS user_name, t.name AS team_name,
      COUNT(e.id) AS total,
      SUM(e.status = 'compareceu') AS compareceu,
      SUM(e.status = 'nao_compareceu') AS nao_compareceu,
      SUM(e.status = 'agendado') AS pendente,
      SUM(e.type = 'treinamento') AS treinamentos,
      SUM(e.type = 'folga') AS folgas
    FROM users u LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN events e ON e.user_id = u.id AND e.date BETWEEN ? AND ? AND e.status <> 'cancelado'
    WHERE u.role = 'operador' GROUP BY u.id ORDER BY u.name`).all(from, to)
    .map((r) => {
      const validated = (r.compareceu || 0) + (r.nao_compareceu || 0);
      return { ...r, taxa_presenca: validated ? Math.round((r.compareceu / validated) * 100) : null };
    });
  sendReport(res, req, 'presenca', rows, [
    { label: 'Colaborador', key: 'user_name' }, { label: 'Equipe', key: 'team_name' }, { label: 'Agendamentos', key: 'total' },
    { label: 'Treinamentos', key: 'treinamentos' }, { label: 'Folgas', key: 'folgas' },
    { label: 'Compareceu', key: 'compareceu' }, { label: 'Não compareceu', key: 'nao_compareceu' },
    { label: 'Pendentes', key: 'pendente' }, { label: 'Taxa de presença (%)', key: 'taxa_presenca' },
  ]);
}));

api.get('/reports/compliance', requireAdmin, wrap((req, res) => {
  const { from, to } = period(req.query);
  const rows = compliance(from, to, req.query.team_id);
  sendReport(res, req, 'escalas-conformidade', rows, [
    { label: 'Colaborador', key: 'user_name' }, { label: 'Equipe', key: 'team_name' }, { label: 'Escala', key: 'scale_model' },
    { label: 'Horas previstas', value: (r) => String(r.expected_hours).replace('.', ',') },
    { label: 'Horas trabalhadas', value: (r) => String(r.worked_hours).replace('.', ',') },
    { label: 'Saldo (h)', value: (r) => String(r.balance_hours).replace('.', ',') },
    { label: 'Situação', value: (r) => ({ ok: 'Dentro da escala', atencao: 'Atenção', excedendo: 'Excedendo' })[r.status] },
    { label: 'Irregularidades', value: (r) => r.violations.map((v) => v.message).join(' | ') },
  ]);
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// Front-end
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Tratamento de erros
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor.' : err.message });
});

module.exports = app;
