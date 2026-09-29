// ============================================================
// MEDICAL CENTER FISCHER IA — Camada de dados (JSON persistente)
// Banco relacional em arquivo, com IDs sequenciais e escrita atômica.
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const TABLES = [
  'users','sessions','patients','guardians','employees','professionals',
  'specialties','professional_specialties','procedures','professional_procedures',
  'professional_schedules','schedule_exceptions','appointments','payments',
  'medical_records','encounters','addendums','clinical_forms','triage_records',
  'prescriptions','prescription_items','exam_orders','exam_results','clinical_files',
  'ai_agents','notifications','consents','audit_logs','return_recommendations','files'
];

let db = null;

function blank() {
  const t = { meta: { seq: {} }, settings: {} };
  for (const n of TABLES) t[n] = [];
  return t;
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { console.error('DB corrompido, recriando.', e); db = blank(); }
  } else db = blank();
  for (const n of TABLES) if (!Array.isArray(db[n])) db[n] = [];
  if (!db.meta) db.meta = { seq: {} };
  if (!db.settings) db.settings = {};
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 80);
}

function nextId(table) {
  db.meta.seq[table] = (db.meta.seq[table] || 0) + 1;
  return db.meta.seq[table];
}

function insert(table, row) {
  row.id = nextId(table);
  db[table].push(row);
  save();
  return row;
}
function get(table, id) { return db[table].find(r => r.id === Number(id)) || null; }
function find(table, fn) { return db[table].find(fn) || null; }
function filter(table, fn) { return fn ? db[table].filter(fn) : db[table].slice(); }
function update(table, id, patch) {
  const r = get(table, id);
  if (r) { Object.assign(r, patch); save(); }
  return r;
}
function remove(table, id) {
  const i = db[table].findIndex(r => r.id === Number(id));
  if (i >= 0) { db[table].splice(i, 1); save(); return true; }
  return false;
}
function now() { return new Date().toISOString(); }
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// ---------- SEED ----------
const crypto = require('crypto');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function seed() {
  if (db.users.length) return;
  console.log('[Fischer IA] Semeando base inicial...');

  Object.assign(db.settings, {
    institution_name: 'Medical Center Fischer IA',
    slogan: 'Ciência | Vida | Pessoas | Sempre',
    pix_key: 'fischeria@fischer.med.br',
    pix_receiver: 'Medical Center Fischer IA',
    pix_institution: 'Conta Institucional Fischer IA',
    pix_instructions: 'Realize o pagamento através do aplicativo do seu banco e envie o comprovante abaixo.',
    operation_mode: 'SIMULACAO', // SIMULACAO | CLINICO
    consultation_default_duration: 30
  });

  // Admin Master — sem senha; definida no primeiro acesso.
  insert('users', { email: 'nuhverse@gmail.com', password_hash: null, name: 'Admin Master', role: 'admin', status: 'active', phone: '', birth_date: '', photo: '', must_set_password: true, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });

  // Equipe interna (senha definida no primeiro acesso)
  const uRec = insert('users', { email: 'recepcao@fischeria.med.br', password_hash: null, name: 'Mariana Recepção', role: 'recepcao', status: 'active', phone: '(94) 4000-0001', birth_date: '', photo: '', must_set_password: true, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });
  insert('users', { email: 'administrativo@fischeria.med.br', password_hash: null, name: 'Carlos Administrativo', role: 'administrativo', status: 'active', phone: '(94) 4000-0002', birth_date: '', photo: '', must_set_password: true, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });

  // Especialidades
  const specs = [
    ['Ginecologia e Obstetrícia', 350, 40],['Pediatria', 300, 40],['Neonatologia', 380, 40],
    ['Clínica Médica', 280, 30],['Cardiologia', 420, 40],['Neurologia', 450, 50],
    ['Cirurgia Plástica', 600, 60],['Odontologia', 250, 30],['Odontopediatria', 260, 30],
    ['Nutrição Clínica', 220, 50],['Nutrição Materno-infantil', 240, 50],['Biomedicina', 200, 30],
    ['Radiologia', 0, 30],['Anestesiologia', 0, 30],['Reprodução Humana', 700, 60],['Medicina Integrativa', 320, 60]
  ];
  const specIds = {};
  specs.forEach(([name, value, dur]) => {
    const s = insert('specialties', { name, description: '', default_value: value, default_duration: dur, form_id: null, active: true, created_at: now() });
    specIds[name] = s.id;
  });

  // Procedimentos iniciais
  const procs = [
    ['Ultrassonografia Obstétrica', 'USG-OB', 'Imagem', 'Ginecologia e Obstetrícia', 'Centro de Imagem', 380, 40, 'Jejum não necessário. Bexiga cheia até 12 semanas.', true, true, true],
    ['Ultrassonografia Morfológica', 'USG-MF', 'Imagem', 'Ginecologia e Obstetrícia', 'Centro de Imagem', 520, 50, 'Trazer exames anteriores.', true, true, true],
    ['Eletrocardiograma', 'ECG-01', 'Cardíaco', 'Cardiologia', 'Exames', 120, 15, 'Não aplicar cremes no tórax.', false, true, false],
    ['Coleta Laboratorial de Rotina', 'LAB-RT', 'Laboratório', 'Clínica Médica', 'Laboratório', 90, 15, 'Jejum de 8h quando solicitado.', false, true, false],
    ['Hemograma Completo', 'LAB-HM', 'Laboratório', 'Clínica Médica', 'Laboratório', 60, 10, 'Jejum não obrigatório.', true, true, false],
    ['Radiografia de Tórax', 'RX-TX', 'Imagem', 'Clínica Médica', 'Centro de Imagem', 150, 20, 'Retirar objetos metálicos.', true, true, false],
    ['Avaliação Nutricional Completa', 'NUT-AV', 'Consultório', 'Nutrição Clínica', 'Consultórios', 260, 60, 'Trazer exames recentes.', false, true, false],
    ['Limpeza Odontológica (Profilaxia)', 'ODO-LM', 'Odontologia', 'Odontologia', 'Odontologia', 180, 40, '', false, true, true]
  ];
  for (const [name, code, category, spec, sector, value, duration, prep, order, pay, consent] of procs) {
    insert('procedures', { name, code, category, specialty_id: specIds[spec] || null, sector, description: '', value, duration, preparation: prep, needs_order: order, needs_payment: pay, needs_consent: consent, active: true, created_at: now() });
  }

  // Profissionais (com usuários para acesso ao portal)
  const profSeed = [
    { name: 'Dra. Helena Fischer', email: 'helena.fischer@fischeria.med.br', profession: 'Médica', specialty: 'Ginecologia e Obstetrícia', registry: 'CRM-PA 12.345', council: 'CRM', value: 350, dur: 40, phone: '(94) 4000-1001', bio: 'Obstetra com dedicação à gestação humanizada e à saúde integral da mulher.', schedules: [[4,'21:00','00:00',60],[1,'08:00','12:00',40],[3,'14:00','18:00',40]] },
    { name: 'Dr. Rafael Monteiro', email: 'rafael.monteiro@fischeria.med.br', profession: 'Médico', specialty: 'Cardiologia', registry: 'CRM-PA 23.456', council: 'CRM', value: 420, dur: 40, phone: '(94) 4000-1002', bio: 'Cardiologista clínico, foco em prevenção e medicina baseada em evidências.', schedules: [[2,'08:00','12:00',40],[4,'14:00','18:00',40]] },
    { name: 'Dra. Sofia Andrade', email: 'sofia.andrade@fischeria.med.br', profession: 'Médica', specialty: 'Pediatria', registry: 'CRM-PA 34.567', council: 'CRM', value: 300, dur: 40, phone: '(94) 4000-1003', bio: 'Pediatra e neonatologista, atendimento humanizado do recém-nascido ao adolescente.', schedules: [[1,'14:00','18:00',40],[3,'08:00','12:00',40],[5,'08:00','12:00',40]] },
    { name: 'Dr. Lucas Barreto', email: 'lucas.barreto@fischeria.med.br', profession: 'Nutricionista', specialty: 'Nutrição Clínica', registry: 'CRN-PA 4.567', council: 'CRN', value: 220, dur: 50, phone: '(94) 4000-1004', bio: 'Nutricionista clínico com foco em emagrecimento saudável e nutrição materno-infantil.', schedules: [[2,'14:00','19:00',50],[5,'07:00','11:00',50]] }
  ];
  for (const p of profSeed) {
    const u = insert('users', { email: p.email, password_hash: null, name: p.name, role: 'profissional', status: 'active', phone: p.phone, birth_date: '', photo: '', must_set_password: true, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });
    const prof = insert('professionals', { user_id: u.id, name: p.name, photo: '', email: p.email, phone: p.phone, profession: p.profession, specialty_id: specIds[p.specialty], subspecialty: '', registry_number: p.registry, council: p.council, bio: p.bio, consultation_duration: p.dur, value: p.value, status: 'Ativo', created_at: now() });
    insert('professional_specialties', { professional_id: prof.id, specialty_id: specIds[p.specialty], created_at: now() });
    for (const [weekday, start, end, dur] of p.schedules) {
      insert('professional_schedules', { professional_id: prof.id, weekday, start_time: start, end_time: end, break_start: null, break_end: null, duration: dur, modality: 'Presencial', location: 'Medical Center Fischer IA', specialty_id: specIds[p.specialty], created_at: now() });
    }
  }

  // Agentes de IA
  const agents = [
    ['Fischer Lab IA', 'Laboratório', '🧪', 'Analista Laboratorial', 'Simula coletas, processamento e liberação de resultados laboratoriais com valores de referência.'],
    ['Fischer Imaging IA', 'Centro de Imagem', '🩻', 'Analista de Imagem', 'Simula agendamento, execução e laudos de exames de imagem (USG, RX, TC, RM).'],
    ['Fischer Pharma IA', 'Farmácia', '💊', 'Farmacêutico Assistente', 'Simula análise, separação e dispensação de prescrições na farmácia interna.'],
    ['Fischer Nursing IA', 'Enfermagem', '🩺', 'Enfermeiro de Triagem', 'Simula triagem, sinais vitais e preparo de pacientes para procedimentos.']
  ];
  for (const [name, dept, avatar, func, desc] of agents) {
    insert('ai_agents', { name, department: dept, avatar, function: func, description: desc, prompt: '', procedures: [], status: 'Ativo', created_at: now() });
  }

  save();
  console.log('[Fischer IA] Seed concluído.');
}

load();
seed();

module.exports = { db, save, insert, get, find, filter, update, remove, now, today, hashPassword };
