// Rotas de autenticação e contas — Medical Center Fischer IA
const { db, insert, find, get, update, now, today } = require('./db');
const U = require('./util');

const loginAttempts = new Map(); // rate-limit simples em memória
function limited(key) {
  const e = loginAttempts.get(key) || { n: 0, t: 0 };
  const nowMs = Date.now();
  if (nowMs - e.t > 10 * 60 * 1000) { e.n = 0; e.t = nowMs; }
  if (e.n >= 12) return true;
  e.n++; e.t = nowMs; loginAttempts.set(key, e);
  return false;
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, failed_attempts, lock_until, ...rest } = u;
  rest.has_password = !!password_hash;
  rest.patient_id = u.role === 'paciente' ? (find('patients', p => p.user_id === u.id) || {}).id || null : null;
  rest.professional_id = u.role === 'profissional' ? (find('professionals', p => p.user_id === u.id) || {}).id || null : null;
  return rest;
}

module.exports = function registerAuth(R) {

  R.post('/api/auth/login', async (req, res) => {
    if (limited('login:' + U.rateLimitKey(req))) return U.fail(res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const user = find('users', u => u.email.toLowerCase() === email);
    if (!user) return U.fail(res, 401, 'E-mail ou senha inválidos.');
    if (user.lock_until && user.lock_until > now()) return U.fail(res, 423, 'Conta temporariamente bloqueada por tentativas inválidas. Tente em 15 minutos.');
    if (!user.password_hash) return U.fail(res, 428, 'Primeiro acesso pendente. Use a opção "Primeiro acesso" para criar sua senha.');
    if (user.status === 'pending') return U.fail(res, 403, 'Seu cadastro está aguardando aprovação do administrador.');
    if (user.status !== 'active') return U.fail(res, 403, 'Usuário inativo ou bloqueado. Contate a administração.');
    if (!U.verifyPassword(String(b.password || ''), user.password_hash)) {
      const fa = (user.failed_attempts || 0) + 1;
      const patch = { failed_attempts: fa };
      if (fa >= 5) { patch.lock_until = new Date(Date.now() + 15 * 60 * 1000).toISOString(); patch.failed_attempts = 0; }
      update('users', user.id, patch);
      U.audit(user, 'LOGIN_FALHOU', 'users', user.id);
      return U.fail(res, 401, 'E-mail ou senha inválidos.');
    }
    update('users', user.id, { failed_attempts: 0, lock_until: null, last_login: now() });
    const token = U.createSession(user.id);
    U.audit(user, 'LOGIN', 'users', user.id);
    return U.send(res, 200, { ok: true, data: { user: publicUser(user) } }, { 'Set-Cookie': `fischer_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 7}` });
  });

  // Primeiro acesso: usuário existente sem senha cria a própria senha
  R.post('/api/auth/first-access', async (req, res) => {
    if (limited('first:' + U.rateLimitKey(req))) return U.fail(res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const pw = String(b.password || '');
    const user = find('users', u => u.email.toLowerCase() === email);
    if (!user) return U.fail(res, 404, 'E-mail não encontrado. Verifique ou crie seu cadastro de paciente.');
    if (user.password_hash) return U.fail(res, 409, 'Esta conta já possui senha. Use o login ou a recuperação de senha.');
    if (pw.length < 8) return U.fail(res, 422, 'A senha deve ter no mínimo 8 caracteres.');
    update('users', user.id, { password_hash: U.hashPassword(pw), must_set_password: false });
    U.audit(user, 'PRIMEIRO_ACESSO_SENHA_DEFINIDA', 'users', user.id);
    return U.ok(res, { message: 'Senha criada com sucesso. Você já pode entrar.' });
  });

  // Recuperação simplificada: gera notificação ao administrativo (sem e-mail externo nesta versão)
  R.post('/api/auth/forgot', async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const user = find('users', u => u.email.toLowerCase() === email);
    if (user) {
      U.notifyRole('admin', 'Recuperação de senha solicitada', `O usuário ${user.name} (${user.email}) solicitou recuperação de senha. Você pode redefinir no painel de Usuários.`, 'conta', user.id);
      U.audit(user, 'RECUPERACAO_SOLICITADA', 'users', user.id);
    }
    return U.ok(res, { message: 'Se o e-mail estiver cadastrado, a administração foi notificada para redefinir sua senha.' });
  });

  // Cadastro público: paciente (ativo) ou funcionário (aguardando aprovação)
  R.post('/api/auth/register', async (req, res) => {
    if (limited('reg:' + U.rateLimitKey(req))) return U.fail(res, 429, 'Muitas tentativas. Aguarde.');
    const b = req.body || {};
    const kind = b.kind === 'funcionario' ? 'funcionario' : 'paciente';
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const pw = String(b.password || '');
    if (name.length < 3) return U.fail(res, 422, 'Informe o nome completo.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return U.fail(res, 422, 'E-mail inválido.');
    if (pw.length < 8) return U.fail(res, 422, 'A senha deve ter no mínimo 8 caracteres.');
    if (find('users', u => u.email.toLowerCase() === email)) return U.fail(res, 409, 'Este e-mail já está cadastrado.');

    if (kind === 'paciente') {
      const birth = String(b.birth_date || '');
      const user = insert('users', { email, password_hash: U.hashPassword(pw), name, role: 'paciente', status: 'active', phone: String(b.phone || ''), birth_date: birth, photo: '', must_set_password: false, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });
      const seq = db.meta.seq;
      const patient = insert('patients', {
        user_id: user.id, record_number: 'MCF-' + String(Date.now()).slice(-8),
        name, photo: '', birth_date: birth, email, phone: String(b.phone || ''), address: String(b.address || ''),
        gender: String(b.gender || ''), emergency_contact: String(b.emergency_contact || ''), guardian_id: null,
        notes: '', created_at: today()
      });
      // menor de idade → responsável legal
      if (birth && ageYears(birth) < 18) {
        const g = insert('guardians', { patient_id: patient.id, name: String(b.guardian_name || ''), kinship: String(b.guardian_kinship || ''), birth_date: '', phone: String(b.guardian_phone || ''), email: '', document: String(b.guardian_document || ''), authorizations: '', consents: '', created_at: now() });
        update('patients', patient.id, { guardian_id: g.id });
      }
      insert('medical_records', { patient_id: patient.id, record_number: patient.record_number, created_at: now(), status: 'Ativo' });
      U.audit(user, 'CADASTRO_PACIENTE', 'patients', patient.id, patient.id);
      U.notifyRole('recepcao', 'Novo paciente cadastrado', `${name} realizou autocadastro no portal.`, 'paciente', patient.id);
      return U.ok(res, { message: 'Cadastro criado com sucesso. Faça login para continuar.' });
    }

    // funcionário — aguardando aprovação
    const user = insert('users', { email, password_hash: U.hashPassword(pw), name, role: 'funcionario', status: 'pending', phone: String(b.phone || ''), birth_date: String(b.birth_date || ''), photo: '', must_set_password: false, created_at: now(), last_login: null, failed_attempts: 0, lock_until: null });
    insert('employees', {
      user_id: user.id, name, birth_date: String(b.birth_date || ''), email, phone: String(b.phone || ''),
      role_desired: String(b.role_desired || ''), sector: String(b.sector || ''), photo: '', notes: String(b.notes || ''),
      status: 'AGUARDANDO_APROVACAO', created_at: now()
    });
    U.audit(user, 'CADASTRO_FUNCIONARIO', 'users', user.id);
    U.notifyRole('admin', 'Funcionário aguardando aprovação', `${name} solicitou cadastro como funcionário (${b.role_desired || 'cargo não informado'}).`, 'aprovacao', user.id);
    return U.ok(res, { message: 'Cadastro enviado. Status: AGUARDANDO APROVAÇÃO pelo Admin Master.' });
  });

  R.post('/api/auth/logout', async (req, res) => {
    const cookies = U.parseCookies(req);
    if (cookies.fischer_session) U.destroySession(cookies.fischer_session);
    return U.send(res, 200, { ok: true, data: {} }, { 'Set-Cookie': 'fischer_session=; Path=/; HttpOnly; Max-Age=0' });
  });

  R.get('/api/auth/me', async (req, res) => {
    const u = req.user;
    if (!u) return U.fail(res, 401, 'Não autenticado.');
    return U.ok(res, { user: publicUser(u) });
  });

  R.post('/api/auth/change-password', async (req, res) => {
    const u = req.user; if (!u) return U.fail(res, 401, 'Não autenticado.');
    const b = req.body || {};
    if (!U.verifyPassword(String(b.current || ''), u.password_hash)) return U.fail(res, 401, 'Senha atual incorreta.');
    if (String(b.next || '').length < 8) return U.fail(res, 422, 'A nova senha deve ter no mínimo 8 caracteres.');
    update('users', u.id, { password_hash: U.hashPassword(String(b.next)) });
    U.audit(u, 'SENHA_ALTERADA', 'users', u.id);
    return U.ok(res, { message: 'Senha alterada com sucesso.' });
  });
};

function ageYears(birth) {
  const b = new Date(birth + 'T00:00:00'); const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}
