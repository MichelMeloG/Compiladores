# Backlog do front-end (dashboard) — RoboFlow

Gerado em 26/10/2026 a partir da leitura do código em `dashboard/` e dos documentos em `docs/` e `backend/`. Complementa a análise de arquitetura GCP (Cloud Run, Firestore, Pub/Sub, cota gratuita).

**Legenda.** Tipo: `DEC` decisão, `BUG`, `DÍV` dívida técnica, `FEAT` funcionalidade, `SEG` segurança, `CUSTO` custo/cota. Prioridade: P0 bloqueia o resto, P1 necessário para o POC, P2 desejável, P3 polimento. Esforço: S (< 0,5 dia), M (0,5–2 dias), L (> 2 dias).

## 1. Diagnóstico

Verificado rodando `npm ci`, `npm run lint`, `npm run build` e `npm audit --omit=dev` em `dashboard/`:

| Item | Resultado |
|---|---|
| Tamanho | ~7,9 mil linhas, React 19 + TypeScript + Vite + Tailwind + Recharts |
| `tsc --noEmit` e build | Passam |
| Bundle | 1 chunk de 765 kB (215 kB gzip), sem code-splitting |
| Testes automatizados | **Nenhum.** O CI roda só lint e build |
| `strict` no TypeScript | **Desligado** (`tsconfig.json` não o declara). O lint verde é menos confiável do que parece |
| `npm audit` | 1 vulnerabilidade alta (`body-parser`), trazida por `express`, que **não é usado** no código |
| Autenticação | Inexistente: `api.ts` não envia credencial e não trata 401/403 |
| Atualização de dados | Só no carregamento, troca de filtro e botão "Atualizar". Não há polling |
| Navegação | Estado em memória. Sem rota: sem deep link, sem botão voltar, recarregar perde o contexto |
| Operação do AGV | Só existe "enviar rota". Não há iniciar/parar/retomar/abortar, nem estado de execução |

Pontos fortes a preservar: serviços HTTP isolados em `src/services/`, `api.ts` como único `fetch`, regras de malha puras em `routeGrid.ts`, distinção explícita entre "erro" e "vazio", estados de carregamento, canvas da malha com `role`/`tabIndex`/`aria-label`.

## 2. Backlog ordenado

### Fase 0 — Decisões que destravam o resto (sem código)

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-001 | DEC | P0 | S | **Convenção do eixo Y.** O front usa origem no canto superior esquerdo com y crescendo para baixo (`describeStep` chama `y` menor de "Norte"). `backend/README.md` §4 usa y para o norte | ADR escolhe uma convenção; `BACKEND_INTEGRATION.md`, `backend/README.md` e `routeGrid.ts` ficam consistentes. Tabela de tradução F/D/E testada nas 4 orientações |
| FE-002 | DEC | P0 | S | **Contrato único de ordem.** Hoje há `POST /robots/:id/route` (waypoints livres, `accepted:false` com 200) e `POST /missions` (rota cadastrada, 201/202/409/422) | ADR define um fluxo: prévia → criar missão → start. Define também se recusa operacional é 200 ou 4xx |
| FE-003 | DEC | P0 | M | **Transporte e hospedagem** conforme a análise de arquitetura (poll HTTPS ao Cloud Run, Firestore). O front depende disso para auth, polling e quotas | ADR publicado; decide Firebase Hosting ou GitHub Pages para o front |
| FE-004 | DEC | P1 | S | **Nomenclatura.** "Rover Monitor", "RoboFlow", "AGV", "carrinho", "robô" e "device" convivem | Glossário curto; título do `index.html`, textos e docs alinhados |

