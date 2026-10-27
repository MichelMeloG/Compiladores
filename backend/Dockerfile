# syntax=docker/dockerfile:1
#
# Imagem do backend (Cloud Run). O CONTEXTO DE BUILD É A RAIZ DO REPOSITÓRIO,
# porque o backend depende do pacote local ../contracts:
#
#   docker build -f backend/Dockerfile -t roboflow-api .
#
# O arquivo backend/Dockerfile.dockerignore (BuildKit) limita o contexto.
# Não há node_modules na raiz: tudo é instalado dentro das pastas dos pacotes.

# ---------------------------------------------------------------- build
FROM node:22-slim AS build
WORKDIR /app

# 1) contracts: dependências (camada em cache), código, build, só produção
COPY contracts/package.json contracts/package-lock.json ./contracts/
RUN npm --prefix contracts ci --ignore-scripts
COPY contracts ./contracts
# (as devDependencies de contracts ficam até o fim: o `npm ci` do backend dispara o `prepare` dele)
RUN npm --prefix contracts run build

# 2) backend: dependências (o link file:../contracts aponta para /app/contracts)
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci --ignore-scripts
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src ./backend/src
COPY backend/tools ./backend/tools
RUN npm --prefix backend run build \
 && npm --prefix backend prune --omit=dev --ignore-scripts \
 && npm --prefix contracts prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------- runtime
# Sem shell, sem gerenciador de pacotes, usuário não-root.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
ENV NODE_ENV=production PORT=8080
WORKDIR /app/backend

# Mesma disposição de pastas do build: node_modules/@roboflow/contracts -> ../../../contracts
COPY --from=build --chown=nonroot:nonroot /app/contracts /app/contracts
COPY --from=build --chown=nonroot:nonroot /app/backend/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/backend/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/backend/package.json ./package.json

EXPOSE 8080
USER nonroot
CMD ["dist/src/main.js"]
