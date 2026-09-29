// Agentes de IA internos (simulação): Laboratório, Imagem, Farmácia, Enfermagem
// Gera resultados/láudos FICTÍCIOS quando MODO DE OPERAÇÃO = SIMULAÇÃO/RPG.
const { db, insert, find, get, filter, update, now } = require('./db');
const U = require('./util');

const STAFF = ['admin', 'administrativo', 'recepcao'];
const FICTICIO = 'DOCUMENTO FICTÍCIO — SIMULAÇÃO / RPG';

// PRNG determinístico por exame
function rng(seed) { let s = seed * 9301 + 49297; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
const LAB_STATUS = ['SOLICITADO','AGUARDANDO_COLETA','PACIENTE_ENCAMINHADO','COLETA_INICIADA','COLETA_REALIZADA','PROCESSAMENTO','RESULTADO','LAUDO','LIBERADO'];
const IMG_STATUS = ['SOLICITADO','AGENDADO','PAGAMENTO','LIBERADO_AGENDA','EXAME_REALIZADO','LAUDO','RESULTADO_LIBERADO'];
const PHARMA_STATUS = ['PRESCRICAO_RECEBIDA','EM_ANALISE','SEPARACAO','PRONTA','DISPENSADA'];

function agentOf(dept) { return find('ai_agents', a => a.department === dept && a.status === 'Ativo'); }
function simMode() { return db.settings.operation_mode === 'SIMULACAO'; }

module.exports = function registerAI(R) {

  // ---------- LABORATÓRIO IA: avançar pipeline ----------
  R.post('/api/ai/lab/advance', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    const agent = agentOf('Laboratório');
    if (!agent) return U.fail(res, 409, 'Fischer Lab IA está inativo.');
    const list = filter('exam_orders', x => x.type === 'lab' && x.status !== 'LIBERADO').sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 5);
    const changed = [];
    for (const x of list) {
      const i = LAB_STATUS.indexOf(x.status);
      if (i < 0) { update('exam_orders', x.id, { status: 'AGUARDANDO_COLETA' }); changed.push(x.id); continue; }
      const next = LAB_STATUS[Math.min(i + 1, LAB_STATUS.length - 1)];
      update('exam_orders', x.id, { status: next, status_at: now(), agent_name: agent.name });
      if (next === 'LIBERADO') releaseLabResult(x, agent);
      changed.push(x.id);
    }
    U.audit(req.user, 'LAB_IA_AVANCOU_PIPELINE', 'exam_orders', 0);
    return U.ok(res, { advanced: changed.length, agent: agent.name });
  });

  // ---------- CENTRO DE IMAGEM IA ----------
  R.post('/api/ai/imaging/advance', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    const agent = agentOf('Centro de Imagem');
    if (!agent) return U.fail(res, 409, 'Fischer Imaging IA está inativo.');
    const list = filter('exam_orders', x => x.type === 'imaging' && x.status !== 'RESULTADO_LIBERADO').sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 5);
    const changed = [];
    for (const x of list) {
      const i = IMG_STATUS.indexOf(x.status);
      const next = IMG_STATUS[Math.min(i < 0 ? 1 : i + 1, IMG_STATUS.length - 1)];
      update('exam_orders', x.id, { status: next, status_at: now(), agent_name: agent.name });
      if (next === 'RESULTADO_LIBERADO') releaseImagingResult(x, agent);
      changed.push(x.id);
    }
    U.audit(req.user, 'IMAGING_IA_AVANCOU_PIPELINE', 'exam_orders', 0);
    return U.ok(res, { advanced: changed.length, agent: agent.name });
  });

  // ---------- FARMÁCIA IA: avançar dispensação ----------
  R.post('/api/ai/pharma/advance', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    const agent = agentOf('Farmácia');
    if (!agent) return U.fail(res, 409, 'Fischer Pharma IA está inativo.');
    const list = filter('prescriptions', rx => rx.pharma_status && rx.pharma_status !== 'DISPENSADA').slice(0, 5);
    const changed = [];
    for (const rx of list) {
      const i = PHARMA_STATUS.indexOf(rx.pharma_status);
      const next = PHARMA_STATUS[Math.min(i + 1, PHARMA_STATUS.length - 1)];
      update('prescriptions', rx.id, { pharma_status: next, pharma_agent: agent.name, pharma_at: now() });
      if (next === 'DISPENSADA') U.notify(U.patientUserId(rx.patient_id), 'Medicamentos dispensados', 'Sua prescrição foi dispensada pela farmácia Fischer IA.', 'farmacia', rx.id);
      changed.push(rx.id);
    }
    U.audit(req.user, 'PHARMA_IA_AVANCOU_PIPELINE', 'prescriptions', 0);
    return U.ok(res, { advanced: changed.length, agent: agent.name });
  });

  // Prescrições na fila da farmácia
  R.get('/api/ai/pharma/queue', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    let list = filter('prescriptions', rx => rx.pharma_status);
    if (req.user.role === 'profissional') { const pr = find('professionals', p => p.user_id === req.user.id); list = list.filter(rx => rx.professional_id === (pr || {}).id); }
    list = list.map(rx => Object.assign({}, rx, { patient_name: (get('patients', rx.patient_id) || {}).name || '—', items: filter('prescription_items', i => i.prescription_id === rx.id) }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return U.ok(res, { queue: list });
  });

  // ---------- ENFERMAGEM IA: simular triagem ----------
  R.post('/api/ai/nursing/triage/:appointmentId', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF])) return U.fail(res, 403, 'Sem permissão.');
    if (!simMode()) return U.fail(res, 409, 'Disponível apenas no MODO SIMULAÇÃO / RPG.');
    const agent = agentOf('Enfermagem');
    if (!agent) return U.fail(res, 409, 'Fischer Nursing IA está inativo.');
    const a = get('appointments', req.params.appointmentId);
    if (!a) return U.fail(res, 404, 'Agendamento não encontrado.');
    const r = rng(a.id * 7 + 3);
    const ex = find('triage_records', t => t.appointment_id === a.id);
    const data = {
      appointment_id: a.id, patient_id: a.patient_id,
      weight: (62 + r() * 30).toFixed(1) + ' kg', height: (1.55 + r() * 0.3).toFixed(2) + ' m',
      temperature: (36.1 + r() * 1.1).toFixed(1) + ' °C', pa: (110 + Math.floor(r() * 25)) + 'x' + (70 + Math.floor(r() * 15)),
      fc: String(64 + Math.floor(r() * 26)), fr: String(14 + Math.floor(r() * 6)),
      spo2: String(96 + Math.floor(r() * 4)) + '%', pain: String(Math.floor(r() * 4)),
      notes: 'Triagem simulada por ' + agent.name + '. ' + FICTICIO,
      created_by: req.user.id, created_at: now()
    };
    let t; if (ex) { update('triage_records', ex.id, data); t = get('triage_records', ex.id); } else t = insert('triage_records', data);
    U.audit(req.user, 'NURSING_IA_TRIAGEM', 'triage_records', t.id, a.patient_id);
    U.notify(U.professionalUserId(a.professional_id), 'Triagem disponível (simulada)', `Sinais vitais de ${(get('patients', a.patient_id) || {}).name} registrados por ${agent.name}.`, 'triagem', a.id);
    return U.ok(res, { triage: t });
  });

  // Worklists consolidadas
  R.get('/api/ai/worklists', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF, 'profissional'])) return U.fail(res, 403, 'Sem permissão.');
    const lab = filter('exam_orders', x => x.type === 'lab').map(decorateExam);
    const img = filter('exam_orders', x => x.type === 'imaging').map(decorateExam);
    const agentStatus = { lab: !!agentOf('Laboratório'), imaging: !!agentOf('Centro de Imagem'), pharma: !!agentOf('Farmácia'), nursing: !!agentOf('Enfermagem') };
    return U.ok(res, { lab: lab.sort(byDate), imaging: img.sort(byDate), agents: agentStatus, mode: db.settings.operation_mode, ficticio: FICTICIO });
  });

  // Iniciar prescrição na farmácia manualmente
  R.post('/api/ai/pharma/enqueue/:rxId', async (req, res) => {
    if (!U.requireRole(req.user, [...STAFF])) return U.fail(res, 403, 'Sem permissão.');
    const rx = get('prescriptions', req.params.rxId);
    if (!rx) return U.fail(res, 404, 'Prescrição não encontrada.');
    update('prescriptions', rx.id, { pharma_status: rx.pharma_status || 'PRESCRICAO_RECEBIDA', pharma_agent: (agentOf('Farmácia') || {}).name || '' });
    return U.ok(res, { prescription: get('prescriptions', rx.id) });
  });
};