### Fase 1 — Higiene e fundação (não depende de backend)

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-010 | DÍV | P0 | S | Remover `express`, `@types/express`, `dotenv`, `tsx` e o script `clean` (que cita `server.js`). Restos de template | `npm audit --omit=dev` sem alta; build igual |
| FE-011 | DÍV | P0 | S | Remover do `vite.config.ts` os comentários e a lógica `DISABLE_HMR` de AI Studio | Config só com o que o projeto usa |
| FE-012 | SEG | P0 | S | **`package.json` e `node_modules/` soltos na raiz** (não rastreados) com dependência `claude@^0.1.1`. Provável `npm i` acidental | Verificar a origem do pacote, apagar, não commitar. Raiz sem manifesto de Node |
| FE-013 | DÍV | P0 | M | Ativar `"strict": true` e remover `experimentalDecorators`/`allowJs` do `tsconfig.json` | `npm run lint` verde com `strict`; erros corrigidos sem `any` novo |
| FE-014 | DÍV | P1 | M | Introduzir **Vitest** e testar o que é puro: `routeGrid.ts` (caminho, remoção, substituição, validação), `logParser.ts` (JSON/CSV, aliases, `unassigned`), `formatters.ts` | ≥ 80% de cobertura nesses 3 arquivos; `npm test` no CI |
| FE-015 | DÍV | P1 | S | CI: adicionar `npm test`, `npm audit --omit=dev --audit-level=high`, secret scanning e Dependabot | PR falha com teste quebrado ou dependência alta |
| FE-016 | BUG | P1 | S | `Dashboard.handleAcknowledge` não tem `try/catch` (rejeição não tratada) e remove o alerta da lista mesmo se o backend responder `acknowledged:false`. `Alerts.tsx` também ignora o booleano retornado | Falha mostra erro e mantém o alerta; só `true` remove/marca |
| FE-017 | DÍV | P1 | M | Trocar o estado de navegação por **roteamento por hash** (`/#/robots/RB-01/missions`) | Deep link, botão voltar e F5 preservam robô e página; funciona no Pages |
| FE-018 | CUSTO | P2 | S | Code-splitting: `React.lazy` por página e carregar `recharts` sob demanda | Chunk inicial < 300 kB; aviso do Vite some |
| FE-019 | DÍV | P2 | S | Fontes do Google: self-host ou `font-display` com fallback; avaliar CSP | Sem dependência externa em runtime, ou CSP documentada |

### Fase 2 — Cliente HTTP e contratos

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-020 | FEAT | P1 | M | `api.ts`: **retry com backoff em GET** e mensagem "servidor acordando" para cold start do Cloud Run. Hoje o timeout fixo de 10 s vira erro | GET idempotente tenta até 3 vezes; POST nunca repete sozinho |
| FE-021 | FEAT | P1 | S | `api.ts`: aceitar `AbortSignal` do chamador e cancelar ao desmontar/trocar filtro | Troca rápida de filtro não deixa resposta velha sobrescrever a nova |
| FE-022 | SEG | P1 | M | Gancho de autenticação em `api.ts` (`Authorization: Bearer <ID token>`), tratamento de 401 (renovar/ir ao login) e 403 (mensagem de permissão) | Nenhuma chamada sai sem token em build não-demo |
| FE-023 | FEAT | P1 | S | Enviar **`Idempotency-Key`** (UUID gerado por tentativa de ação) em todo POST/PATCH operacional | Duplo clique ou reenvio não duplica missão |
| FE-024 | DÍV | P1 | M | Schemas compartilhados (zod) para as respostas, validados em `apiRequest`; tipos de `types/index.ts` derivados deles | Resposta fora do contrato vira erro legível, não tela quebrada |
| FE-025 | DÍV | P2 | S | Alinhar `BACKEND_INTEGRATION.md` ao código: ele afirma "sem modo demo", mas existe `VITE_DEMO` | Documento e código coerentes |

