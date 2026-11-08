# Agenda & Escalas

Sistema web para **agendamento de treinamentos, folgas e plantões** e **gestão de escalas de trabalho** com base nos modelos praticados no Brasil e nos limites da CLT.

| Premissa | Como foi atendida |
|---|---|
| **Banco de dados** | SQLite (módulo nativo `node:sqlite`, sem dependências nativas), com chaves estrangeiras, índices e trilha de auditoria (`audit_log`). |
| **JavaScript** | Back-end em Node.js + Express; front-end em JavaScript puro (sem etapa de build). |
| **Nuvem** | `Dockerfile`, `render.yaml` (Render) e `fly.toml` (Fly.io, região São Paulo), health-check em `/api/health` e configuração via variáveis de ambiente. |
| **API** | API REST/JSON com autenticação JWT; o front-end consome exclusivamente a API. Relatórios em JSON ou CSV. |
| **Acessibilidade** | WCAG 2.1 AA: validado com axe-core, **sem violações** em todas as telas (detalhes abaixo). |

## Executar localmente

Requer **Node.js 22.13+**.

```bash
npm install
```

```bash
npm start
```

Acesse http://localhost:3000. Com o banco vazio, são criados dados de demonstração:

| Perfil | E-mail | Senha |
|---|---|---|
| Administrador | admin@empresa.com | Admin@123 |
| Operador | operador@empresa.com | Operador@123 |

Os demais operadores (bruno@, carla@, diego@… `@empresa.com`) usam a senha `Operador@123`.

Testes automatizados (API, permissões e regras de escala):

```bash
npm test
```

## Perfis

**Administrador**
- **Agenda:** calendário mensal e lista, com filtros por tipo, situação, equipe e colaborador. Cria agendamentos para várias pessoas de uma vez (ou para uma equipe inteira) e edita, cancela ou exclui.
- **Escalas:**
  - painel **"Quem está excedendo a escala"**;
  - cadastro de **times de escala**, com troca de integrantes;
  - **grade mensal** (Trabalho / Folga da escala / Folga agendada);
  - tabela dos modelos de escala com a base legal.
- **Jornadas:** registro de entrada e saída (ponto), que alimenta o controle de excesso.
- **Usuários:** cadastro, perfil, equipe, ativação/inativação e redefinição de senha.
- **Relatórios:** agendamentos, presença por colaborador e conformidade das escalas. Tudo pode ser visualizado na tela, baixado em **CSV** (abre direto no Excel em português) ou impresso / salvo em PDF.

**Operador**
- **Minha agenda:** agendamentos do próprio usuário (lista ou calendário) e o bloco **Validar presença**, com os botões *Compareci* / *Não compareci*. A presença só pode ser validada na data do evento ou depois dela.
- **Minha escala:** calendário com os dias de trabalho e de folga da escala, horário do turno e colegas de equipe.
- **Minhas jornadas:** horas registradas.

## Modelos de escala e regras (CLT)

| Modelo | Ciclo | Horas/dia padrão | Descanso mínimo |
|---|---|---|---|
| 5x2 | seg–sex | 8h48 (44h/semana) | 11h |
| 6x1 | 6 dias de trabalho, 1 de folga (rotativa) | 7h20 | 11h |
| 5x1 | 5 dias de trabalho, 1 de folga | 7h20 | 11h |
| 4x2 | 4 dias de trabalho, 2 de folga | 8h | 11h |
| 6x2 | 6 dias de trabalho, 2 de folga | 8h | 11h |
| 12x36 | trabalha 1 dia, folga 1 | 12h, sem hora extra (art. 59-A) | 36h |
| 24x48 | trabalha 1 dia, folga 2 | 24h | 48h |

As horas por dia e o horário do turno podem ser ajustados por equipe. A **data de início do ciclo** define o revezamento: por exemplo, as turmas A e B de 12x36 começam em dias consecutivos.

Para cada colaborador, a análise de conformidade (`src/scales.js`) compara as jornadas registradas com a escala e aponta:

1. **Jornada diária** acima de *horas da escala + 2h extras* (art. 59). Nas escalas 12x36 e 24x48, qualquer hora acima da jornada já conta.
2. **Jornada semanal** acima de 44h + 10h extras.
3. **Interjornada** menor que o mínimo: 11h (art. 66), 36h ou 48h, conforme a escala.
4. **Mais de 6 dias consecutivos** sem descanso semanal remunerado (art. 67).
5. **Trabalho em dia de folga** da escala ou em folga agendada.
6. **Saldo de horas:** trabalhadas menos previstas (as previstas contam só até hoje e já descontam as folgas agendadas).

Situação de cada colaborador:
- **Excedendo:** há alguma irregularidade ou o saldo passa de +2h.
- **Atenção:** o saldo é positivo, sem irregularidades.
- **Dentro da escala:** nenhum dos casos anteriores.

## API REST

Todas as rotas ficam sob `/api` e exigem o cabeçalho `Authorization: Bearer <token>`, exceto `login` e `health`. Datas usam o formato `AAAA-MM-DD`. Os filtros de período são `?from=&to=`; sem eles, vale o mês atual.

