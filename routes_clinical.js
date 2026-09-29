// Rotas clínicas: prontuário, atendimentos, formulários, prescrições, exames, arquivos
const { db, insert, find, get, filter, update, remove, now } = require('./db');
const U = require('./util');
const { decorateAppt } = require('./routes_core');

const STAFF = ['admin', 'administrativo', 'recepcao'];

function canSeeRecord(me, patientId) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  if (me.role === 'paciente') { const p = find('patients', x => x.user_id === me.id); return p && p.id === patientId; }
  if (me.role === 'profissional') {
    const pr = find('professionals', x => x.user_id === me.id);
    if (!pr) return false;
    return !!find('appointments', a => a.patient_id === patientId && a.professional_id === pr.id);
  }
  return false; // administrativo/recepção: sem acesso clínico irrestrito
}
function selfProfessional(me) { return me && me.role === 'profissional' ? find('professionals', x => x.user_id === me.id) : null; }

module.exports = function registerClinical(R) {

  // ---------- INICIAR ATENDIMENTO ----------
  R.post('/api/appointments/:id/start', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const a = get('appointments', req.params.id);
    if (!a) return U.fail(res, 404, 'Agendamento não encontrado.');
    const pr = selfProfessional(me);
    const isAdmin = U.requireRole(me, ['admin']);
    if (!isAdmin && (!pr || pr.id !== a.professional_id)) return U.fail(res, 403, 'Apenas o profissional responsável.');
    if (!['LIBERADA', 'CHECKIN', 'CONFIRMADA'].includes(a.status))
      return U.fail(res, 422, 'Atendimento bloqueado: a consulta precisa estar LIBERADA (pagamento aprovado ou isento).');

    let enc = find('encounters', e => e.appointment_id === a.id);
    if (!enc) {
      let rec = find('medical_records', r => r.patient_id === a.patient_id);
      if (!rec) {
        const p = get('patients', a.patient_id);
        rec = insert('medical_records', { patient_id: a.patient_id, record_number: p.record_number, created_at: now(), status: 'Ativo' });
      }
      enc = insert('encounters', {
        medical_record_id: rec.id, appointment_id: a.id, professional_id: a.professional_id, specialty_id: a.specialty_id,
        started_at: now(), ended_at: null, status: 'EM_ANDAMENTO', summary: '', data: {}, created_at: now(), saved_at: now()
      });
    }
    update('appointments', a.id, { status: 'EM_ATENDIMENTO' });
    U.audit(me, 'INICIOU_ATENDIMENTO', 'encounters', enc.id, a.patient_id);
    return U.ok(res, { encounter: enc, appointment: decorateAppt(get('appointments', a.id)) });
  });

  // ---------- ENCOUNTER: leitura ----------
  R.get('/api/encounters/:id', async (req, res) => {
    const enc = get('encounters', req.params.id);
    if (!enc) return U.fail(res, 404, 'Atendimento não encontrado.');
    const rec = get('medical_records', enc.medical_record_id);
    if (!canSeeRecord(req.user, rec.patient_id)) return U.fail(res, 403, 'Sem permissão para acessar este conteúdo.');
    U.audit(req.user, 'VISUALIZOU_ATENDIMENTO', 'encounters', enc.id, rec.patient_id);
    return U.ok(res, buildEncounter(enc));
  });

  // ---------- ENCOUNTER: autosave ----------
  R.put('/api/encounters/:id', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const enc = get('encounters', req.params.id);
    if (!enc) return U.fail(res, 404, 'Não encontrado.');
    if (enc.status === 'FINALIZADO') return U.fail(res, 423, 'Atendimento finalizado. Use adendo ao prontuário.');
    const rec = get('medical_records', enc.medical_record_id);
    const pr = selfProfessional(me);
    if (!U.requireRole(me, ['admin']) && (!pr || pr.id !== enc.professional_id)) return U.fail(res, 403, 'Apenas o profissional responsável.');
    const b = req.body || {};
    const data = Object.assign({}, enc.data || {});
    if (b.data && typeof b.data === 'object') Object.assign(data, b.data);
    if (b.summary !== undefined) enc.summary = String(b.summary).slice(0, 8000);
    update('encounters', enc.id, { data, summary: enc.summary, saved_at: now() });
    return U.ok(res, { saved_at: now().slice(11, 19), encounter: get('encounters', enc.id) });
  });

  // ---------- ENCOUNTER: finalizar ----------
  R.post('/api/encounters/:id/finalize', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const enc = get('encounters', req.params.id);
    if (!enc) return U.fail(res, 404, 'Não encontrado.');
    if (enc.status === 'FINALIZADO') return U.fail(res, 422, 'Já finalizado.');
    const rec = get('medical_records', enc.medical_record_id);
    const pr = selfProfessional(me);
    if (!U.requireRole(me, ['admin']) && (!pr || pr.id !== enc.professional_id)) return U.fail(res, 403, 'Apenas o profissional responsável.');
    const b = req.body || {};
    update('encounters', enc.id, { status: 'FINALIZADO', ended_at: now(), saved_at: now() });
    if (enc.appointment_id) update('appointments', enc.appointment_id, { status: 'FINALIZADA' });
    if (b.recommend_return && b.return_days) {
      const rr = insert('return_recommendations', { encounter_id: enc.id, patient_id: rec.patient_id, professional_id: enc.professional_id, days: Number(b.return_days), date: b.return_date || null, notes: String(b.return_notes || ''), created_at: now() });
      U.notify(U.patientUserId(rec.patient_id), 'Retorno recomendado', `Seu profissional recomendou retorno em ${rr.days} dias. Agende pelo portal.`, 'retorno', rr.id);
    }
    U.audit(me, 'FINALIZOU_ATENDIMENTO', 'encounters', enc.id, rec.patient_id);
    U.notify(U.patientUserId(rec.patient_id), 'Atendimento finalizado', 'Seu atendimento foi concluído e salvo no prontuário.', 'prontuario', enc.id);
    return U.ok(res, { encounter: get('encounters', enc.id), message: 'Consulta finalizada.' });
  });

  // ---------- ADENDO ----------
  R.post('/api/encounters/:id/addendum', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const enc = get('encounters', req.params.id);
    if (!enc) return U.fail(res, 404, 'Não encontrado.');
    if (enc.status !== 'FINALIZADO') return U.fail(res, 422, 'Adendos são para atendimentos finalizados.');
    const pr = selfProfessional(me);
    if (!U.requireRole(me, ['admin']) && (!pr || pr.id !== enc.professional_id)) return U.fail(res, 403, 'Apenas o profissional responsável.');
    const text = String((req.body || {}).text || '').trim();
    const reason = String((req.body || {}).reason || '').trim();
    if (text.length < 3) return U.fail(res, 422, 'Texto do adendo obrigatório.');
    const rec = get('medical_records', enc.medical_record_id);
    const ad = insert('addendums', { encounter_id: enc.id, professional_id: enc.professional_id, text, reason, created_at: now(), author_name: me.name });
    U.audit(me, 'ADENDO_PRONTUARIO', 'addendums', ad.id, rec.patient_id, null, { text: text.slice(0, 200) });
    return U.ok(res, { addendum: ad });
  });

  // ---------- PRONTUÁRIO LONGITUDINAL ----------
  R.get('/api/patients/:id/record', async (req, res) => {
    const p = get('patients', req.params.id);
    if (!p) return U.fail(res, 404, 'Paciente não encontrado.');
    if (!canSeeRecord(req.user, p.id)) return U.fail(res, 403, 'Sem permissão para acessar este conteúdo.');
    U.audit(req.user, 'VISUALIZOU_PRONTUARIO', 'medical_records', p.id, p.id);
    let rec = find('medical_records', r => r.patient_id === p.id);
    if (!rec) rec = insert('medical_records', { patient_id: p.id, record_number: p.record_number, created_at: now(), status: 'Ativo' });
    const encs = filter('encounters', e => e.medical_record_id === rec.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const timeline = encs.map(e => ({
      id: e.id, date: (get('appointments', e.appointment_id) || {}).date || e.created_at.slice(0, 10),
      time: (get('appointments', e.appointment_id) || {}).start_time || '',
      type: (get('specialties', e.specialty_id) || {}).name || 'Atendimento',
      professional: (get('professionals', e.professional_id) || {}).name || '—',
      status: e.status, summary: e.summary
    }));
    const prescriptions = filter('prescriptions', x => x.patient_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(rx => Object.assign({}, rx, { items: filter('prescription_items', i => i.prescription_id === rx.id), professional_name: (get('professionals', rx.professional_id) || {}).name || '' }));
    const exams = filter('exam_orders', x => x.patient_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(x => Object.assign({}, x, { result: find('exam_results', r => r.exam_order_id === x.id) || null, professional_name: (get('professionals', x.professional_id) || {}).name || '' }));
    const files = filter('clinical_files', f => f.patient_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const returns = filter('return_recommendations', r => r.patient_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return U.ok(res, { record: rec, timeline, prescriptions, exams, files, returns, patient: { id: p.id, name: p.name, record_number: p.record_number, birth_date: p.birth_date } });
  });

  // ---------- FORMULÁRIOS CLÍNICOS (construtor) ----------
  R.get('/api/clinical-forms', async (req, res) => {
    let list = filter('clinical_forms');
    if (req.query.specialty_id) list = list.filter(f => f.specialty_id === Number(req.query.specialty_id));
    return U.ok(res, { forms: list.map(f => Object.assign({}, f, { specialty_name: (get('specialties', f.specialty_id) || {}).name || 'Geral' })) });
  });
  R.post('/api/clinical-forms', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    if (!String(b.name || '').trim()) return U.fail(res, 422, 'Nome obrigatório.');
    const f = insert('clinical_forms', { name: String(b.name).trim(), specialty_id: Number(b.specialty_id) || null, fields: Array.isArray(b.fields) ? b.fields.slice(0, 80) : [], active: true, created_at: now() });
    if (f.specialty_id) update('specialties', f.specialty_id, { form_id: f.id });
    U.audit(req.user, 'CRIOU_FORMULARIO', 'clinical_forms', f.id);
    return U.ok(res, { form: f });
  });
  R.put('/api/clinical-forms/:id', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const f = get('clinical_forms', req.params.id);
    if (!f) return U.fail(res, 404, 'Não encontrado.');
    const b = req.body || {};
    if (b.name !== undefined) f.name = String(b.name);
    if (b.specialty_id !== undefined) f.specialty_id = Number(b.specialty_id) || null;
    if (Array.isArray(b.fields)) f.fields = b.fields.slice(0, 80);
    if (b.active !== undefined) f.active = !!b.active;
    update('clinical_forms', f.id, f);
    U.audit(req.user, 'EDITOU_FORMULARIO', 'clinical_forms', f.id);
    return U.ok(res, { form: f });
  });

  // ---------- PRESCRIÇÕES ----------
  R.post('/api/prescriptions', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const b = req.body || {};
    const enc = b.encounter_id ? get('encounters', b.encounter_id) : null;
    const pr = selfProfessional(me);
    if (!U.requireRole(me, ['admin']) && !pr) return U.fail(res, 403, 'Apenas profissionais.');
    const patientId = enc ? (get('medical_records', enc.medical_record_id) || {}).patient_id : Number(b.patient_id);
    if (!patientId) return U.fail(res, 422, 'Paciente inválido.');
    const type = b.type === 'photo' ? 'photo' : 'text';
    let file = null;
    if (type === 'photo') {
      if (!b.file || !b.file.data) return U.fail(res, 422, 'Anexe a foto/PDF da receita.');
      try { file = U.saveUpload(me, b.file, 'receita', patientId).stored_name; }
      catch (e) { return U.fail(res, 422, e.message); }
    }
    const rx = insert('prescriptions', { encounter_id: enc ? enc.id : null, appointment_id: enc ? enc.appointment_id : null, patient_id: patientId, professional_id: pr ? pr.id : Number(b.professional_id) || null, type, text: String(b.text || ''), file, created_at: now() });
    if (Array.isArray(b.items)) for (const it of b.items.slice(0, 40)) {
      insert('prescription_items', { prescription_id: rx.id, medication: String(it.medication || ''), presentation: String(it.presentation || ''), concentration: String(it.concentration || ''), dose: String(it.dose || ''), route: String(it.route || ''), frequency: String(it.frequency || ''), duration: String(it.duration || ''), quantity: String(it.quantity || ''), instructions: String(it.instructions || ''), notes: String(it.notes || '') });
    }
    U.audit(me, 'CRIOU_PRESCRICAO', 'prescriptions', rx.id, patientId);
    U.notify(U.patientUserId(patientId), 'Nova receita disponível', 'Uma nova prescrição foi adicionada ao seu prontuário.', 'receita', rx.id);
    // Farmácia IA entra em ação quando houver itens
    if ((b.items || []).length) maybePharma(rx.id);
    return U.ok(res, { prescription: rx });
  });
  R.get('/api/patients/:id/prescriptions', async (req, res) => {
    if (!canSeeRecord(req.user, Number(req.params.id))) return U.fail(res, 403, 'Sem permissão.');
    const list = filter('prescriptions', x => x.patient_id === Number(req.params.id)).map(rx => Object.assign({}, rx, { items: filter('prescription_items', i => i.prescription_id === rx.id) }));
    return U.ok(res, { prescriptions: list });
  });

  // ---------- EXAMES ----------
  R.post('/api/exam-orders', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const pr = selfProfessional(me);
    const b = req.body || {};
    if (!U.requireRole(me, ['admin']) && !pr && !U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    const enc = b.encounter_id ? get('encounters', b.encounter_id) : null;
    const patientId = enc ? (get('medical_records', enc.medical_record_id) || {}).patient_id : Number(b.patient_id);
    if (!patientId) return U.fail(res, 422, 'Paciente inválido.');
    const type = b.type === 'imaging' ? 'imaging' : 'lab';
    if (!String(b.name || '').trim()) return U.fail(res, 422, 'Nome do exame obrigatório.');
    const xo = insert('exam_orders', { encounter_id: enc ? enc.id : null, patient_id: patientId, professional_id: pr ? pr.id : Number(b.professional_id) || null, type, name: String(b.name).trim(), category: String(b.category || ''), indication: String(b.indication || ''), priority: String(b.priority || 'Rotina'), notes: String(b.notes || ''), status: 'SOLICITADO', external_file: null, created_at: now() });
    U.audit(me, 'SOLICITOU_EXAME', 'exam_orders', xo.id, patientId);
    U.notify(U.patientUserId(patientId), 'Novo exame solicitado', `${xo.name} foi solicitado. Acompanhe pelo portal.`, 'exame', xo.id);
    return U.ok(res, { exam: xo });
  });

  R.get('/api/exam-orders', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    let list = filter('exam_orders');
    if (me.role === 'paciente') { const p = find('patients', x => x.user_id === me.id); list = list.filter(x => x.patient_id === (p || {}).id); }
    else if (me.role === 'profissional') { const pr = selfProfessional(me); if (pr) list = list.filter(x => x.professional_id === pr.id || filter('appointments', a => a.professional_id === pr.id).some(a => a.patient_id === x.patient_id)); }
    else if (!U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    if (req.query.type) list = list.filter(x => x.type === req.query.type);
    list = list.map(x => Object.assign({}, x, { patient_name: (get('patients', x.patient_id) || {}).name || '—', professional_name: (get('professionals', x.professional_id) || {}).name || '—', result: find('exam_results', r => r.exam_order_id === x.id) || null }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return U.ok(res, { exams: list });
  });

  // Anexar exame/resultado externo (foto/PDF)
  R.post('/api/exam-orders/:id/attach', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const xo = get('exam_orders', req.params.id);
    if (!xo) return U.fail(res, 404, 'Não encontrado.');
    if (!canSeeRecord(me, xo.patient_id) && !U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    let frec;
    try { frec = U.saveUpload(me, req.body || {}, 'exame', xo.patient_id); }
    catch (e) { return U.fail(res, 422, e.message); }
    update('exam_orders', xo.id, { external_file: frec.stored_name, status: xo.status === 'SOLICITADO' ? 'RESULTADO_ANEXADO' : xo.status });
    U.audit(me, 'ANEXOU_EXAME', 'exam_orders', xo.id, xo.patient_id);
    return U.ok(res, { exam: get('exam_orders', xo.id) });
  });

  // ---------- ARQUIVO CLÍNICO ----------
  R.post('/api/clinical-files', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const b = req.body || {};
    const patientId = Number(b.patient_id);
    if (!patientId) return U.fail(res, 422, 'Paciente inválido.');
    if (!canSeeRecord(me, patientId) && !U.requireRole(me, STAFF)) return U.fail(res, 403, 'Sem permissão.');
    let frec;
    try { frec = U.saveUpload(me, b.file || {}, b.category || 'documento', patientId); }
    catch (e) { return U.fail(res, 422, e.message); }
    const cf = insert('clinical_files', { patient_id: patientId, encounter_id: Number(b.encounter_id) || null, category: String(b.category || 'documento'), description: String(b.description || ''), file: frec.stored_name, original_name: frec.original_name, uploaded_by: me.id, uploaded_by_name: me.name, created_at: now() });
    U.audit(me, 'ANEXOU_ARQUIVO_CLINICO', 'clinical_files', cf.id, patientId);
    return U.ok(res, { file: cf });
  });
};

function maybePharma(rxId) {
  const agent = find('ai_agents', a => a.department === 'Farmácia' && a.status === 'Ativo');
  if (!agent) return;
  const rx = get('prescriptions', rxId);
  const { db } = require('./db');
  if (db.settings.operation_mode !== 'SIMULACAO') return;
  update('prescriptions', rxId, { pharma_status: 'PRESCRICAO_RECEBIDA', pharma_agent: agent.name });
}

function buildEncounter(enc) {
  const rec = get('medical_records', enc.medical_record_id);
  const p = get('patients', rec.patient_id);
  const appt = enc.appointment_id ? get('appointments', enc.appointment_id) : null;
  const triage = appt ? find('triage_records', t => t.appointment_id === appt.id) : null;
  const prof = get('professionals', enc.professional_id);
  const spec = get('specialties', enc.specialty_id);
  const form = spec && spec.form_id ? get('clinical_forms', spec.form_id) : find('clinical_forms', f => f.specialty_id === enc.specialty_id && f.active);
  const history = filter('encounters', e => e.medical_record_id === rec.id && e.id !== enc.id && e.status === 'FINALIZADO')
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12)
    .map(e => ({ id: e.id, date: (get('appointments', e.appointment_id) || {}).date || e.created_at.slice(0, 10), specialty: (get('specialties', e.specialty_id) || {}).name || '', professional: (get('professionals', e.professional_id) || {}).name || '', summary: e.summary }));
  return {
    encounter: enc,
    patient: p ? { id: p.id, name: p.name, record_number: p.record_number, birth_date: p.birth_date, gender: p.gender } : null,
    appointment: appt ? decorateAppt(appt) : null,
    triage: triage || null,
    professional_name: prof ? prof.name : '', specialty_name: spec ? spec.name : '',
    form: form || null,
    addendums: filter('addendums', a => a.encounter_id === enc.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    prescriptions: filter('prescriptions', x => x.encounter_id === enc.id).map(rx => Object.assign({}, rx, { items: filter('prescription_items', i => i.prescription_id === rx.id) })),
    exams: filter('exam_orders', x => x.encounter_id === enc.id),
    files: filter('clinical_files', f => f.encounter_id === enc.id),
    history
  };
}
module.exports.buildEncounter = buildEncounter;
module.exports.canSeeRecord = canSeeRecord;