### Fase 3 — Operação do AGV (depende do backend de missões)

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-030 | FEAT | P0 | M | **Confirmar posição e orientação inicial** antes de enviar. Hoje `robotAt` só é desenhado: nada exige que o primeiro waypoint seja o ponto atual do robô nem pede o rumo | Envio bloqueado até o operador confirmar nó e rumo; divergência com `currentPoint` gera aviso |
| FE-031 | FEAT | P0 | M | **Prévia** da rota (`POST /routes/:id/preview` ou equivalente): fila F/D/E, rumo final, erros de capacidade (`T` sem ré) | Operador vê comandos e motivo de recusa antes de criar a missão |
| FE-032 | FEAT | P0 | M | **Separar "carregar rota" de "iniciar"**. Hoje "Enviar rota ao robô" fica ambíguo e o `activeRoute` local é fabricado como `queued` no cliente | Estados `queued/loading/ready/running` vêm do servidor, nunca inventados no cliente |
| FE-033 | FEAT | P0 | L | **Controles**: iniciar, parar, retomar (com `blockId` exibido), abortar. Estado "pendente" até confirmação do dispositivo, com resultado do comando | Cada botão mostra pendente/aceito/rejeitado/expirado/incerto; sem afirmar parada não confirmada |
| FE-034 | FEAT | P1 | L | **Atualização ao vivo**: polling configurável, só com a aba visível e missão ativa; exibir idade do dado ("há 12 s") | Sem missão ativa, intervalo longo ou nenhum; aba oculta pausa |
| FE-035 | FEAT | P1 | M | **Progresso na malha**: `currentWaypointIndex`, último nó confirmado, próximo esperado, `positionConfidence`. O `RoutePlanner` hoje mostra só status e contagem | Canvas destaca trechos concluídos, atual e restantes; posição "estimada" rotulada como tal |
| FE-036 | FEAT | P1 | M | Tela de **estado do dispositivo**: sessão, conexão, bloqueios, último contato, versão do firmware | Dado velho exibe a idade e nunca "ao vivo" |
| FE-037 | FEAT | P1 | S | Estado `indeterminate`/posição incerta com ação guiada de reposicionamento | Missão incerta mantém o robô reservado e explica o próximo passo |
| FE-038 | FEAT | P2 | M | Alertas e `stop_preventive`/`presence_detected` em destaque durante missão ativa | Parada preventiva aparece sem recarregar a página |

### Fase 4 — Custo e cota gratuita

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-040 | CUSTO | P1 | M | **Parar de baixar listas inteiras para desenhar gráficos.** `Dashboard` busca todas as missões e logs e agrega no navegador | Endpoints devolvem séries/rollups prontos; listas com `limit` e teto máximo |
| FE-041 | CUSTO | P1 | S | `GET /logs` e `/missions` com `limit`/cursor; `Pagination.tsx` passa a paginar no servidor | Página inicial carrega ≤ 50 itens; custo de leitura previsível |
| FE-042 | CUSTO | P1 | S | **Importação**: limite de tamanho (ex.: 2 MB) e envio em lotes de ~500 eventos, com aviso de quota diária de escrita do Firestore | Arquivo grande é recusado ou dividido; progresso por lote |
| FE-043 | FEAT | P2 | S | Importação: seletor de **robô de destino** para eventos `robotId: "unassigned"` (hoje fica a cargo do backend, sem UI) | Operador escolhe o robô antes de confirmar |
| FE-044 | CUSTO | P2 | S | Cache leve de leituras estáticas (mapa/lista de robôs) e `Cache-Control` coerente | Navegar entre páginas não repete `GET /robots` e `/grid` |

### Fase 5 — Segurança no cliente

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-050 | SEG | P1 | M | Tela de login (Firebase Auth/Google) e controle de papéis na UI (leitor sem botões de comando) | Leitor não vê nem aciona controles; o servidor também recusa |
| FE-051 | SEG | P1 | S | Garantir que o **build de produção nunca inclua `src/demo/`** e que dados fictícios nunca acionem dispositivo real | Teste de CI inspeciona o bundle; faixa de demo permanente |
| FE-052 | SEG | P2 | S | CSP e cabeçalhos no hosting; `rel`/escape em qualquer texto vindo de log (`message`, `raw`, `payload`) | Nenhum `dangerouslySetInnerHTML`; teste com payload malicioso em log importado |
| FE-053 | SEG | P2 | S | Não persistir tokens em `localStorage`; sem segredos em `VITE_*` | Revisão registrada |

