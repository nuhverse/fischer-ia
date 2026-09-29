// ============================================================
// MEDICAL CENTER FISCHER IA — Servidor HTTP (zero-dependências)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, get, find } = require('./db');
const U = require('./util');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Mini-router ----------
const routes = { GET: [], POST: [], PUT: [], DELETE: [] };
const R = {
  get: (p, h) => routes.GET.push(mk(p, h)),
  post: (p, h) => routes.POST.push(mk(p, h)),
  put: (p, h) => routes.PUT.push(mk(p, h)),
  delete: (p, h) => routes.DELETE.push(mk(p, h))
};
function mk(pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  return { rx, keys, handler };
}

require('./routes_auth')(R);
require('./routes_core')(R);
require('./routes_booking')(R);
require('./routes_clinical')(R);
require('./routes_admin')(R);
require('./routes_ai')(R);

// Arquivo protegido (uploads)
R.get('/files/:name', async (req, res) => {
  const me = req.user;
  if (!me) return U.fail(res, 401, 'Não autenticado.');
  const name = path.basename(req.params.name);
  const frec = find('files', f => f.stored_name === name);
  if (!frec) return U.fail(res, 404, 'Arquivo não encontrado.');
  if (!U.canAccessFile(me, frec)) return U.fail(res, 403, 'Você não possui permissão para acessar este conteúdo.');
  const fp = path.join(U.UPLOAD_DIR, name);
  if (!fs.existsSync(fp)) return U.fail(res, 404, 'Arquivo não encontrado.');
  res.writeHead(200, { 'Content-Type': frec.mime, 'Content-Disposition': `inline; filename="${frec.original_name.replace(/"/g, '')}"`, 'Cache-Control': 'private, max-age=60' });
  fs.createReadStream(fp).pipe(res);
});

// Uploads de foto de perfil (paciente/profissional)
R.post('/api/upload/photo', async (req, res) => {
  if (!req.user) return U.fail(res, 401, 'Não autenticado.');
  try {
    const frec = U.saveUpload(req.user, req.body || {}, 'foto', null);
    U.ok(res, { file: frec.stored_name });
  } catch (e) { U.fail(res, 422, e.message || 'Arquivo inválido.'); }
});

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  // Segurança de cabeçalhos
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) {
    try {
      const cookies = U.parseCookies(req);
      req.user = U.sessionUser(cookies.fischer_session);
      req.query = Object.fromEntries(url.searchParams.entries());
      const method = req.method === 'DELETE' ? 'DELETE' : req.method;
      const list = routes[method] || [];
      for (const r of list) {
        const m = r.rx.exec(pathname);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1]));
        if (method !== 'GET') {
          try { req.body = await U.readBody(req); }
          catch (e) { return U.fail(res, e.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, e.message === 'PAYLOAD_TOO_LARGE' ? 'Arquivo muito grande (máx. 15MB).' : 'JSON inválido.'); }
        }
        return await r.handler(req, res);
      }
      return U.fail(res, 404, 'Rota não encontrada.');
    } catch (e) {
      console.error('[ERRO API]', e);
      return U.fail(res, 500, 'Não foi possível concluir esta operação.');
    }
  }

  // Estáticos
  let fp = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(fp).toLowerCase();
  const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Medical Center Fischer IA] online em http://0.0.0.0:${PORT}`);
});
