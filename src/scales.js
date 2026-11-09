// Modelos de escala praticados no Brasil e regras de conformidade (CLT).
// Referências: CLT art. 58 (8h diárias / 44h semanais — CF art. 7º, XIII), art. 59 (máx. 2h extras/dia),
// art. 59-A (12x36), art. 66 (11h de interjornada), art. 67 (DSR — descanso semanal de 24h).

const SCALE_MODELS = {
  '5x2': {
    label: '5x2 — segunda a sexta, folga sábado e domingo',
    kind: 'weekly', workWeekdays: [1, 2, 3, 4, 5],
    dailyHours: 8.8, overtimeAllowed: true, weeklyLimit: 44, minRestHours: 11,
    legal: 'CLT art. 58: 44h semanais distribuídas em 5 dias (8h48/dia, compensando o sábado).',
  },
  '6x1': {
    label: '6x1 — seis dias de trabalho, uma folga (rotativa)',
    kind: 'cycle', workDays: 6, offDays: 1,
    dailyHours: 7.33, overtimeAllowed: true, weeklyLimit: 44, minRestHours: 11,
    legal: 'CLT art. 58 e 67: 7h20/dia, DSR de 24h consecutivas a cada 6 dias trabalhados.',
  },
  '5x1': {
    label: '5x1 — cinco dias de trabalho, uma folga (rotativa)',
    kind: 'cycle', workDays: 5, offDays: 1,
    dailyHours: 7.33, overtimeAllowed: true, weeklyLimit: 44, minRestHours: 11,
    legal: 'Comum em comércio e indústria; respeita 44h semanais e DSR.',
  },
  '4x2': {
    label: '4x2 — quatro dias de trabalho, duas folgas',
    kind: 'cycle', workDays: 4, offDays: 2,
    dailyHours: 8, overtimeAllowed: true, weeklyLimit: 44, minRestHours: 11,
    legal: 'Usual em indústria/vigilância; jornadas acima de 8h dependem de acordo coletivo.',
  },
  '6x2': {
    label: '6x2 — seis dias de trabalho, duas folgas',
    kind: 'cycle', workDays: 6, offDays: 2,
    dailyHours: 8, overtimeAllowed: true, weeklyLimit: 44, minRestHours: 11,
    legal: 'Usual em mineração e operações contínuas; média semanal abaixo de 44h.',
  },
  '12x36': {
    label: '12x36 — 12 horas de trabalho por 36 de descanso',
    kind: 'cycle', workDays: 1, offDays: 1,
    dailyHours: 12, overtimeAllowed: false, weeklyLimit: null, minRestHours: 36,
    legal: 'CLT art. 59-A: 12h seguidas por 36h ininterruptas de descanso; não comporta horas extras habituais.',
  },
  '24x48': {
    label: '24x48 — 24 horas de trabalho por 48 de descanso',
    kind: 'cycle', workDays: 1, offDays: 2,
    dailyHours: 24, overtimeAllowed: false, weeklyLimit: null, minRestHours: 48,
    legal: 'Admitida por convenção coletiva (ex.: bombeiros civis, vigilância, saúde).',
  },
};

const MAX_CONSECUTIVE_DAYS = 6; // DSR (art. 67)
const OVERTIME_DAILY_LIMIT = 2; // art. 59
const BALANCE_TOLERANCE_HOURS = 2;

