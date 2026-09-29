// Rotas de agendamento + pagamento manual PIX (100% manual, sem integração bancária)
const { db, insert, find, get, filter, update, now, today } = require('./db');
const U = require('./util');
const { decorateAppt } = require('./routes_core');

const STAFF = ['admin', 'administrativo', 'recepcao'];
const CLOSED = ['FINALIZADA', 'CANCELADA', 'NAO_COMPARECEU'];

module.exports = function registerBooking(R) {

  // ---------- CRIAR AGENDAMENTO ----------
  R.post('/api/appointments', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const b = req.body || {};
    let patientId = Number(b.patient_id) || null;
    if (me.role === 'paciente') {
      const own = find('patients', p => p.user_id === me.id);
      if (!own) return U.fail(res, 404, 'Paciente não localizado.');
      patientId = own.id;
    } else if (!U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    if (!patientId || !get('patients', patientId)) return U.fail(res, 422, 'Paciente inválido.');

    const date = String(b.date || ''); const time = String(b.start_time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return U.fail(res, 422, 'Data inválida.');
    if (!/^\d{2}:\d{2}$/.test(time)) return U.fail(res, 422, 'Horário inválido.');
    if (date < today()) return U.fail(res, 422, 'Não é possível agendar em data passada.');

    const isProcedure = !!b.procedure_id;
    const proc = isProcedure ? get('procedures', b.procedure_id) : null;
    const prof = get('professionals', b.professional_id);
    if (!prof || prof.status !== 'Ativo') return U.fail(res, 422, 'Profissional indisponível.');
    const spec = get('specialties', b.specialty_id || prof.specialty_id);
    if (isProcedure && !proc) return U.fail(res, 422, 'Procedimento inválido.');

    // Duração e valor
    const duration = isProcedure ? (proc.duration || 30) : (prof.consultation_duration || (spec ? spec.default_duration : 30) || 30);
    const value = isProcedure ? (proc.value || 0) : (prof.value || (spec ? spec.default_value : 0) || 0);
    const endMin = toMin(time) + duration;
    const end_time = toHM(endMin);

    // Verifica conflito (exceto encaixe autorizado)
    const fit = !!b.fit && U.requireRole(me, ['admin', 'recepcao', 'profissional', 'administrativo']);
    const clash = find('appointments', a => a.professional_id === prof.id && a.date === date && a.start_time === time && a.status !== 'CANCELADA');
    if (clash && !fit) return U.fail(res, 409, 'Este horário acabou de ser ocupado.');

    // Se não for encaixe, o horário precisa estar na grade do profissional
    if (!fit) {
      const weekday = new Date(date + 'T12:00:00').getDay();
      const scheds = filter('professional_schedules', s => s.professional_id === prof.id && s.weekday === weekday);
      const exps = filter('schedule_exceptions', e => e.professional_id === prof.id && e.date <= date && (e.end_date || e.date) >= date);
      const inside = scheds.some(s => {
        const st = toMin(s.start_time); let en = toMin(s.end_time); if (en <= st) en += 1440;
        return toMin(time) >= st && endMin <= en + 0 && !(s.break_start && s.break_end && toMin(time) >= toMin(s.break_start) && toMin(time) < toMin(s.break_end));
      }) || exps.some(e => e.type === 'Horário extraordinário' && e.start_time && toMin(time) >= toMin(e.start_time) && endMin <= toMin(e.end_time));
      const blocked = exps.some(e => !e.start_time || (e.start_time && toMin(time) >= toMin(e.start_time) && toMin(time) < toMin(e.end_time || '23:59')));
      if (blocked) return U.fail(res, 409, 'Horário bloqueado na agenda do profissional.');
      if (!inside) return U.fail(res, 422, 'Horário fora da grade de atendimento do profissional.');
    }

    const needsPayment = isProcedure ? proc.needs_payment !== false : value > 0;
    const appt = insert('appointments', {
      patient_id: patientId, professional_id: prof.id, specialty_id: spec ? spec.id : null,
      procedure_id: proc ? proc.id : null, date, start_time: time, end_time,
      type: isProcedure ? 'procedimento' : (b.type === 'retorno' ? 'retorno' : 'consulta'),
      status: needsPayment ? 'AGUARDANDO_COMPROVANTE' : 'LIBERADA',
      value, notes: String(b.notes || ''), is_fit: fit, created_by: me.id, created_at: now(), checked_in_at: null
    });

    let payment = null;
    if (needsPayment) {
      payment = insert('payments', {
        appointment_id: appt.id, patient_id: patientId, amount: value, payment_method: 'PIX_MANUAL',
        pix_key_shown: db.settings.pix_key, status: 'WAITING_RECEIPT', receipt_file: null, receipt_uploaded_at: null,
        reviewed_by: null, reviewed_at: null, rejection_reason: null, created_at: now()
      });
    }

    // Garante prontuário principal (um por paciente)
    if (!find('medical_records', r => r.patient_id === patientId)) {
      const p = get('patients', patientId);
      insert('medical_records', { patient_id: patientId, record_number: p.record_number, created_at: now(), status: 'Ativo' });
    }

    U.audit(me, 'CRIOU_AGENDAMENTO', 'appointments', appt.id, patientId, null, appt);
    const pUser = U.patientUserId(patientId);
    U.notify(pUser, isProcedure ? 'Procedimento agendado' : 'Consulta agendada',
      `${spec ? spec.name : proc.name} com ${prof.name} em ${brDate(date)} às ${time}. ${needsPayment ? 'Envie o comprovante PIX para liberar.' : ''}`, 'agendamento', appt.id);
    U.notify(U.professionalUserId(prof.id), 'Novo agendamento', `${(get('patients', patientId) || {}).name} — ${brDate(date)} ${time}${fit ? ' (encaixe autorizado)' : ''}.`, 'agendamento', appt.id);

    return U.ok(res, { appointment: decorateAppt(appt), payment });
  });

  // ---------- AÇÕES SOBRE AGENDAMENTO ----------
  R.get('/api/appointments/:id', async (req, res) => {
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Agendamento não encontrado.');
    if (!canSeeAppt(req.user, a)) return U.fail(res, 403, 'Sem permissão.');
    const triage = find('triage_records', t => t.appointment_id === a.id);
    const enc = find('encounters', e => e.appointment_id === a.id);
    return U.ok(res, { appointment: decorateAppt(a), triage: triage || null, encounter_id: enc ? enc.id : null });
  });

  R.post('/api/appointments/:id/cancel', async (req, res) => {
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Não encontrado.');
    if (!canSeeAppt(req.user, a)) return U.fail(res, 403, 'Sem permissão.');
    if (CLOSED.includes(a.status)) return U.fail(res, 422, 'Este agendamento já foi encerrado.');
    const old = { status: a.status };
    update('appointments', a.id, { status: 'CANCELADA' });
    const pay = find('payments', p => p.appointment_id === a.id && !['APPROVED', 'REFUNDED'].includes(p.status));
    if (pay) update('payments', pay.id, { status: 'REFUNDED' });
    U.audit(req.user, 'CANCELOU_AGENDAMENTO', 'appointments', a.id, a.patient_id, old, { status: 'CANCELADA', reason: (req.body || {}).reason || '' });
    U.notify(U.professionalUserId(a.professional_id), 'Agendamento cancelado', `${brDate(a.date)} ${a.start_time} foi cancelado.`, 'agendamento', a.id);
    return U.ok(res, { appointment: decorateAppt(get('appointments', a.id)) });
  });

  R.post('/api/appointments/:id/checkin', async (req, res) => {
    if (!U.requireRole(req.user, STAFF)) return U.fail(res, 403, 'Apenas recepção/administrativo.');
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Não encontrado.');
    if (!['LIBERADA', 'CONFIRMADA'].includes(a.status)) return U.fail(res, 422, 'Check-in disponível apenas para consultas liberadas.');
    update('appointments', a.id, { status: 'CHECKIN', checked_in_at: now() });
    U.audit(req.user, 'CHECKIN', 'appointments', a.id, a.patient_id);
    U.notify(U.professionalUserId(a.professional_id), 'Check-in realizado', `${(get('patients', a.patient_id) || {}).name} realizou check-in (${a.start_time}).`, 'checkin', a.id);
    return U.ok(res, { appointment: decorateAppt(get('appointments', a.id)) });
  });

  R.post('/api/appointments/:id/no-show', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Não encontrado.');
    update('appointments', a.id, { status: 'NAO_COMPARECEU' });
    U.audit(req.user, 'NAO_COMPARECEU', 'appointments', a.id, a.patient_id);
    return U.ok(res, { appointment: decorateAppt(get('appointments', a.id)) });
  });

  // Reagendar: marca anterior como REAGENDADA e cria novo
  R.post('/api/appointments/:id/reschedule', async (req, res) => {
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Não encontrado.');
    if (!canSeeAppt(req.user, a)) return U.fail(res, 403, 'Sem permissão.');
    if (CLOSED.includes(a.status)) return U.fail(res, 422, 'Não é possível reagendar.');
    const b = req.body || {};
    const date = String(b.date || ''), time = String(b.start_time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return U.fail(res, 422, 'Data/horário inválidos.');
    const clash = find('appointments', x => x.professional_id === a.professional_id && x.date === date && x.start_time === time && x.status !== 'CANCELADA');
    if (clash) return U.fail(res, 409, 'Este horário acabou de ser ocupado.');
    update('appointments', a.id, { status: 'REAGENDADA' });
    const pay0 = find('payments', p => p.appointment_id === a.id);
    const na = insert('appointments', { patient_id: a.patient_id, professional_id: a.professional_id, specialty_id: a.specialty_id, procedure_id: a.procedure_id, date, start_time: time, end_time: toHM(toMin(time) + 30), type: a.type, status: pay0 && pay0.status === 'APPROVED' ? 'LIBERADA' : a.status === 'CHECKIN' ? 'LIBERADA' : 'AGUARDANDO_COMPROVANTE', value: a.value, notes: a.notes, is_fit: false, created_by: req.user.id, created_at: now(), checked_in_at: null });
    if (pay0 && pay0.status === 'APPROVED') insert('payments', { appointment_id: na.id, patient_id: a.patient_id, amount: pay0.amount, payment_method: 'PIX_MANUAL', pix_key_shown: pay0.pix_key_shown, status: 'APPROVED', receipt_file: pay0.receipt_file, receipt_uploaded_at: pay0.receipt_uploaded_at, reviewed_by: req.user.id, reviewed_at: now(), rejection_reason: null, created_at: now() });
    U.audit(req.user, 'REAGENDOU', 'appointments', a.id, a.patient_id, { date: a.date, start_time: a.start_time }, { date, start_time: time });
    return U.ok(res, { appointment: decorateAppt(na) });
  });

  // ---------- PAGAMENTOS (PIX MANUAL) ----------
  R.get('/api/payments', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    let list = filter('payments');
    if (me.role === 'paciente') { const p = find('patients', x => x.user_id === me.id); list = list.filter(x => x.patient_id === (p || {}).id); }
    else if (!U.requireRole(me, ['admin', 'administrativo', 'recepcao'])) return U.fail(res, 403, 'Sem permissão.');
    if (req.query.status) list = list.filter(x => x.status === req.query.status);
    list = list.map(x => {
      const a = get('appointments', x.appointment_id) || {};
      return Object.assign({}, x, { appointment: decorateAppt(a.id ? a : { id: x.appointment_id, patient_id: x.patient_id }) });
    }).sort((x, y) => y.created_at.localeCompare(x.created_at));
    return U.ok(res, { payments: list });
  });

  R.get('/api/payments/:id', async (req, res) => {
    const pay = get('payments', req.params.id);
    if (!pay) return U.fail(res, 404, 'Não encontrado.');
    const a = get('appointments', pay.appointment_id);
    if (!canSeeAppt(req.user, a)) return U.fail(res, 403, 'Sem permissão.');
    return U.ok(res, { payment: pay, pix: { key: db.settings.pix_key, receiver: db.settings.pix_receiver, institution: db.settings.pix_institution, instructions: db.settings.pix_instructions }, appointment: a ? decorateAppt(a) : null });
  });

  // Envio do comprovante (upload base64)
  R.post('/api/payments/:id/receipt', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const pay = get('payments', req.params.id);
    if (!pay) return U.fail(res, 404, 'Pagamento não encontrado.');
    const a = get('appointments', pay.appointment_id);
    if (!canSeeAppt(me, a)) return U.fail(res, 403, 'Sem permissão.');
    if (['APPROVED', 'EXEMPT'].includes(pay.status)) return U.fail(res, 422, 'Este pagamento já foi aprovado.');
    let frec;
    try { frec = U.saveUpload(me, req.body || {}, 'comprovante', pay.patient_id); }
    catch (e) { return U.fail(res, 422, e.message || 'Arquivo inválido.'); }
    update('payments', pay.id, { receipt_file: frec.stored_name, receipt_uploaded_at: now(), status: 'UNDER_REVIEW', rejection_reason: null });
    if (a) update('appointments', a.id, { status: 'AGUARDANDO_LIBERACAO' });
    U.audit(me, 'ENVIOU_COMPROVANTE', 'payments', pay.id, pay.patient_id);
    U.notifyRole('administrativo', 'Comprovante recebido', `${(get('patients', pay.patient_id) || {}).name} enviou comprovante (R$ ${money(pay.amount)}). Análise pendente.`, 'pagamento', pay.id);
    U.notifyRole('admin', 'Comprovante recebido', `${(get('patients', pay.patient_id) || {}).name} enviou comprovante (R$ ${money(pay.amount)}).`, 'pagamento', pay.id);
    return U.ok(res, { payment: get('payments', pay.id), message: 'Comprovante enviado com sucesso. Aguardando análise administrativa.' });
  });

  // Aprovar pagamento
  R.post('/api/payments/:id/approve', async (req, res) => {
    if (!U.requireRole(req.user, ['admin', 'administrativo'])) return U.fail(res, 403, 'Apenas administrativo.');
    const pay = get('payments', req.params.id);
    if (!pay) return U.fail(res, 404, 'Não encontrado.');
    if (pay.status === 'APPROVED') return U.fail(res, 422, 'Já aprovado.');
    const old = { status: pay.status };
    update('payments', pay.id, { status: 'APPROVED', reviewed_by: req.user.id, reviewed_at: now(), rejection_reason: null });
    const a = get('appointments', pay.appointment_id);
    if (a && !['CANCELADA', 'FINALIZADA'].includes(a.status)) update('appointments', a.id, { status: 'LIBERADA' });
    U.audit(req.user, 'APROVOU_PAGAMENTO', 'payments', pay.id, pay.patient_id, old, { status: 'APPROVED' });
    U.notify(U.patientUserId(pay.patient_id), 'Pagamento aprovado', 'Seu pagamento foi aprovado e sua consulta está liberada.', 'pagamento', pay.id);
    if (a) U.notify(U.professionalUserId(a.professional_id), 'Consulta liberada para atendimento', `${(get('patients', a.patient_id) || {}).name} — ${brDate(a.date)} ${a.start_time} liberada.`, 'atendimento', a.id);
    return U.ok(res, { payment: get('payments', pay.id), appointment: a ? decorateAppt(get('appointments', a.id)) : null, message: 'Pagamento aprovado. Consulta liberada.' });
  });

  // Recusar pagamento
  R.post('/api/payments/:id/reject', async (req, res) => {
    if (!U.requireRole(req.user, ['admin', 'administrativo'])) return U.fail(res, 403, 'Apenas administrativo.');
    const pay = get('payments', req.params.id);
    if (!pay) return U.fail(res, 404, 'Não encontrado.');
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 3) return U.fail(res, 422, 'Informe o motivo da recusa.');
    update('payments', pay.id, { status: 'REJECTED', reviewed_by: req.user.id, reviewed_at: now(), rejection_reason: reason });
    const a = get('appointments', pay.appointment_id);
    if (a && !['CANCELADA', 'FINALIZADA'].includes(a.status)) update('appointments', a.id, { status: 'AGUARDANDO_COMPROVANTE' });
    U.audit(req.user, 'RECUSOU_PAGAMENTO', 'payments', pay.id, pay.patient_id, null, { reason });
    U.notify(U.patientUserId(pay.patient_id), 'Comprovante recusado', `Motivo: ${reason}. Envie um novo comprovante.`, 'pagamento', pay.id);
    return U.ok(res, { payment: get('payments', pay.id), message: 'Pagamento recusado.' });
  });

  // Isentar pagamento (cortesia)
  R.post('/api/payments/:id/exempt', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const pay = get('payments', req.params.id);
    if (!pay) return U.fail(res, 404, 'Não encontrado.');
    update('payments', pay.id, { status: 'EXEMPT', reviewed_by: req.user.id, reviewed_at: now() });
    const a = get('appointments', pay.appointment_id);
    if (a && !['CANCELADA', 'FINALIZADA'].includes(a.status)) update('appointments', a.id, { status: 'LIBERADA' });
    U.audit(req.user, 'ISENTOU_PAGAMENTO', 'payments', pay.id, pay.patient_id);
    U.notify(U.patientUserId(pay.patient_id), 'Pagamento isento', 'Sua consulta foi liberada por cortesia.', 'pagamento', pay.id);
    return U.ok(res, { payment: get('payments', pay.id) });
  });

  // Configurações do PIX (Admin)
  R.put('/api/settings/pix', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    const old = { ...db.settings };
    if (b.pix_key !== undefined) db.settings.pix_key = String(b.pix_key);
    if (b.pix_receiver !== undefined) db.settings.pix_receiver = String(b.pix_receiver);
    if (b.pix_institution !== undefined) db.settings.pix_institution = String(b.pix_institution);
    if (b.pix_instructions !== undefined) db.settings.pix_instructions = String(b.pix_instructions);
    require('./db').save();
    U.audit(req.user, 'CONFIGUROU_PIX', 'settings', 0, null, { pix_key: old.pix_key }, { pix_key: db.settings.pix_key });
    return U.ok(res, { settings: publicSettings() });
  });

  R.get('/api/settings', async (req, res) => {
    return U.ok(res, { settings: publicSettings() });
  });

  // TRIAGEM
  R.post('/api/appointments/:id/triage', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    if (!U.requireRole(me, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Não encontrado.');
    const b = req.body || {};
    const ex = find('triage_records', t => t.appointment_id === a.id);
    const data = { appointment_id: a.id, patient_id: a.patient_id, weight: str(b.weight), height: str(b.height), temperature: str(b.temperature), pa: str(b.pa), fc: str(b.fc), fr: str(b.fr), spo2: str(b.spo2), pain: str(b.pain), notes: str(b.notes), created_by: me.id, created_at: now() };
    let t;
    if (ex) { update('triage_records', ex.id, data); t = get('triage_records', ex.id); }
    else t = insert('triage_records', data);
    U.audit(me, 'TRIAGEM', 'triage_records', t.id, a.patient_id);
    U.notify(U.professionalUserId(a.professional_id), 'Triagem registrada', `Sinais vitais de ${(get('patients', a.patient_id) || {}).name} disponíveis.`, 'triagem', a.id);
    return U.ok(res, { triage: t });
  });
};

function publicSettings() {
  const s = db.settings;
  return { institution_name: s.institution_name, slogan: s.slogan, pix_key: s.pix_key, pix_receiver: s.pix_receiver, pix_institution: s.pix_institution, pix_instructions: s.pix_instructions, operation_mode: s.operation_mode };
}
module.exports.publicSettings = publicSettings;

function canSeeAppt(me, a) {
  if (!me || !a || !a.id) return false;
  if (U.requireRole(me, STAFF)) return true;
  if (me.role === 'paciente') { const p = find('patients', x => x.user_id === me.id); return p && a.patient_id === p.id; }
  if (me.role === 'profissional') { const pr = find('professionals', x => x.user_id === me.id); return pr && a.professional_id === pr.id; }
  return false;
}
module.exports.canSeeAppt = canSeeAppt;

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function toHM(min) { min = ((min % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function brDate(d) { const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; }
function money(v) { return Number(v || 0).toFixed(2).replace('.', ','); }
function str(v) { return String(v == null ? '' : v); }
