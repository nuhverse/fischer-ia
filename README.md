# MEDICAL CENTER FISCHER IA
### Sistema completo de gestão hospitalar, agendamentos, prontuário eletrônico e inteligência artificial

**Ciência | Vida | Pessoas | Sempre**

Aplicação web full-stack (frontend SPA + backend Node.js + banco persistente), **zero dependências externas** — não requer `npm install`.

---

## ▶ Como executar

```bash
cd fischer-ia
PORT=3000 node server.js
```

Acesse `http://localhost:3000`. Funciona em computador, notebook, tablet e smartphone (layout responsivo).

## 🔑 Acessos

| Perfil | E-mail | Senha |
|---|---|---|
| **Admin Master** | nuhverse@gmail.com | `AdminFischer2026` |
| Profissional (Obstetrícia) | helena.fischer@fischeria.med.br | `Helena2026xx` |
| Recepção | recepcao@fischeria.med.br | `Recep2026xx` |
| Paciente (demonstração) | maria.teste@exemplo.com | `Maria2026xx` |

> Nenhuma senha consta no código-fonte — todas foram criadas pelo fluxo seguro de **Primeiro Acesso** e ficam apenas com hash (scrypt) no banco. Demais contas (demais profissionais, administrativo) definem a própria senha pelo link **"Primeiro acesso"** da tela de login. O Admin Master também pode **redefinir a senha** de qualquer usuário em *Usuários → Gerenciar*.

## 🏗 Arquitetura

```
fischer-ia/
├── server.js            # Servidor HTTP, roteador, estáticos, uploads protegidos
├── db.js                # Camada de dados persistente (data/db.json, escrita atômica)
├── util.js              # Sessões, scrypt, auditoria, notificações, upload base64
├── routes_auth.js       # Login, primeiro acesso, cadastro, recuperação
├── routes_core.js       # Pacientes, profissionais, especialidades, procedimentos, agenda/slots
├── routes_booking.js    # Agendamentos, encaixe, PIX manual, comprovantes, triagem
├── routes_clinical.js   # Prontuário longitudinal, atendimentos, adendos, receitas, exames
├── routes_admin.js      # Usuários, funcionários, agentes IA, auditoria, relatórios
├── routes_ai.js         # Fischer Lab/Imaging/Pharma/Nursing IA (simulação)
├── uploads/             # Arquivos enviados (comprovantes, exames, receitas)
└── public/              # SPA (HTML/CSS/JS puro, identidade Fischer IA)
```

## ✅ Fluxos implementados

- **Login** com bloqueio após 5 tentativas (15 min), sessões de 7 dias, rate-limit.
- **Cadastro** de paciente (ativo) e funcionário (**AGUARDANDO APROVAÇÃO** → Admin aprova/recusa/suspende/desativa).
- **Agenda inteligente**: grade semanal por profissional (ex.: quinta 21h–00h → 21:00, 22:00, 23:00), intervalos, bloqueios (férias, congresso…) e **encaixe autorizado**.
- **PIX 100% manual**: agendamento → pop-up com chave PIX copiável → envio de comprovante (JPG/PNG/PDF) → análise administrativa → **aprovação libera a consulta** / recusa com motivo → reenvio. **Sem integração bancária.**
- **Bloqueio clínico**: profissional só abre atendimento com consulta **LIBERADA**.
- **Prontuário longitudinal**: 1 prontuário por paciente + N atendimentos; **autosave**; finalização trava o registro (complementos por **adendo**); campos base por especialidade (Obstetrícia, Pediatria, Nutrição…) + **construtor de formulários** do Admin.
- **Receitas** (itens, texto livre ou foto/PDF), **exames**, **retornos recomendados** (não criam consulta).
- **Agentes IA** (Fischer Lab/Imaging/Pharma/Nursing) com pipelines simulados marcados *DOCUMENTO FICTÍCIO — SIMULAÇÃO/RPG*; modo de operação alternável **SIMULAÇÃO / CLÍNICO**.
- **Recepção**: agenda dia/semana/mês, check-in, triagem (ou simulada por Nursing IA), cadastro de pacientes; **sem acesso ao conteúdo clínico** (403).
- **Admin Master**: dashboard de 12 indicadores, usuários/permissões, funcionários, especialidades, procedimentos, pagamentos, formulários, agentes IA, relatórios, **auditoria completa**, configuração de PIX/instituição.
- **Notificações** por evento, **uploads protegidos** por permissão, estados vazios, mensagens de sucesso/erro.

## 🎨 Identidade visual

Navy `#0A2742` · Azul `#2E5B86` · Azul claro `#7EA7C7` · Creme `#F4EDE3` · Pedra `#D7C9B8` · Dourado `#C9A96A`.
Tipografia: Playfair Display (títulos), Montserrat (interface), Lato (corpo). Menu lateral navy, cards claros, sombras discretas. O símbolo no topo é um *placeholder* geométrico — a logomarca oficial substituirá quando enviada (sem redesenho).
