# DEPLOY PERMANENTE — Medical Center Fischer IA (link 24h para todos)

## Opção recomendada: Render (gratuito, ~10 minutos)

1. Crie conta gratuita em https://github.com e suba esta pasta:
   - `git init && git add -A && git commit -m "Fischer IA"`
   - Crie um repositório novo no GitHub e siga as instruções de push.
2. Crie conta em https://render.com (pode entrar com o GitHub).
3. Clique em **New + → Web Service** e conecte o repositório.
4. Configure:
   - **Build Command:** (deixe vazio — não há dependências)
   - **Start Command:** `node server.js`
   - Plano: **Free**
5. Em **Environment Variables**, adicione: `PORT` = `3000` (o Render também define PORT automaticamente; já é suportado).
6. (Opcional, para dados não resetarem) **Disks → Add Disk**: Mount path `/opt/render/project/src/data`, 1GB.
7. Deploy → você recebe `https://medical-center-fischer-ia.onrender.com` (exemplo) — link público permanente.

## Alternativas (mesmos passo-a-passo)
- **Railway** (railway.app): New Project → Deploy from GitHub → Start Command `node server.js`
- **Fly.io / VPS / HostGator Node**: `node server.js` com a porta do ambiente

## Notas
- O app já lê a variável `PORT` automaticamente.
- Não requer `npm install` (zero dependências).
- Banco: arquivo `data/db.json` (em planos sem disco persistente, dados resetam a cada redeploy — com o Disk do Render, persistem).
