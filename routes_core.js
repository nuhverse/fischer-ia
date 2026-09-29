// Rotas do núcleo: pacientes, profissionais, especialidades, procedimentos, agenda
const { db, insert, find, get, filter, update, remove, now, today } = require('./db');
const U = require('./util');

const STAFF = ['admin', 'administrativo', 'recepcao'];

function pad(n) { return String(n).padStart(2, '0'); }
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function toHM(min) { min = ((min % 1440) + 1440) % 1440; return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }

function patientFull(p) {
  const g = p.guardian_id ? get('guardians', p.guardian_id) : null;
  const rec = find('medical_records', r => r.patient_id === p.id);
  return Object.assign({}, p, { guardian: g, record_number: p.record_number, record_status: rec ? rec.status : null });
}

module.exports = function registerCore(R) {

  // ---------- PACIENTES ----------
  R.get('/api/patients', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    let list = filter('patients');
    if (req.user.role === 'profissional') {
      const prof = find('professionals', p => p.user_id === req.user.id);
      const ids = new Set(filter('appointments', a => a.professional_id === (prof || {}).id).map(a => a.patient_id));
      list = list.filter(p => ids.has(p.id));
    }
    const q = String(req.query.q || '').toLowerCase();
    if (q) list = list.filter(p => (p.name + ' ' + p.email + ' ' + p.phone + ' ' + p.record_number).toLowerCase().includes(q));
    return U.ok(res, { patients: list.map(patientFull).sort((a, b) => a.name.localeCompare(b.name)) });
  });

  R.get('/api/patients/:id', async (req, res) => {
    const p = get('patients', req.params.id);
    if (!p) return U.fail(res, 404, 'Paciente não encontrado.');
    const me = req.user;
    if (me.role === 'paciente') { const own = find('patients', x => x.user_id === me.id); if (!own || own.id !== p.id) return U.fail(res, 403, 'Sem permissão.'); }
    else if (me.role === 'profissional') {
      const prof = find('professionals', x => x.user_id === me.id);
      const rel = find('appointments', a => a.patient_id === p.id && a.professional_id === (prof || {}).id);
      if (!rel && !U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    } else if (!U.requireRole(me, [...STAFF])) return U.fail(res, 403, 'Sem permissão.');
    U.audit(me, 'VISUALIZOU_PACIENTE', 'patients', p.id, p.id);
    const appts = filter('appointments', a => a.patient_id === p.id).sort((a, b) => (b.date + b.start_time).localeCompare(a.date + a.start_time));
    const pays = filter('payments', x => x.patient_id === p.id);
    return U.ok(res, { patient: patientFull(p), appointments: appts.map(decorateAppt), payments: pays });
  });

  R.post('/api/patients', async (req, res) => {
    if (!U.requireRole(req.user, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (name.length < 3) return U.fail(res, 422, 'Nome obrigatório.');
    const patient = insert('patients', {
      user_id: null, record_number: 'MCF-' + String(Date.now()).slice(-8),
      name, photo: String(b.photo || ''), birth_date: String(b.birth_date || ''), email: String(b.email || ''),
      phone: String(b.phone || ''), address: String(b.address || ''), gender: String(b.gender || ''),
      emergency_contact: String(b.emergency_contact || ''), guardian_id: null, notes: String(b.notes || ''), created_at: today()
    });
    if (b.guardian_name) {
      const g = insert('guardians', { patient_id: patient.id, name: String(b.guardian_name), kinship: String(b.guardian_kinship || ''), birth_date: String(b.guardian_birth || ''), phone: String(b.guardian_phone || ''), email: String(b.guardian_email || ''), document: String(b.guardian_document || ''), authorizations: String(b.guardian_authorizations || ''), consents: '', created_at: now() });
      update('patients', patient.id, { guardian_id: g.id });
    }
    if (!find('medical_records', r => r.patient_id === patient.id))
      insert('medical_records', { patient_id: patient.id, record_number: patient.record_number, created_at: now(), status: 'Ativo' });
    U.audit(req.user, 'CRIOU_PACIENTE', 'patients', patient.id, patient.id);
    return U.ok(res, { patient: patientFull(patient) });
  });

  R.put('/api/patients/:id', async (req, res) => {
    const p = get('patients', req.params.id);
    if (!p) return U.fail(res, 404, 'Paciente não encontrado.');
    const me = req.user;
    if (me.role === 'paciente') { const own = find('patients', x => x.user_id === me.id); if (!own || own.id !== p.id) return U.fail(res, 403, 'Sem permissão.'); }
    else if (!U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    const b = req.body || {};
    const old = { ...p };
    ['name','photo','birth_date','email','phone','address','gender','emergency_contact','notes'].forEach(k => { if (b[k] !== undefined) p[k] = String(b[k]); });
    update('patients', p.id, p);
    if (b.guardian_name !== undefined) {
      let g = p.guardian_id ? get('guardians', p.guardian_id) : null;
      const gd = { patient_id: p.id, name: String(b.guardian_name || ''), kinship: String(b.guardian_kinship || ''), birth_date: String(b.guardian_birth || ''), phone: String(b.guardian_phone || ''), email: String(b.guardian_email || ''), document: String(b.guardian_document || ''), authorizations: String(b.guardian_authorizations || '') };
      if (g) update('guardians', g.id, gd); else { g = insert('guardians', Object.assign(gd, { consents: '', created_at: now() })); update('patients', p.id, { guardian_id: g.id }); }
    }
    U.audit(me, 'EDITOU_PACIENTE', 'patients', p.id, p.id, old, p);
    return U.ok(res, { patient: patientFull(get('patients', p.id)) });
  });

  // ---------- ESPECIALIDADES ----------
  R.get('/api/specialties', async (req, res) => {
    let list = filter('specialties', s => s.active);
    list = list.map(s => Object.assign({}, s, { professionals: filter('professional_specialties', x => x.specialty_id === s.id).length }));
    return U.ok(res, { specialties: list });
  });
  R.post('/api/specialties', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    if (!String(b.name || '').trim()) return U.fail(res, 422, 'Nome obrigatório.');
    const s = insert('specialties', { name: String(b.name).trim(), description: String(b.description || ''), default_value: num(b.default_value), default_duration: num(b.default_duration) || 30, form_id: null, active: true, created_at: now() });
    U.audit(req.user, 'CRIOU_ESPECIALIDADE', 'specialties', s.id);
    return U.ok(res, { specialty: s });
  });
  R.put('/api/specialties/:id', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const s = get('specialties', req.params.id); if (!s) return U.fail(res, 404, 'Não encontrada.');
    const b = req.body || {}; const old = { ...s };
    ['name','description'].forEach(k => { if (b[k] !== undefined) s[k] = String(b[k]); });
    if (b.default_value !== undefined) s.default_value = num(b.default_value);
    if (b.default_duration !== undefined) s.default_duration = num(b.default_duration);
    if (b.active !== undefined) s.active = !!b.active;
    update('specialties', s.id, s);
    U.audit(req.user, 'EDITOU_ESPECIALIDADE', 'specialties', s.id, null, old, s);
    return U.ok(res, { specialty: s });
  });

  // ---------- PROCEDIMENTOS ----------
  R.get('/api/procedures', async (req, res) => {
    const list = filter('procedures', p => p.active || U.requireRole(req.user, ['admin']));
    return U.ok(res, { procedures: list.map(p => Object.assign({}, p, { specialty_name: (get('specialties', p.specialty_id) || {}).name || '' })) });
  });
  R.post('/api/procedures', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    if (!String(b.name || '').trim()) return U.fail(res, 422, 'Nome obrigatório.');
    const p = insert('procedures', { name: String(b.name).trim(), code: String(b.code || ''), category: String(b.category || ''), specialty_id: num(b.specialty_id) || null, sector: String(b.sector || ''), description: String(b.description || ''), value: num(b.value), duration: num(b.duration) || 30, preparation: String(b.preparation || ''), needs_order: !!b.needs_order, needs_payment: b.needs_payment !== false, needs_consent: !!b.needs_consent, active: true, created_at: now() });
    U.audit(req.user, 'CRIOU_PROCEDIMENTO', 'procedures', p.id);
    return U.ok(res, { procedure: p });
  });
  R.put('/api/procedures/:id', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const p = get('procedures', req.params.id); if (!p) return U.fail(res, 404, 'Não encontrado.');
    const b = req.body || {}; const old = { ...p };
    ['name','code','category','sector','description','preparation'].forEach(k => { if (b[k] !== undefined) p[k] = String(b[k]); });
    ['value','duration','specialty_id'].forEach(k => { if (b[k] !== undefined) p[k] = num(b[k]); });
    ['needs_order','needs_payment','needs_consent','active'].forEach(k => { if (b[k] !== undefined) p[k] = !!b[k]; });
    update('procedures', p.id, p);
    U.audit(req.user, 'EDITOU_PROCEDIMENTO', 'procedures', p.id, null, old, p);
    return U.ok(res, { procedure: p });
  });

  // ---------- PROFISSIONAIS ----------
  R.get('/api/professionals', async (req, res) => {
    let list = filter('professionals');
    const q = String(req.query.q || '').toLowerCase();
    if (q) list = list.filter(p => (p.name + p.email + p.registry_number).toLowerCase().includes(q));
    if (req.query.specialty_id) list = list.filter(p => p.specialty_id === Number(req.query.specialty_id) || find('professional_specialties', x => x.professional_id === p.id && x.specialty_id === Number(req.query.specialty_id)));
    return U.ok(res, { professionals: list.map(profFull) });
  });
  R.get('/api/professionals/:id', async (req, res) => {
    const p = get('professionals', req.params.id);
    if (!p) return U.fail(res, 404, 'Profissional não encontrado.');
    return U.ok(res, { professional: profFull(p, true) });
  });
  R.post('/api/professionals', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    if (name.length < 3) return U.fail(res, 422, 'Nome obrigatório.');
    if (!email) return U.fail(res, 422, 'E-mail obrigatório.');
    if (find('users', u => u.email.toLowerCase() === email)) return U.fail(res, 409, 'E-mail já cadastrado.');
    const u = insert('users', { email, password_hash: null, name, role: 'profissional', status: 'active', phone: String(b.phone || ''), birth_date: '', photo: '', must_set_password: true, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });
    const prof = insert('professionals', {
      user_id: u.id, name, photo: String(b.photo || ''), email, phone: String(b.phone || ''),
      profession: String(b.profession || ''), specialty_id: num(b.specialty_id) || null, subspecialty: String(b.subspecialty || ''),
      registry_number: String(b.registry_number || ''), council: String(b.council || ''), bio: String(b.bio || ''),
      consultation_duration: num(b.consultation_duration) || 30, value: num(b.value), status: 'Ativo', created_at: now()
    });
    if (prof.specialty_id) insert('professional_specialties', { professional_id: prof.id, specialty_id: prof.specialty_id, created_at: now() });
    U.audit(req.user, 'CRIOU_PROFISSIONAL', 'professionals', prof.id);
    U.notify(u.id, 'Bem-vindo(a) ao Fischer IA', 'Seu cadastro de profissional foi criado. Use "Primeiro acesso" para definir sua senha.', 'conta', prof.id);
    return U.ok(res, { professional: profFull(prof, true) });
  });
  R.put('/api/professionals/:id', async (req, res) => {
    const p = get('professionals', req.params.id);
    if (!p) return U.fail(res, 404, 'Não encontrado.');
    const isSelf = req.user.role === 'profissional' && p.user_id === req.user.id;
    if (!U.requireRole(req.user, ['admin']) && !isSelf) return U.fail(res, 403, 'Sem permissão.');
    const b = req.body || {}; const old = { ...p };
    ['name','photo','phone','profession','subspecialty','registry_number','council','bio'].forEach(k => { if (b[k] !== undefined) p[k] = String(b[k]); });
    if (U.requireRole(req.user, ['admin'])) {
      ['specialty_id','consultation_duration','value'].forEach(k => { if (b[k] !== undefined) p[k] = num(b[k]); });
      if (b.status !== undefined && ['Ativo','Inativo','Férias','Afastado'].includes(b.status)) p.status = b.status;
    }
    update('professionals', p.id, p);
    U.audit(req.user, 'EDITOU_PROFISSIONAL', 'professionals', p.id, null, old, p);
    return U.ok(res, { professional: profFull(get('professionals', p.id), true) });
  });

  // ---------- AGENDA DO PROFISSIONAL ----------
  R.get('/api/professionals/:id/schedules', async (req, res) => {
    const list = filter('professional_schedules', s => s.professional_id === Number(req.params.id));
    return U.ok(res, { schedules: list });
  });
  R.post('/api/professionals/:id/schedules', async (req, res) => {
    const p = get('professionals', req.params.id);
    if (!p) return U.fail(res, 404, 'Não encontrado.');
    const isSelf = req.user.role === 'profissional' && p.user_id === req.user.id;
    if (!U.requireRole(req.user, ['admin']) && !isSelf) return U.fail(res, 403, 'Sem permissão.');
    const b = req.body || {};
    if (b.weekday === undefined || !b.start_time || !b.end_time) return U.fail(res, 422, 'Dia da semana e horários são obrigatórios.');
    const s = insert('professional_schedules', { professional_id: p.id, weekday: num(b.weekday), start_time: b.start_time, end_time: b.end_time, break_start: b.break_start || null, break_end: b.break_end || null, duration: num(b.duration) || p.consultation_duration || 30, modality: String(b.modality || 'Presencial'), location: String(b.location || 'Medical Center Fischer IA'), specialty_id: num(b.specialty_id) || p.specialty_id, created_at: now() });
    U.audit(req.user, 'CRIOU_HORARIO_AGENDA', 'professional_schedules', s.id);
    return U.ok(res, { schedule: s });
  });
  R.delete('/api/professionals/:id/schedules/:sid', async (req, res) => {
    const p = get('professionals', req.params.id);
    if (!p) return U.fail(res, 404, 'Não encontrado.');
    const isSelf = req.user.role === 'profissional' && p.user_id === req.user.id;
    if (!U.requireRole(req.user, ['admin']) && !isSelf) return U.fail(res, 403, 'Sem permissão.');
    remove('professional_schedules', req.params.sid);
    U.audit(req.user, 'REMOVEU_HORARIO_AGENDA', 'professional_schedules', req.params.sid);
    return U.ok(res, { removed: true });
  });

  // Bloqueios de agenda
  R.get('/api/professionals/:id/exceptions', async (req, res) => {
    return U.ok(res, { exceptions: filter('schedule_exceptions', e => e.professional_id === Number(req.params.id)) });
  });
  R.post('/api/professionals/:id/exceptions', async (req, res) => {
    const p = get('professionals', req.params.id);
    if (!p) return U.fail(res, 404, 'Não encontrado.');
    const isSelf = req.user.role === 'profissional' && p.user_id === req.user.id;
    if (!U.requireRole(req.user, ['admin', 'recepcao']) && !isSelf) return U.fail(res, 403, 'Sem permissão.');
    const b = req.body || {};
    if (!b.date || !b.type) return U.fail(res, 422, 'Data e tipo são obrigatórios.');
    const types = ['Férias','Ausência','Folga','Congresso','Evento','Licença','Intervalo','Bloqueio manual','Horário extraordinário'];
    if (!types.includes(b.type)) return U.fail(res, 422, 'Tipo de bloqueio inválido.');
    const e = insert('schedule_exceptions', { professional_id: p.id, date: String(b.date), end_date: String(b.end_date || b.date), start_time: b.start_time || null, end_time: b.end_time || null, type: b.type, reason: String(b.reason || ''), created_at: now() });
    U.audit(req.user, 'CRIOU_BLOQUEIO_AGENDA', 'schedule_exceptions', e.id);
    return U.ok(res, { exception: e });
  });
  R.delete('/api/professionals/:id/exceptions/:eid', async (req, res) => {
    const p = get('professionals', req.params.id);
    if (!p) return U.fail(res, 404, 'Não encontrado.');
    const isSelf = req.user.role === 'profissional' && p.user_id === req.user.id;
    if (!U.requireRole(req.user, ['admin', 'recepcao']) && !isSelf) return U.fail(res, 403, 'Sem permissão.');
    remove('schedule_exceptions', req.params.eid);
    return U.ok(res, { removed: true });
  });

  // ---------- DISPONIBILIDADE (slots) ----------
  R.get('/api/professionals/:id/availability', async (req, res) => {
    const prof = get('professionals', req.params.id);
    if (!prof) return U.fail(res, 404, 'Profissional não encontrado.');
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return U.fail(res, 422, 'Data inválida.');
    if (prof.status !== 'Ativo') return U.ok(res, { date, slots: [], reason: 'Profissional ' + prof.status.toLowerCase() + '.' });
    const weekday = new Date(date + 'T12:00:00').getDay();
    const scheds = filter('professional_schedules', s => s.professional_id === prof.id && s.weekday === weekday);
    const exps = filter('schedule_exceptions', e => e.professional_id === prof.id && e.date <= date && (e.end_date || e.date) >= date);
    const dayAppts = filter('appointments', a => a.professional_id === prof.id && a.date === date && !['CANCELADA'].includes(a.status));
    const slots = [];
    const fullDay = exps.find(e => !e.start_time && e.type !== 'Horário extraordinário');
    if (!fullDay) {
      for (const s of scheds) {
        let t = toMin(s.start_time); const end = toMin(s.end_time) <= t ? toMin(s.end_time) + 1440 : toMin(s.end_time);
        while (t + s.duration <= end) {
          const hm = toHM(t);
          const inBreak = s.break_start && s.break_end && t >= toMin(s.break_start) && t < toMin(s.break_end);
          const exBlock = exps.some(e => e.start_time && t >= toMin(e.start_time) && t < toMin(e.end_time || '23:59'));
          const taken = dayAppts.find(a => a.start_time === hm);
          if (!inBreak && !exBlock) slots.push({ time: hm, available: !taken, appointment_id: taken ? taken.id : null });
          t += s.duration;
        }
      }
    }
    for (const e of exps.filter(e => e.type === 'Horário extraordinário' && e.start_time && e.end_time)) {
      let t = toMin(e.start_time); const end = toMin(e.end_time);
      const dur = 30;
      while (t + dur <= end) {
        const hm = toHM(t);
        if (!slots.find(s => s.time === hm)) slots.push({ time: hm, available: !dayAppts.find(a => a.start_time === hm), extraordinary: true });
        t += dur;
      }
    }
    slots.sort((a, b) => a.time.localeCompare(b.time));
    return U.ok(res, { date, slots, reason: fullDay ? fullDay.type + (fullDay.reason ? ': ' + fullDay.reason : '') : null });
  });

  // ---------- AGENDA GERAL ----------
  R.get('/api/agenda', async (req, res) => {
    if (!req.user) return U.fail(res, 401, 'Não autenticado.');
    let list = filter('appointments');
    const me = req.user;
    if (me.role === 'profissional') { const pr = find('professionals', p => p.user_id === me.id); list = list.filter(a => a.professional_id === (pr || {}).id); }
    if (me.role === 'paciente') { const p = find('patients', x => x.user_id === me.id); list = list.filter(a => a.patient_id === (p || {}).id); }
    if (req.query.date) list = list.filter(a => a.date === req.query.date);
    if (req.query.from) list = list.filter(a => a.date >= req.query.from);
    if (req.query.to) list = list.filter(a => a.date <= req.query.to);
    if (req.query.professional_id) list = list.filter(a => a.professional_id === Number(req.query.professional_id));
    if (req.query.specialty_id) list = list.filter(a => a.specialty_id === Number(req.query.specialty_id));
    if (req.query.status) list = list.filter(a => a.status === req.query.status);
    list.sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
    return U.ok(res, { appointments: list.map(decorateAppt) });
  });
};

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

function profFull(p, details) {
  const spec = get('specialties', p.specialty_id);
  const out = Object.assign({}, p, {
    specialty_name: spec ? spec.name : '',
    specialties: filter('professional_specialties', x => x.professional_id === p.id).map(x => x.specialty_id)
  });
  if (details) {
    out.schedules = filter('professional_schedules', s => s.professional_id === p.id);
    out.exceptions = filter('schedule_exceptions', e => e.professional_id === p.id);
    out.user_status = p.user_id ? (get('users', p.user_id) || {}).status : null;
  }
  return out;
}

function decorateAppt(a) {
  const p = get('patients', a.patient_id);
  const prof = get('professionals', a.professional_id);
  const spec = get('specialties', a.specialty_id);
  const proc = a.procedure_id ? get('procedures', a.procedure_id) : null;
  const pay = find('payments', x => x.appointment_id === a.id);
  return Object.assign({}, a, {
    patient_name: p ? p.name : '—', patient_record: p ? p.record_number : '',
    professional_name: prof ? prof.name : '—', specialty_name: spec ? spec.name : '',
    procedure_name: proc ? proc.name : '', payment: pay || null
  });
}

module.exports.decorateAppt = decorateAppt;
