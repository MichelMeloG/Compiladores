# ADR 0004 — Convenção de coordenadas e comandos (no fio)

- **Status:** aceito
- **Data:** 26/10/2026
- **Supera:** `backend/README.md` §4 e `docs/PLANO_BACKEND_ROBOFLOW.md` §4, que definiam "x para leste, y para norte".

## Contexto

Os documentos do backend definiam y crescendo para o norte; a dashboard (`routeGrid.ts`, `describeStep`, `RouteGridCanvas`, `BACKEND_INTEGRATION.md` §3.11) usa a origem no canto superior esquerdo com y crescendo para **baixo**. Se a tradução de rota usasse uma convenção e o desenho a outra, esquerda e direita ficariam trocadas. Também havia ambiguidade entre o rumo `E` (leste) e o comando `E` (esquerda).

## Decisão

1. **Coordenadas:** inteiras, 0-indexadas, origem `(0,0)` no canto superior esquerdo; `x` cresce para a direita (leste) e `y` cresce para **baixo** (sul). É o que o frontend e o contrato da dashboard já usam.
2. **Rumos do chassi** (tipo `Heading`: `N | E | S | W`):

   | Rumo | Vetor (dx, dy) |
   |---|---|
   | N | (0, −1) |
   | E | (+1, 0) |
   | S | (0, +1) |
   | W | (−1, 0) |

3. **Comandos** (tipo `Command`: `F | T | D | E`): `F` frente; `D` gira 90° **horário** e avança; `E` gira 90° **anti-horário** e avança; `T` ré até o cruzamento atrás, mantendo o rumo. Cada comando termina no próximo cruzamento.
4. **`Heading` e `Command` são tipos distintos** no código. `E` como rumo significa leste; `E` como comando significa esquerda. Nenhuma função aceita um no lugar do outro.
5. **Identificador de nó:** `"x,y"` (mesmo formato de `Robot.currentPoint`). `expectedNodes` do `load_route` usa esse formato.
6. **Algoritmo** (`translateRoute` em `@roboflow/contracts`): `diff = (índice(rumo desejado) − índice(rumo atual) + 4) mod 4`; 0 → `F`; 1 → `D`; 3 → `E`; 2 → `T`.

Exemplo (y para baixo): de `(0,3)` para `(0,2)`, `(1,2)`, `(1,1)` partindo de `N` gera `F, D, E`.

## Consequências

- O frontend não muda: `describeStep` já chama o `y` menor de "Norte".
- `backend/README.md` §4–§5 e `PLANO_BACKEND_ROBOFLOW.md` §4–§5 devem ser atualizados para esta convenção (exemplo numérico incluído).
- O firmware recebe só `actions` e `initialHeading`; nunca precisa interpretar coordenadas.
- A mesma função pura roda no navegador, no backend e no simulador, e um teste de ida e volta (`simulateActions`) garante que a fila reproduz a rota.
