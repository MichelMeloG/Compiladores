# Dashboard de Observabilidade — RoboFlow

Interface web para acompanhar as rotas executadas pelo AGV: percursos entre
estações, paradas, telemetria e falhas.

É a camada de visualização do *"logging de telemetria"* previsto na Etapa 4 do
[projeto](../docs/projeto/PROJETO_ROBO.md): os eventos que o veículo gera ao
executar o código compilado a partir da DSL (`stop()`, `signal_light()`,
`wait_signal()`, `resume_line_following()`, leituras `PROX`) são consolidados
aqui em rotas, indicadores e alertas.

```
 DSL .rf  ──► compilador ──► firmware ──► AGV em operação
                                              │
                                              │ eventos / telemetria
                                              ▼
                                      backend REST  ──►  esta dashboard
```

## Estado atual

A dashboard está **pronta e não possui dados próprios** — ela obtém tudo de um
backend REST que **ainda não foi implementado**.

O contrato que esse backend precisa cumprir está especificado em
**[BACKEND_INTEGRATION.md](BACKEND_INTEGRATION.md)**: endpoints, formatos de
resposta, valores aceitos e checklist de implementação.

Enquanto o backend não existir, a interface exibe *"Não foi possível carregar os
dados"* com opção de tentar novamente — esse é o comportamento esperado.

## Executando

```bash
cd dashboard
npm install
npm run dev          # http://localhost:3000
```

Configure o endereço do backend em `.env` (copie de `.env.example`):

```env
VITE_API_URL="http://localhost:8080/api"
```

Outros comandos:

```bash
npm run lint         # checagem de tipos (tsc --noEmit)
npm run build        # build de produção em dist/
```

## Publicação

Em **Settings → Pages → Build and deployment → Source**, selecione
**GitHub Actions**. O workflow usa Node.js 24, instala o lockfile com `npm ci`,
valida os tipos e publica apenas a pasta `dashboard/dist`.

A cada alteração nesta pasta na branch `main`, o workflow
[`deploy-dashboard.yml`](../.github/workflows/deploy-dashboard.yml) publica em
<https://michelmelog.github.io/Compiladores/>.

Como o GitHub Pages serve apenas arquivos estáticos e não há backend hospedado,
**a publicação é um build de demonstração**: o workflow define `VITE_DEMO=true`,
que embute um conjunto de dados fictícios e exibe um aviso permanente no topo da
página.

Esses dados vivem isolados em [`src/demo/`](src/demo/demoBackend.ts) e **não
entram no build normal** — `src/services/` continua sendo apenas cliente HTTP,
sem nenhuma ramificação entre dados reais e de exemplo.

Na demonstração, a importação não persiste registros e os reconhecimentos de
alertas duram apenas até recarregar a página. Os filtros de período, missão,
severidade e busca não são aplicados integralmente pelo backend de exemplo.
Para operar com dados reais, é necessário hospedar o backend separadamente e
gerar um build com `VITE_API_URL` apontando para ele e sem `VITE_DEMO=true`.

## Estrutura

```
dashboard/
├── src/
│   ├── services/      # Única camada de rede; api.ts é o único que usa fetch
│   ├── pages/         # Visão geral, Missões, Logs, Alertas, Desempenho, Importar
│   ├── components/    # Layout e componentes reutilizáveis
│   ├── types/         # Contrato de dados, espelho do que o backend devolve
│   ├── utils/         # Formatação e parser de arquivos de log
│   └── demo/          # Dados fictícios da publicação estática (fora do build normal)
└── BACKEND_INTEGRATION.md
```

## Stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · Recharts
