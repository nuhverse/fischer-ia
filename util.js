// ============================================================
// MEDICAL CENTER FISCHER IA — Utilitários de servidor
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, save, insert, get, find, filter, update, remove, now } = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Senha ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

// ---------- Sessões ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 dias
  insert('sessions', { token, user_id: userId, expires_at: exp, created_at: now() });
  return token;
}
function destroySession(token) {
  const i = db.sessions.findIndex(s => s.token === token);
  if (i >= 0) { db.sessions.splice(i, 1); save(); }
}
function sessionUser(token) {
  if (!token) return null;
  const s = db.sessions.find(s => s.token === token);
  if (!s || s.expires_at < now()) return null;
  const u = get('users', s.user_id);
  if (!u || u.status !== 'active') return null;
  return u;
}

// ---------- HTTP helpers ----------
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function ok(res, data) { send(res, 200, { ok: true, data }); }
function fail(res, code, error) { send(res, code, { ok: false, error }); }
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limitBytes || 15 * 1024 * 1024)) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- Auditoria & Notificações ----------
function audit(user, action, entity, entityId, patientId, oldV, newV) {
  insert('audit_logs', {
    user_id: user ? user.id : null, user_name: user ? user.name : 'Sistema', role: user ? user.role : 'system',
    action, entity, entity_id: entityId != null ? Number(entityId) : null, patient_id: patientId || null,
    old_value: oldV ? JSON.stringify(oldV).slice(0, 4000) : '', new_value: newV ? JSON.stringify(newV).slice(0, 4000) : '',
    created_at: now()
  });
}
function notify(userId, title, message, type, relatedId) {
  if (!userId) return;
  insert('notifications', { user_id: userId, title, message, type: type || 'info', related_id: relatedId || null, read: false, created_at: now() });
}
function notifyRole(role, title, message, type, relatedId) {
  for (const u of db.users.filter(u => u.role === role && u.status === 'active')) notify(u.id, title, message, type, relatedId);
}
function patientUserId(patientId) {
  const p = get('patients', patientId);
  return p && p.user_id ? p.user_id : null;
}
function professionalUserId(profId) {
  const p = get('professionals', profId);
  return p && p.user_id ? p.user_id : null;
}

// ---------- Upload (base64 JSON) ----------
const MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
function saveUpload(user, body, kind, patientId) {
  const mime = (body.mime || '').toLowerCase();
  if (!MIME[mime]) throw Object.assign(new Error('Formato inválido. Use JPG, PNG ou PDF.'), { code: 'BAD_FILE' });
  const b64 = String(body.data || '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw Object.assign(new Error('Arquivo vazio.'), { code: 'BAD_FILE' });
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('Arquivo excede 8MB.'), { code: 'BAD_FILE' });
  const name = crypto.randomBytes(16).toString('hex') + MIME[mime];
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  const rec = insert('files', {
    stored_name: name, original_name: (body.name || 'arquivo' + MIME[mime]).slice(0, 120),
    mime, size: buf.length, kind: kind || 'geral', patient_id: patientId || null,
    uploaded_by: user ? user.id : null, created_at: now()
  });
  return rec;
}
function canAccessFile(user, frec) {
  if (!user || !frec) return false;
  if (['admin', 'administrativo', 'recepcao'].includes(user.role)) return true;
  if (frec.uploaded_by === user.id) return true;
  if (user.role === 'paciente') {
    const p = find('patients', x => x.user_id === user.id);
    if (p && frec.patient_id === p.id) return true;
  }
  if (user.role === 'profissional' && frec.patient_id) {
    const prof = find('professionals', x => x.user_id === user.id);
    if (prof) {
      const ap = find('appointments', a => a.patient_id === frec.patient_id && a.professional_id === prof.id);
      if (ap) return true;
    }
  }
  return false;
}

// ---------- Autorização ----------
const ROLE_RANK = { paciente: 1, responsavel: 1, funcionario: 2, agente_ia: 2, recepcao: 3, profissional: 3, administrativo: 4, admin: 5 };
function requireRole(user, roles) { return user && roles.includes(user.role); }

function rateLimitKey(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?') + ''; }

// Status helpers
const APPT_STATUS = {
  AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', AGUARDANDO_COMPROVANTE: 'Aguardando comprovante',
  COMPROVANTE_ENVIADO: 'Comprovante enviado', PAGAMENTO_EM_ANALISE: 'Pagamento em análise',
  AGUARDANDO_LIBERACAO: 'Aguardando liberação', LIBERADA: 'Liberada', CONFIRMADA: 'Confirmada',
  CHECKIN: 'Check-in realizado', EM_ATENDIMENTO: 'Em atendimento', FINALIZADA: 'Finalizada',
  CANCELADA: 'Cancelada', REAGENDADA: 'Reagendada', NAO_COMPARECEU: 'Não compareceu'
};
const PAY_STATUS = {
  WAITING_RECEIPT: 'Aguardando comprovante', RECEIPT_SUBMITTED: 'Comprovante enviado',
  UNDER_REVIEW: 'Em análise', APPROVED: 'Aprovado', REJECTED: 'Recusado', EXEMPT: 'Isento', REFUNDED: 'Estornado'
};

module.exports = {
  UPLOAD_DIR, hashPassword, verifyPassword, createSession, destroySession, sessionUser,
  parseCookies, send, ok, fail, readBody, audit, notify, notifyRole, patientUserId, professionalUserId,
  saveUpload, canAccessFile, ROLE_RANK, requireRole, rateLimitKey, APPT_STATUS, PAY_STATUS
};
