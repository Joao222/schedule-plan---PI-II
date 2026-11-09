process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { seed } = require('../src/seed');
const { analyzeUser, isWorkDay } = require('../src/scales');

let base, server;
test.before(async () => { seed(); server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = async (email, password) => (await call('/auth/login', { method: 'POST', body: { email, password } })).data.token;

test('login: credenciais inválidas e válidas', async () => {
  assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'admin@empresa.com', password: 'x' } })).status, 401);
  const r = await call('/auth/login', { method: 'POST', body: { email: 'admin@empresa.com', password: 'Admin@123' } });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin'); assert.ok(r.data.token);
});

test('rotas exigem token e operador não acessa rotas de admin', async () => {
  assert.equal((await call('/events')).status, 401);
  const op = await login('operador@empresa.com', 'Operador@123');
  assert.equal((await call('/users', { token: op })).status, 403);
  assert.equal((await call('/reports/events', { token: op })).status, 403);
  assert.equal((await call('/scales/compliance', { token: op })).status, 403);
});

test('operador vê apenas a própria agenda e valida presença', async () => {
  const op = await login('operador@empresa.com', 'Operador@123');
  const me = (await call('/auth/me', { token: op })).data;
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const evs = (await call(`/events?from=${from}&to=${to}`, { token: op })).data;
  assert.ok(evs.length > 0); assert.ok(evs.every((e) => e.user_id === me.id));
  const todayEv = evs.find((e) => e.date <= new Date().toISOString().slice(0, 10) && e.status === 'agendado');
  const r = await call(`/events/${todayEv.id}/attendance`, { token: op, method: 'PATCH', body: { status: 'compareceu' } });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'compareceu'); assert.ok(r.data.validated_at);
  const future = evs.find((e) => e.date > new Date().toISOString().slice(0, 10));
  assert.equal((await call(`/events/${future.id}/attendance`, { token: op, method: 'PATCH', body: { status: 'compareceu' } })).status, 400);
  // evento de outro usuário
  const adm = await login('admin@empresa.com', 'Admin@123');
  const other = (await call(`/events?from=${from}&to=${to}`, { token: adm })).data.find((e) => e.user_id !== me.id);
  assert.equal((await call(`/events/${other.id}/attendance`, { token: op, method: 'PATCH', body: { status: 'compareceu' } })).status, 403);
});

test('admin cria equipe, altera integrantes e agenda treinamento em lote', async () => {
  const adm = await login('admin@empresa.com', 'Admin@123');
  const t = await call('/teams', { token: adm, method: 'POST', body: { name: 'Noturno C', scale_model: '12x36', cycle_start: '2026-01-01', shift_start: '19:00' } });
  assert.equal(t.status, 201); assert.equal(t.data.daily_hours, 12);
  const users = (await call('/users', { token: adm })).data.filter((u) => u.role === 'operador').slice(-2);
  const m = await call(`/teams/${t.data.id}/members`, { token: adm, method: 'PUT', body: { user_ids: users.map((u) => u.id) } });
  assert.equal(m.data.members.length, 2);
  const ev = await call('/events', { token: adm, method: 'POST', body: { user_ids: users.map((u) => u.id), type: 'treinamento', title: 'NR-10', date: '2026-12-01', start_time: '08:00' } });
  assert.equal(ev.status, 201); assert.equal(ev.data.length, 2);
  assert.equal((await call('/events', { token: adm, method: 'POST', body: { user_id: users[0].id, type: 'x', title: 'a', date: '2026-12-01' } })).status, 400);
});

test('conformidade aponta quem excede a escala e relatório CSV', async () => {
  const adm = await login('admin@empresa.com', 'Admin@123');
  const from = new Date(Date.now() - 25 * 864e5).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const r = await call(`/scales/compliance?from=${from}&to=${to}`, { token: adm });
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.data.results.map((x) => [x.user_name, x]));
  assert.equal(byName['Diego Lima'].status, 'excedendo');
  assert.equal(byName['Felipe Alves'].status, 'excedendo');
  assert.ok(byName['Eduarda Rocha'].violations.some((v) => v.rule === 'trabalho_em_folga'));
  assert.ok(byName['Henrique Dias'].violations.some((v) => v.rule === 'interjornada' || v.rule === 'trabalho_em_folga'));
  assert.equal(byName['Carla Souza'].status, 'ok');
  const csv = await call(`/reports/compliance?from=${from}&to=${to}&format=csv`, { token: adm });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Colaborador;Equipe;Escala/);
});

test('regras de escala: 12x36 alterna e 24x48 exige 48h de descanso', () => {
  const t12 = { id: 1, name: 'x', scale_model: '12x36', cycle_start: '2026-01-01', daily_hours: 12 };
  assert.equal(isWorkDay(t12, '2026-01-01'), true);
  assert.equal(isWorkDay(t12, '2026-01-02'), false);
  assert.equal(isWorkDay(t12, '2026-01-03'), true);
  const t24 = { id: 2, name: 'y', scale_model: '24x48', cycle_start: '2026-01-01', daily_hours: 24 };
  const ok = analyzeUser(t24, { id: 1, name: 'A' }, [
    { date: '2026-01-01', clock_in: '07:00', clock_out: '07:00', break_minutes: 0 },
    { date: '2026-01-04', clock_in: '07:00', clock_out: '07:00', break_minutes: 0 },
  ], [], '2026-01-01', '2026-01-06');
  assert.equal(ok.status, 'ok'); assert.equal(ok.worked_hours, 48); assert.equal(ok.expected_hours, 48);
  const bad = analyzeUser(t24, { id: 1, name: 'A' }, [
    { date: '2026-01-01', clock_in: '07:00', clock_out: '07:00', break_minutes: 0 },
    { date: '2026-01-03', clock_in: '07:00', clock_out: '07:00', break_minutes: 0 },
  ], [], '2026-01-01', '2026-01-06');
  assert.equal(bad.status, 'excedendo');
  assert.ok(bad.violations.some((v) => v.rule === 'interjornada'));
});

test('regras de escala: 6x1 detecta falta de DSR', () => {
  const t = { id: 1, name: 'x', scale_model: '5x2', cycle_start: '2026-01-05', daily_hours: 8 };
  const logs = [];
  for (let d = 5; d <= 11; d++) logs.push({ date: `2026-01-${String(d).padStart(2, '0')}`, clock_in: '08:00', clock_out: '17:00', break_minutes: 60 });
  const r = analyzeUser(t, { id: 1, name: 'A' }, logs, [], '2026-01-05', '2026-01-11');
  assert.ok(r.violations.some((v) => v.rule === 'dsr'));
  assert.ok(r.violations.some((v) => v.rule === 'trabalho_em_folga'));
});
