# Dashboard de Observabilidade — RoboFlow

Interface web para operar uma **frota de AGVs**: a tela inicial reúne os
percursos, paradas, telemetria e falhas de todos os robôs conectados; a barra
lateral abre um robô específico, com o mesmo painel restrito a ele e a tela de
**definição de rota**.

É a camada de visualização do *"logging de telemetria"* previsto na Etapa 4 do
[projeto](../docs/O_QUE_O_ROBO_FAZ.md): os eventos que o veículo gera ao
executar o código compilado a partir da DSL (`stop()`, `signal_light()`,
`wait_signal()`, `resume_line_following()`, leituras `PROX`) são consolidados
aqui em rotas, indicadores e alertas.

```
 DSL .rf  ──► compilador ──► firmware ──► AGV em operação
                                              │
                                              │ eventos / telemetria
                                              ▼
                                      backend REST  ──►  esta dashboard
                                              ▲                │
                                              └── lista de ────┘
                                                  pontos da rota
```

## As duas direções

| Sentido | O que trafega |
| :--- | :--- |
| Robô → dashboard | Telemetria: eventos, missões, alertas, estado e bateria de cada robô |
| Dashboard → robô | A rota: a sequência ordenada de vértices da malha que o robô deve percorrer |

A rota é montada de dois modos, sobre o mesmo estado: clicando os pontos na
malha, ou editando a lista de coordenadas abaixo dela. Ao clicar dois pontos
distantes, a interface preenche o caminho mais curto entre eles sobre os
trilhos, contornando pontos bloqueados — o backend recebe a rota já expandida
passo a passo, com vértices consecutivos sempre adjacentes.

A conversão desses pontos em comandos de tração (`FRENTE`, `ESQUERDA`…) é do
backend / do compilador DSL, que conhece a orientação atual do robô. A interface
não emite direções.

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

A cada push de commits para a branch `main`, o workflow
[`deploy-dashboard.yml`](../.github/workflows/deploy-dashboard.yml) publica em
<https://michelmelog.github.io/Compiladores/dashboard/>.

O deploy é automático para qualquer alteração no repositório, incluindo merges
de pull requests na `main`. Um commit apenas local não dispara a publicação:
é necessário enviá-lo ao GitHub com `git push origin main`.
Também é possível iniciar uma publicação manual pela aba **Actions**, selecionando
o workflow **Publicar dashboard no GitHub Pages** e clicando em **Run workflow**.

O mesmo build também fica disponível na raiz `/Compiladores/`. O workflow
copia o HTML compilado para `dist/dashboard/index.html`, mantendo os assets
compartilhados em `/Compiladores/assets/`.

Como o GitHub Pages serve apenas arquivos estáticos e não há backend hospedado,
**a publicação é um build de demonstração**: o workflow define `VITE_DEMO=true`,
que embute um conjunto de dados fictícios e exibe um aviso permanente no topo da
página.

Esses dados vivem isolados em [`src/demo/`](src/demo/demoBackend.ts) e **não
entram no build normal** — `src/services/` continua sendo apenas cliente HTTP,
sem nenhuma ramificação entre dados reais e de exemplo.

A demonstração traz quatro robôs fictícios, em estados diferentes (em rota,
online, com falha e offline), para exercitar a navegação da frota. As rotas
enviadas e os reconhecimentos de alertas duram apenas até recarregar a página, e
a importação não persiste registros. Os filtros de período, missão,
severidade e busca não são aplicados integralmente pelo backend de exemplo.
Para operar com dados reais, é necessário hospedar o backend separadamente e
gerar um build com `VITE_API_URL` apontando para ele e sem `VITE_DEMO=true`.

## Estrutura

```
dashboard/
├── src/
│   ├── services/      # Única camada de rede; api.ts é o único que usa fetch
│   ├── pages/         # Visão geral, Rota, Missões, Logs, Alertas, Desempenho, Importar
│   ├── components/    # Layout, malha de rota e componentes reutilizáveis
│   ├── types/         # Contrato de dados, espelho do que o backend devolve
│   ├── utils/         # Formatação, parser de logs e geometria da malha (routeGrid.ts)
│   └── demo/          # Dados fictícios da publicação estática (fora do build normal)
└── BACKEND_INTEGRATION.md
```

## Stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · Recharts