function byDate(a, b) { return b.created_at.localeCompare(a.created_at); }
function decorateExam(x) {
  return Object.assign({}, x, {
    patient_name: (get('patients', x.patient_id) || {}).name || '—',
    professional_name: (get('professionals', x.professional_id) || {}).name || '—',
    result: find('exam_results', r => r.exam_order_id === x.id) || null
  });
}

function releaseLabResult(x, agent) {
  const r = rng(x.id * 13 + 5);
  const val = (min, max, dec) => (min + r() * (max - min)).toFixed(dec == null ? 1 : dec);
  const panel = [
    { analito: 'Hemoglobina', resultado: val(11.5, 15.5), ref: '12,0 – 15,5 g/dL' },
    { analito: 'Hematócrito', resultado: val(35, 46), ref: '36 – 46 %' },
    { analito: 'Leucócitos', resultado: val(4000, 11000, 0), ref: '4.000 – 11.000 /mm³' },
    { analito: 'Plaquetas', resultado: val(150, 420, 0) + '.000', ref: '150.000 – 450.000 /mm³' },
    { analito: 'Glicose de jejum', resultado: val(70, 99, 0), ref: '70 – 99 mg/dL' },
    { analito: 'Creatinina', resultado: val(0.6, 1.2, 2), ref: '0,6 – 1,2 mg/dL' },
    { analito: 'TSH', resultado: val(0.5, 4.5, 2), ref: '0,5 – 4,5 mUI/L' }
  ];
  const content = {
    material: 'Sangue venoso (EDTA + soro)',
    coleta: now().replace('T', ' ').slice(0, 16),
    procedimento: 'Coleta por punção venosa periférica, sem intercorrências.',
    itens: panel,
    observacoes: 'Amostra íntegra, sem hemólise.',
    laudo: 'Resultados dentro dos intervalos de referência para o perfil avaliado. Correlação clínica recomendada.',
    responsavel: agent.name,
    aviso: FICTICIO
  };
  insert('exam_results', { exam_order_id: x.id, patient_id: x.patient_id, content, file: null, fictitious: true, released_by: agent.name, released_at: now() });
  U.notify(U.patientUserId(x.patient_id), 'Resultado de exame disponível', `${x.name}: resultado liberado (${agent.name}). Documento de simulação.`, 'resultado', x.id);
  const prof = get('professionals', x.professional_id);
  if (prof && prof.user_id) U.notify(prof.user_id, 'Resultado laboratorial liberado', `${x.name} de ${(get('patients', x.patient_id) || {}).name} disponível.`, 'resultado', x.id);
}

function releaseImagingResult(x, agent) {
  const content = {
    tecnica: x.name + ' — técnica habitual, sem intercorrências.',
    achados: 'Estruturas avaliadas dentro dos padrões da normalidade para a faixa etária. Sem sinais de alterações agudas no presente estudo.',
    impressao: 'Exame dentro dos limites da normalidade simulada.',
    recomendacao: 'Correlacionar com quadro clínico e exames complementares, se necessário.',
    responsavel: agent.name,
    aviso: FICTICIO
  };
  insert('exam_results', { exam_order_id: x.id, patient_id: x.patient_id, content, file: null, fictitious: true, released_by: agent.name, released_at: now() });
  U.notify(U.patientUserId(x.patient_id), 'Laudo disponível', `${x.name}: laudo liberado (documento de simulação).`, 'resultado', x.id);
}
module.exports.FICTICIO = FICTICIO;
