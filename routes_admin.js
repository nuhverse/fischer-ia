// Rotas administrativas: usuários, funcionários, agentes IA, auditoria, relatórios, dashboards
const { db, save, insert, find, get, filter, update, remove, now, today } = require('./db');
const U = require('./util');

module.exports = function registerAdmin(R) {

  // ---------- USUÁRIOS ----------
  R.get('/api/admin/users', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const q = String(req.query.q || '').toLowerCase();
    let list = filter('users');
    if (q) list = list.filter(u => (u.name + u.email + u.role).toLowerCase().includes(q));
    list = list.map(u => { const { password_hash, ...r } = u; r.has_password = !!password_hash; return r; })
      .sort((a, b) => a.name.localeCompare(b.name));
    return U.ok(res, { users: list });
  });

  R.put('/api/admin/users/:id', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const u = get('users', req.params.id);
    if (!u) return U.fail(res, 404, 'Usuário não encontrado.');
    const b = req.body || {};
    const old = { status: u.status, role: u.role, name: u.name };
    if (b.name !== undefined) u.name = String(b.name);
    if (b.phone !== undefined) u.phone = String(b.phone);
    if (b.role !== undefined && ['admin','administrativo','recepcao','profissional','funcionario','paciente','responsavel','agente_ia'].includes(b.role)) u.role = b.role;
    if (b.status !== undefined && ['active','pending','blocked','inactive'].includes(b.status)) u.status = b.status;
    if (b.reset_password) { u.password_hash = null; u.must_set_password = true; u.failed_attempts = 0; u.lock_until = null; }
    update('users', u.id, u);
    U.audit(req.user, 'ADMIN_EDITOU_USUARIO', 'users', u.id, null, old, { status: u.status, role: u.role, reset_password: !!b.reset_password });
    if (b.reset_password) U.notify(u.id, 'Senha redefinida', 'Sua senha foi redefinida pela administração. Use "Primeiro acesso" para criar uma nova.', 'conta', u.id);
    const { password_hash, ...pub } = u;
    return U.ok(res, { user: pub });
  });

  // ---------- FUNCIONÁRIOS ----------
  R.get('/api/admin/employees', async (req, res) => {
    if (!U.requireRole(req.user, ['admin', 'administrativo'])) return U.fail(res, 403, 'Sem permissão.');
    const list = filter('employees').map(e => Object.assign({}, e, { user_status: (get('users', e.user_id) || {}).status || '' }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return U.ok(res, { employees: list });
  });

  R.post('/api/admin/employees/:id/review', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const e = get('employees', req.params.id);
    if (!e) return U.fail(res, 404, 'Funcionário não encontrado.');
    const action = String((req.body || {}).action || '');
    const u = get('users', e.user_id);
    if (action === 'APROVAR') {
      update('employees', e.id, { status: 'APROVADO', reviewed_by: req.user.id, reviewed_at: now() });
      if (u) update('users', u.id, { status: 'active' });
      U.notify(u.id, 'Cadastro aprovado', 'Seu acesso ao sistema Fischer IA foi aprovado. Bem-vindo(a) à equipe!', 'aprovacao', e.id);
    } else if (action === 'RECUSAR') {
      update('employees', e.id, { status: 'RECUSADO', reviewed_by: req.user.id, reviewed_at: now() });
      if (u) update('users', u.id, { status: 'inactive' });
      U.notify(u.id, 'Cadastro recusado', 'Seu cadastro de funcionário foi recusado. Contate a administração.', 'aprovacao', e.id);
    } else if (action === 'SUSPENDER') {
      update('employees', e.id, { status: 'SUSPENSO' });
      if (u) update('users', u.id, { status: 'blocked' });
    } else if (action === 'DESATIVAR') {
      update('employees', e.id, { status: 'DESATIVADO' });
      if (u) update('users', u.id, { status: 'inactive' });
    } else return U.fail(res, 422, 'Ação inválida.');
    U.audit(req.user, 'ANALISOU_FUNCIONARIO_' + action, 'employees', e.id);
    return U.ok(res, { employee: get('employees', e.id) });
  });

  // ---------- AGENTES IA ----------
  R.get('/api/ai-agents', async (req, res) => {
    if (!req.user) return U.fail(res, 401, 'Não autenticado.');
    return U.ok(res, { agents: filter('ai_agents') });
  });
  R.post('/api/ai-agents', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    if (!String(b.name || '').trim()) return U.fail(res, 422, 'Nome obrigatório.');
    const a = insert('ai_agents', { name: String(b.name).trim(), department: String(b.department || ''), avatar: String(b.avatar || '🤖'), function: String(b.function || ''), description: String(b.description || ''), prompt: String(b.prompt || ''), procedures: Array.isArray(b.procedures) ? b.procedures : [], status: 'Ativo', created_at: now() });
    U.audit(req.user, 'CRIOU_AGENTE_IA', 'ai_agents', a.id);
    return U.ok(res, { agent: a });
  });
  R.put('/api/ai-agents/:id', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const a = get('ai_agents', req.params.id);
    if (!a) return U.fail(res, 404, 'Agente não encontrado.');
    const b = req.body || {};
    ['name','department','avatar','function','description','prompt'].forEach(k => { if (b[k] !== undefined) a[k] = String(b[k]); });
    if (Array.isArray(b.procedures)) a.procedures = b.procedures;
    if (b.status !== undefined && ['Ativo', 'Inativo'].includes(b.status)) a.status = b.status;
    update('ai_agents', a.id, a);
    U.audit(req.user, 'EDITOU_AGENTE_IA', 'ai_agents', a.id);
    return U.ok(res, { agent: a });
  });
  R.delete('/api/ai-agents/:id', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    remove('ai_agents', req.params.id);
    U.audit(req.user, 'REMOVEU_AGENTE_IA', 'ai_agents', req.params.id);
    return U.ok(res, { removed: true });
  });

  // ---------- CONFIGURAÇÕES ----------
  R.put('/api/settings', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    const b = req.body || {};
    if (b.institution_name !== undefined) db.settings.institution_name = String(b.institution_name);
    if (b.slogan !== undefined) db.settings.slogan = String(b.slogan);
    if (b.operation_mode !== undefined && ['SIMULACAO', 'CLINICO'].includes(b.operation_mode)) db.settings.operation_mode = b.operation_mode;
    save();
    U.audit(req.user, 'EDITOU_CONFIGURACOES', 'settings', 0);
    return U.ok(res, { settings: require('./routes_booking').publicSettings() });
  });

  // ---------- AUDITORIA ----------
  R.get('/api/admin/audit', async (req, res) => {
    if (!U.requireRole(req.user, ['admin'])) return U.fail(res, 403, 'Apenas Admin Master.');
    let list = filter('audit_logs').sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (req.query.q) { const q = String(req.query.q).toLowerCase(); list = list.filter(l => (l.user_name + l.action + l.entity).toLowerCase().includes(q)); }
    return U.ok(res, { logs: list.slice(0, 300) });
  });

  // ---------- NOTIFICAÇÕES ----------
  R.get('/api/notifications', async (req, res) => {
    if (!req.user) return U.fail(res, 401, 'Não autenticado.');
    const list = filter('notifications', n => n.user_id === req.user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 60);
    return U.ok(res, { notifications: list, unread: list.filter(n => !n.read).length });
  });
  R.post('/api/notifications/read-all', async (req, res) => {
    if (!req.user) return U.fail(res, 401, 'Não autenticado.');
    filter('notifications', n => n.user_id === req.user.id && !n.read).forEach(n => { n.read = true; });
    save();
    return U.ok(res, { done: true });
  });

  // ---------- BUSCA GLOBAL ----------
  R.get('/api/search', async (req, res) => {
    if (!U.requireRole(req.user, ['admin', 'administrativo', 'recepcao'])) return U.fail(res, 403, 'Sem permissão.');
    const q = String(req.query.q || '').toLowerCase().trim();
    if (q.length < 2) return U.ok(res, { patients: [], professionals: [] });
    const patients = filter('patients', p => (p.name + p.email + p.phone + p.record_number).toLowerCase().includes(q)).slice(0, 8)
      .map(p => ({ id: p.id, name: p.name, record_number: p.record_number, phone: p.phone, email: p.email }));
    const professionals = filter('professionals', p => (p.name + p.email + p.registry_number).toLowerCase().includes(q)).slice(0, 8)
      .map(p => ({ id: p.id, name: p.name, registry_number: p.registry_number, email: p.email }));
    return U.ok(res, { patients, professionals });
  });

  // ---------- DASHBOARDS ----------
  R.get('/api/dashboard', async (req, res) => {
    const me = req.user; if (!me) return U.fail(res, 401, 'Não autenticado.');
    const t = today();
    if (me.role === 'paciente') {
      const p = find('patients', x => x.user_id === me.id);
      if (!p) return U.ok(res, { role: 'paciente', empty: true });
      const appts = filter('appointments', a => a.patient_id === p.id && !['CANCELADA'].includes(a.status));
      const future = appts.filter(a => a.date >= t && !['FINALIZADA', 'NAO_COMPARECEU'].includes(a.status)).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
      const next = future[0] || null;
      return U.ok(res, {
        role: 'paciente', patient: p,
        next: next ? require('./routes_core').decorateAppt(next) : null,
        upcoming: future.slice(0, 5).map(require('./routes_core').decorateAppt),
        counts: { consultas: appts.filter(a => a.type !== 'procedimento').length, procedimentos: appts.filter(a => a.type === 'procedimento').length, exames: filter('exam_orders', x => x.patient_id === p.id).length, receitas: filter('prescriptions', x => x.patient_id === p.id).length, pendentes_pagamento: filter('payments', x => x.patient_id === p.id && !['APPROVED','EXEMPT','REFUNDED'].includes(x.status)).length }
      });
    }
    if (me.role === 'profissional') {
      const pr = find('professionals', x => x.user_id === me.id);
      if (!pr) return U.ok(res, { role: 'profissional', empty: true });
      const list = filter('appointments', a => a.professional_id === pr.id).map(require('./routes_core').decorateAppt);
      const todayList = list.filter(a => a.date === t && !['CANCELADA'].includes(a.status)).sort((a, b) => a.start_time.localeCompare(b.start_time));
      return U.ok(res, {
        role: 'profissional', professional: pr, today: todayList,
        counts: {
          hoje: todayList.length,
          liberadas: list.filter(a => ['LIBERADA','CONFIRMADA','CHECKIN'].includes(a.status) && a.date >= t).length,
          aguardando: list.filter(a => ['AGUARDANDO_COMPROVANTE','AGUARDANDO_LIBERACAO'].includes(a.status) && a.date >= t).length,
          finalizadas: list.filter(a => a.status === 'FINALIZADA').length,
          retornos: filter('return_recommendations', r => r.professional_id === pr.id).length
        }
      });
    }
    // staff / admin
    const appts = filter('appointments').map(require('./routes_core').decorateAppt);
    const pays = filter('payments');
    const d = {
      role: me.role,
      counts: {
        consultas_hoje: appts.filter(a => a.date === t && !['CANCELADA'].includes(a.status)).length,
        pacientes_hoje: new Set(appts.filter(a => a.date === t).map(a => a.patient_id)).size,
        liberadas: appts.filter(a => a.date >= t && ['LIBERADA','CONFIRMADA','CHECKIN'].includes(a.status)).length,
        aguardando_comprovante: pays.filter(p => p.status === 'WAITING_RECEIPT' || p.status === 'REJECTED').length,
        em_analise: pays.filter(p => ['RECEIPT_SUBMITTED','UNDER_REVIEW'].includes(p.status)).length,
        aprovados: pays.filter(p => p.status === 'APPROVED').length,
        profissionais_ativos: filter('professionals', p => p.status === 'Ativo').length,
        funcionarios_ativos: filter('employees', e => e.status === 'APROVADO').length,
        funcionarios_pendentes: filter('employees', e => e.status === 'AGUARDANDO_APROVACAO').length,
        pacientes_total: filter('patients').length,
        procedimentos: filter('procedures', p => p.active).length,
        exames_aguardando: filter('exam_orders', x => !['LIBERADO','RESULTADO_ANEXADO'].includes(x.status)).length,
        resultados_disponiveis: filter('exam_results').length
      },
      recent: appts.filter(a => a.date >= t).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time)).slice(0, 8)
    };
    return U.ok(res, d);
  });

  // ---------- RELATÓRIOS ----------
  R.get('/api/reports', async (req, res) => {
    if (!U.requireRole(req.user, ['admin', 'administrativo'])) return U.fail(res, 403, 'Apenas administrativo.');
    const from = String(req.query.from || '2000-01-01'), to = String(req.query.to || '2100-01-01');
    const appts = filter('appointments', a => a.date >= from && a.date <= to);
    const pays = filter('payments').filter(p => { const a = get('appointments', p.appointment_id); return !a || (a.date >= from && a.date <= to); });
    const group = (arr, keyFn) => { const m = {}; arr.forEach(x => { const k = keyFn(x) || '—'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count); };
    const money = arr => arr.reduce((s, p) => s + Number(p.amount || 0), 0);
    return U.ok(res, {
      period: { from, to },
      total_consultas: appts.length,
      por_status: group(appts, a => a.status),
      por_profissional: group(appts, a => (get('professionals', a.professional_id) || {}).name),
      por_especialidade: group(appts, a => (get('specialties', a.specialty_id) || {}).name),
      por_mes: group(appts, a => a.date.slice(0, 7)),
      cancelamentos: appts.filter(a => a.status === 'CANCELADA').length,
      nao_compareceu: appts.filter(a => a.status === 'NAO_COMPARECEU').length,
      pacientes_atendidos: new Set(appts.filter(a => a.status === 'FINALIZADA').map(a => a.patient_id)).size,
      procedimentos_realizados: appts.filter(a => a.type === 'procedimento').length,
      financeiro: {
        previsto: money(pays),
        aprovado: money(pays.filter(p => p.status === 'APPROVED')),
        pendente: money(pays.filter(p => ['WAITING_RECEIPT','RECEIPT_SUBMITTED','UNDER_REVIEW','REJECTED'].includes(p.status))),
        recusado: money(pays.filter(p => p.status === 'REJECTED')),
        isento: pays.filter(p => p.status === 'EXEMPT').length,
        registro: 'Valores registrados internamente. Sem integração bancária.'
      }
    });
  });
};