// ---------- utilidades de data (UTC para evitar problemas de horário de verão) ----------
const DAY_MS = 86400000;
const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * DAY_MS));
const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);
function* eachDay(from, to) { for (let d = from; d <= to; d = addDays(d, 1)) yield d; }
const timeToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const minToTime = (m) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const isoWeekKey = (s) => {
  const d = toDate(s); const day = (d.getUTCDay() + 6) % 7; // segunda = 0
  const thursday = new Date(d.getTime() + (3 - day) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday - yearStart) / (7 * DAY_MS));
  return `${thursday.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
};

function isWorkDay(team, date) {
  const model = SCALE_MODELS[team.scale_model];
  if (!model) return false;
  if (model.kind === 'weekly') return model.workWeekdays.includes(toDate(date).getUTCDay());
  const cycle = model.workDays + model.offDays;
  const idx = ((diffDays(team.cycle_start, date) % cycle) + cycle) % cycle;
  return idx < model.workDays;
}

function shiftFor(team, date) {
  const start = timeToMin(team.shift_start);
  const end = start + Math.round(team.daily_hours * 60);
  return { start: team.shift_start, end: minToTime(end), crossesMidnight: end >= 1440 };
}

/** Gera a escala prevista de uma equipe para cada integrante. */
function buildSchedule(team, members, from, to) {
  const out = [];
  for (const date of eachDay(from, to)) {
    const work = isWorkDay(team, date);
    for (const m of members) {
      out.push({ date, user_id: m.id, user_name: m.name, team_id: team.id, team_name: team.name,
        work, ...(work ? shiftFor(team, date) : {}) });
    }
  }
  return out;
}

function logMinutes(log) {
  const start = timeToMin(log.clock_in);
  let end = timeToMin(log.clock_out);
  if (end <= start) end += 1440; // atravessa a meia-noite (ou 24h corridas)
  return Math.max(0, end - start - (log.break_minutes || 0));
}
function logInterval(log) {
  const base = toDate(log.date).getTime();
  const start = base + timeToMin(log.clock_in) * 60000;
  let endMin = timeToMin(log.clock_out);
  if (endMin <= timeToMin(log.clock_in)) endMin += 1440;
  return { start, end: base + endMin * 60000 };
}

const round = (n) => Math.round(n * 100) / 100;
const br = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('/') : d);
const h = (n) => String(round(n)).replace('.', ',') + 'h';

/**
 * Analisa a conformidade de um colaborador numa equipe/período.
 * @param team   equipe com modelo de escala
 * @param user   colaborador
 * @param logs   jornadas registradas (work_logs) no período
 * @param leaves datas de folgas aprovadas (eventos do tipo "folga")
 */
function analyzeUser(team, user, logs, leaves, from, to) {
  const model = SCALE_MODELS[team.scale_model];
  const leaveSet = new Set(leaves);
  const violations = [];

  // Horas previstas contam apenas até hoje (o restante do período ainda não aconteceu)
  const todayStr = new Date().toISOString().slice(0, 10);
  const expectedUntil = to < todayStr ? to : todayStr;
  let expected = 0;
  if (from <= expectedUntil) for (const d of eachDay(from, expectedUntil)) if (isWorkDay(team, d) && !leaveSet.has(d)) expected += team.daily_hours;

  const perDay = new Map();
  for (const l of logs) perDay.set(l.date, (perDay.get(l.date) || 0) + logMinutes(l) / 60);
  const worked = [...perDay.values()].reduce((a, b) => a + b, 0);

  // 1) Limite diário
  const dailyMax = team.daily_hours + (model.overtimeAllowed ? OVERTIME_DAILY_LIMIT : 0);
  for (const [date, hh] of perDay) {
    if (hh > dailyMax + 0.01) violations.push({ date, rule: 'jornada_diaria',
      message: `Trabalhou ${h(hh)} em ${br(date)}; limite de ${h(dailyMax)} (${model.overtimeAllowed ? 'jornada + 2h extras, art. 59' : 'sem horas extras na escala ' + team.scale_model}).` });
    if (!isWorkDay(team, date)) violations.push({ date, rule: 'trabalho_em_folga',
      message: `Trabalhou ${h(hh)} em ${br(date)}, que é dia de folga na escala ${team.scale_model}.` });
    else if (leaveSet.has(date)) violations.push({ date, rule: 'trabalho_em_folga',
      message: `Trabalhou em ${br(date)}, data com folga agendada.` });
  }

  // 2) Limite semanal (apenas escalas com teto semanal)
  if (model.weeklyLimit) {
    const weeks = new Map();
    for (const [date, hh] of perDay) { const k = isoWeekKey(date); weeks.set(k, (weeks.get(k) || 0) + hh); }
    const weeklyMax = model.weeklyLimit + (model.overtimeAllowed ? OVERTIME_DAILY_LIMIT * 5 : 0);
    for (const [week, hh] of weeks) {
      if (hh > weeklyMax + 0.01) violations.push({ date: week, rule: 'jornada_semanal',
        message: `Semana ${week}: ${h(hh)} trabalhadas; teto de ${weeklyMax}h (44h + até 10h extras).` });
    }
  }

  // 3) Intervalo mínimo entre jornadas
  const intervals = logs.map(logInterval).sort((a, b) => a.start - b.start);
  for (let i = 1; i < intervals.length; i++) {
    const rest = (intervals[i].start - intervals[i - 1].end) / 3600000;
    if (rest >= 0 && rest < model.minRestHours) {
      const date = fmt(new Date(intervals[i].start));
      violations.push({ date, rule: 'interjornada',
        message: `Descanso de apenas ${h(rest)} antes de ${br(date)}; mínimo de ${model.minRestHours}h para a escala ${team.scale_model}.` });
    }
  }

  // 4) Dias consecutivos sem DSR
  const days = [...perDay.keys()].sort();
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = diffDays(days[i - 1], days[i]) === 1 ? run + 1 : 1;
    if (run === MAX_CONSECUTIVE_DAYS + 1) violations.push({ date: days[i], rule: 'dsr',
      message: `${run} dias consecutivos de trabalho até ${br(days[i])} sem descanso semanal (art. 67).` });
  }

  const balance = worked - expected;
  let status = 'ok';
  if (violations.length || balance > BALANCE_TOLERANCE_HOURS) status = 'excedendo';
  else if (balance > 0) status = 'atencao';

  return {
    user_id: user.id, user_name: user.name, team_id: team.id, team_name: team.name,
    scale_model: team.scale_model, expected_until: from <= expectedUntil ? expectedUntil : null, expected_hours: round(expected), worked_hours: round(worked),
    balance_hours: round(balance), days_worked: perDay.size, status, violations,
  };
}

module.exports = {
  SCALE_MODELS, buildSchedule, analyzeUser, isWorkDay, logMinutes, addDays, eachDay, round,
};