### Fase 6 — Qualidade e polimento

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FE-060 | DÍV | P2 | M | Auditoria de acessibilidade (foco, contraste, tabelas, modais com `aria-modal` e retorno de foco). Só o canvas foi inspecionado | Relatório axe sem críticos |
| FE-061 | DÍV | P2 | M | Tokens de design no lugar de hex espalhados (`#245C43`, `#E4ECE6`…) | Cores vêm de variáveis; base para tema escuro |
| FE-062 | DÍV | P3 | M | Quebrar páginas grandes (`Dashboard.tsx` 874 linhas, `RoutePlanner.tsx` 557) em componentes e hooks de dados | Nenhum arquivo de página > 400 linhas |
| FE-063 | DÍV | P3 | S | Teste e2e (Playwright) do fluxo montar rota → prévia → enviar, contra o backend simulado | Roda no CI com `VITE_DEMO` |
| FE-064 | DÍV | P3 | S | README da raiz ainda descreve Raspberry Pi/câmera; atualizar para a arquitetura vigente (importante para o repositório aberto) | README descreve ESP32 + Cloud Run |

## 3. Ordem sugerida de consumo

1. **Decisões:** FE-001, 002, 003 (e 004 junto).
2. **Higiene rápida:** FE-010, 011, 012, 013, 016. São pequenas, sem dependências e reduzem risco já.
3. **Rede de segurança:** FE-014, 015.
4. **Fundação do cliente:** FE-017, 020, 021, 023, 024, 022.
5. **Fluxo de operação:** FE-030 → 031 → 032 → 033 → 034 → 035 → 036 → 037, em paralelo ao backend.
6. **Cota e custo:** FE-040, 041, 042 antes de ligar o Firestore real.
7. **Segurança de acesso:** FE-050, 051 antes de expor a URL.
8. **Polimento:** Fase 6.

## 4. Evidência do grafo de código (codegraph, 26/10/2026)

Índice: 42 arquivos, 718 símbolos, 1.682 relações. Consultas que confirmam ou refinam itens acima:

| Consulta | Resultado | Item afetado |
|---|---|---|
| `fetch(` fora de `api.ts` (excluindo `demo/`) | Nenhum. `apiRequest` é usado só pelos 6 serviços | Confirma a camada HTTP única; FE-020/021/022/023 mexem num ponto só |
| Chamadores de `acknowledgeAlert` | `Alerts.handleAcknowledge` e `Dashboard.handleAcknowledge` | FE-016: o segundo é o sem tratamento de erro |
| Chamadores de `describeStep` | Só `RoutePlanner` (exibição) | FE-001: a convenção do eixo Y afeta a rotulagem e o desenho do canvas, mas não há lógica de comando no front. Raio de mudança pequeno |
| `currentWaypointIndex` | Só definido em `types/index.ts` e no demo; nunca lido por componente | FE-035: o progresso na malha não existe na UI hoje |
| Chamadores de `submitRoute` / `validateRoute` | Um cada, ambos em `RoutePlanner` | FE-030/032: o fluxo de envio inteiro passa por uma tela |
| `affected` para `routeGrid.ts` | Nenhum teste afetado | FE-014: confirma ausência de testes |
| Compilador (`Lexer`, `Parser`) | Só usados por `compiler/roboflow/__init__.py` e `examples/demo_compilador.py` | CMP-002: nenhum teste, só o script de demonstração |

## 5. Riscos que o backlog assume

- FE-013 (`strict`) pode revelar muitos erros de tipo ocultos; reservar tempo.
- FE-033 e FE-034 exigem que o backend defina antes o estado detalhado de execução e o contrato de comandos assíncronos (`202` + consulta de comando).
- FE-040 muda contrato com o backend; combinar com o desenho de rollups no Firestore.
- Itens de acessibilidade (FE-060) e a maioria das telas não foram auditados linha a linha; a lista acima reflete o que foi lido e executado.
