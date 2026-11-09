// Popula o banco com dados de demonstração (executado apenas se o banco estiver vazio).
const { db } = require('./db');
const { hashPassword } = require('./auth');
const { buildSchedule, addDays } = require('./scales');

function seed({ force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0 && !force) return false;

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const anchor = addDays(monthStart, -28);

  const insTeam = db.prepare('INSERT INTO teams (name, scale_model, cycle_start, shift_start, daily_hours, description) VALUES (?,?,?,?,?,?)');
  const teams = {
    adm: insTeam.run('Administrativo', '5x2', anchor, '08:00', 8.8, 'Backoffice em horário comercial').lastInsertRowid,
    atd: insTeam.run('Atendimento', '6x1', anchor, '09:00', 7.33, 'Loja / atendimento ao cliente').lastInsertRowid,
    pa: insTeam.run('Plantão A (diurno)', '12x36', anchor, '07:00', 12, 'Turma A — dias pares do ciclo').lastInsertRowid,
    pb: insTeam.run('Plantão B (noturno)', '12x36', addDays(anchor, 1), '19:00', 12, 'Turma B — alterna com a turma A').lastInsertRowid,
    bri: insTeam.run('Brigada de Incêndio', '24x48', anchor, '07:00', 24, 'Bombeiros civis').lastInsertRowid,
  };

  const insUser = db.prepare('INSERT INTO users (name, email, password_hash, role, team_id) VALUES (?,?,?,?,?)');
  const adminPwd = hashPassword('Admin@123');
  const opPwd = hashPassword('Operador@123');
  insUser.run('Ana Administradora', 'admin@empresa.com', adminPwd, 'admin', null);
  const people = [
    ['Bruno Silva', 'bruno@empresa.com', teams.adm], ['Carla Souza', 'carla@empresa.com', teams.adm],
    ['Diego Lima', 'diego@empresa.com', teams.atd], ['Eduarda Rocha', 'eduarda@empresa.com', teams.atd],
    ['Felipe Alves', 'felipe@empresa.com', teams.pa], ['Gabriela Costa', 'gabriela@empresa.com', teams.pa],
    ['Henrique Dias', 'henrique@empresa.com', teams.pb], ['Isabela Martins', 'isabela@empresa.com', teams.pb],
    ['João Pereira', 'operador@empresa.com', teams.bri], ['Karina Nunes', 'karina@empresa.com', teams.bri],
  ];
  const userIds = people.map(([n, e, t]) => Number(insUser.run(n, e, opPwd, 'operador', t).lastInsertRowid));
  const [bruno, carla, diego, eduarda, felipe, gabriela, henrique, isabela, joao, karina] = userIds;

  // Agendamentos
  const insEv = db.prepare('INSERT INTO events (user_id, type, title, date, start_time, end_time, description, status, validated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,1)');
  const d = (n) => addDays(today, n);
  const ev = (u, type, title, date, st, et, desc, status = 'agendado') =>
    insEv.run(u, type, title, date, st, et, desc, status, status === 'agendado' ? null : `${date} 18:00:00`);
  for (const u of userIds) ev(u, 'treinamento', 'NR-23 — Combate a incêndio', d(-6), '14:00', '17:00', 'Sala de treinamento 2', u % 3 === 0 ? 'nao_compareceu' : 'compareceu');
  for (const u of [bruno, carla, diego, eduarda]) ev(u, 'treinamento', 'LGPD na prática', d(-1), '09:00', '11:00', 'Online (Teams)');
  ev(joao, 'treinamento', 'Primeiros socorros — reciclagem', d(0), '08:00', '12:00', 'Auditório');
  ev(karina, 'treinamento', 'Primeiros socorros — reciclagem', d(0), '08:00', '12:00', 'Auditório');
  for (const u of userIds) ev(u, 'treinamento', 'Integração de segurança 2026', d(5), '10:00', '12:00', 'Obrigatório');
  ev(bruno, 'folga', 'Folga compensatória', d(3), null, null, 'Banco de horas');
  ev(diego, 'folga', 'Folga — aniversário', d(8), null, null, null);
  ev(gabriela, 'folga', 'Folga abonada', d(-3), null, null, 'Doação de sangue (art. 473)', 'compareceu');
  ev(felipe, 'plantao', 'Plantão extra — cobertura', d(2), '07:00', '19:00', 'Cobertura de férias');
  ev(joao, 'plantao', 'Plantão de sobreaviso', d(10), '07:00', '19:00', null);

  // Jornadas registradas desde o início do mês anterior (com alguns excessos propositais)
  const insLog = db.prepare('INSERT INTO work_logs (user_id, date, clock_in, clock_out, break_minutes, note) VALUES (?,?,?,?,?,?)');
  const from = addDays(monthStart, -new Date(Date.UTC(+monthStart.slice(0, 4), +monthStart.slice(5, 7) - 1, 0)).getUTCDate()), to = addDays(today, -1); // desde o início do mês anterior
  let felipeDone = false;
  const extra = {
    [diego]: (date, i) => (i % 2 === 0 ? 150 : 0),            // atendimento fazendo 2h30 extras em dias alternados
    [felipe]: (date) => (date > addDays(today, -12) && !felipeDone ? ((felipeDone = true), 120) : 0), // 12x36 com horas extras (não permitido)
    [joao]: () => 0,
  };
  const teamRows = db.prepare('SELECT * FROM teams').all();
  for (const t of teamRows) {
    const members = db.prepare('SELECT id, name FROM users WHERE team_id = ?').all(t.id);
    const sched = buildSchedule(t, members, from, to).filter((s) => s.work);
    const counter = {};
    const leaves = new Set(db.prepare("SELECT user_id || '|' || date AS k FROM events WHERE type = 'folga'").all().map((r) => r.k));
    for (const s of sched) {
      if (leaves.has(`${s.user_id}|${s.date}`)) continue;
      const i = (counter[s.user_id] = (counter[s.user_id] ?? -1) + 1);
      const breakMin = t.daily_hours >= 12 ? 0 : 60; // 12x36/24x48: intervalo indenizado (art. 59-A)
      const [h, m] = s.start.split(':').map(Number);
      const extraMin = extra[s.user_id] ? extra[s.user_id](s.date, i) : 0;
      const outMin = h * 60 + m + Math.round(t.daily_hours * 60) + breakMin + extraMin;
      const out = `${String(Math.floor(outMin / 60) % 24).padStart(2, '0')}:${String(outMin % 60).padStart(2, '0')}`;
      insLog.run(s.user_id, s.date, s.start, out, breakMin, extraMin ? 'Horas extras' : null);
    }
  }
  // Eduarda trabalhou na folga (sem DSR)
  const atd = teamRows.find((t) => t.id === Number(teams.atd));
  const { isWorkDay } = require('./scales');
  for (let x = addDays(today, -14); x <= to; x = addDays(x, 1)) {
    if (!isWorkDay(atd, x)) { insLog.run(eduarda, x, '09:00', '15:00', 0, 'Cobertura na folga'); break; }
  }
  // Henrique dobrou o plantão noturno emendando no diurno
  insLog.run(henrique, addDays(today, -4), '07:00', '19:00', 60, 'Dobra de plantão');
  void carla; void isabela;
  return true;
}

module.exports = { seed };
if (require.main === module) { seed({ force: process.argv.includes('--force') }); console.log('Seed concluído.'); }