| Método | Rota | Perfil | Descrição |
|---|---|---|---|
| GET | `/health` | público | Verificação de saúde (nuvem) |
| POST | `/auth/login` | público | `{email, password}` → `{token, user}` (limite de 10 tentativas a cada 15 min) |
| GET | `/auth/me` | todos | Usuário logado |
| POST | `/auth/change-password` | todos | `{current, next}` |
| GET | `/scale-models` | todos | Modelos de escala |
| GET/POST | `/users` | admin | Listar / criar usuários |
| PUT/DELETE | `/users/:id` | admin | Editar / excluir |
| GET | `/teams` | todos | Equipes (o operador vê apenas a sua) |
| POST | `/teams` | admin | Criar equipe |
| PUT/DELETE | `/teams/:id` | admin | Editar / excluir equipe |
| PUT | `/teams/:id/members` | admin | `{user_ids: []}`: define os integrantes |
| GET | `/schedule` | todos | Escala prevista (`team_id`, `user_id`) |
| GET | `/scales/compliance` | admin | Quem está excedendo (`team_id`) |
| GET | `/events` | todos | Agendamentos (o operador vê apenas os seus); filtros `type`, `status`, `team_id`, `user_id` |
| POST | `/events` | admin | Cria agendamento; aceita `user_ids: []` para criar em lote |
| PUT/DELETE | `/events/:id` | admin | Editar / excluir |
| PATCH | `/events/:id/attendance` | dono ou admin | `{status: "compareceu" \| "nao_compareceu" \| "agendado"}` |
| GET | `/work-logs` | todos | Jornadas (o operador vê apenas as suas) |
| POST | `/work-logs` | admin | Registrar jornada |
| DELETE | `/work-logs/:id` | admin | Excluir jornada |
| GET | `/reports/events` | admin | Relatório de agendamentos (`?format=csv`) |
| GET | `/reports/attendance` | admin | Presença e taxa por colaborador (`?format=csv`) |
| GET | `/reports/compliance` | admin | Conformidade das escalas (`?format=csv`) |

Exemplo:

```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@empresa.com","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
```

```bash
curl -s "localhost:3000/api/scales/compliance?from=2026-11-01&to=2026-11-30" -H "Authorization: Bearer $TOKEN"
```

## Deploy em nuvem

Variáveis de ambiente (veja `.env.example`):
- `JWT_SECRET`: **obrigatória em produção**.
- `DB_PATH`, `PORT`, `TOKEN_TTL_SECONDS`.
- `SEED_DEMO=false`: desliga os dados de demonstração.

- **Render:** *New → Blueprint*, apontando para o repositório. O `render.yaml` já cria o serviço, gera o `JWT_SECRET` e monta um disco persistente em `/data`.
- **Fly.io:**

  ```bash
  fly launch --copy-config
  ```

  ```bash
  fly volumes create agenda_data --size 1 --region gru
  ```

  ```bash
  fly deploy
  ```

- **Qualquer provedor com Docker** (AWS App Runner/ECS, Google Cloud Run, Azure Container Apps etc.):

  ```bash
  docker build -t agenda-escalas .
  ```

  ```bash
  docker run -p 3000:3000 -e JWT_SECRET=... -v agenda-data:/data agenda-escalas
  ```

> Para escalar horizontalmente (várias instâncias), substitua o SQLite por um PostgreSQL gerenciado. O esquema em `src/db.js` usa SQL padrão e pode ser migrado sem mudanças estruturais.

## Acessibilidade

- HTML semântico e regiões (`header`, `nav`, `main`, `aside`), `lang="pt-BR"` e link **"Pular para o conteúdo"**.
- Todos os campos têm `<label>`; erros são anunciados com `role="alert"`; avisos ficam em região `aria-live`.
- Navegação 100% por teclado:
  - foco visível de alto contraste;
  - foco movido para o conteúdo ao trocar de página;
  - diálogos nativos `<dialog>` com retenção de foco e devolução ao botão de origem.
- Tabelas com `caption`, `th scope` e rolagem horizontal acessível. O calendário anuncia a data por extenso e o tipo e a situação de cada evento.
- Situações nunca dependem só de cor: sempre há texto ("Excedendo", "Compareceu"…) e os ícones ✓/✗ são complementares.
- Barra de acessibilidade com **tamanho de texto (A−/A/A+)** e **alto contraste**, salvos no navegador.
- Contraste mínimo AA, áreas de toque de 44px e respeito a `prefers-reduced-motion`.
- Validado com **axe-core** (regras WCAG 2.0/2.1 A e AA e boas práticas) em todas as telas: 0 violações.

## Segurança

- Senhas com `scrypt` e salt; tokens JWT HS256 com expiração.
- Limite de tentativas de login.
- Controle de acesso por perfil no servidor: o operador não acessa dados de outras pessoas.
- Cabeçalhos de segurança, incluindo uma CSP restritiva que impede scripts inline.
- Consultas parametrizadas (sem SQL injection) e escape de HTML no front-end.
- Trilha de auditoria das ações administrativas.

## Estrutura

```
src/
  server.js   inicialização (porta, seed, encerramento gracioso)
  app.js      API REST + arquivos estáticos
  db.js       esquema do banco
  auth.js     senhas e tokens
  scales.js   modelos de escala brasileiros e motor de conformidade
  seed.js     dados de demonstração
public/       front-end (index.html, app.js, styles.css)
test/         testes automatizados (node:test)
```
