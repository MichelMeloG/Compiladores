# Operação da PoC (uso pontual, até ~5 demonstrações)

Princípio: **a API fica fechada (ingress `internal`) o tempo todo** e só abre durante a demo. Fechada, não há superfície
de ataque, nem tráfego, nem custo. O dashboard estático (`https://compiladores-512823.web.app`) fica sempre no ar (CDN, sem custo relevante).

## Antes da demo
```powershell
.\infra\scripts\demo.ps1 on            # abre a API (ou: on -AutoOff -Minutes 90, ver cabeçalho do script)
```
1. Abra o dashboard e entre com Google (só e-mails em `ALLOWED_OPERATOR_EMAILS`).
2. Ligue o carrinho (Wi-Fi + HTTPS). Ele faz `hello` e aparece online.
3. Sem hardware? Simulador: `cd backend; $env:DEVICE_SECRET=...; npm run esp-sim -- --url https://roboflow-api-483331439325.us-central1.run.app --device RB-04`.

## Depois da demo
```powershell
.\infra\scripts\demo.ps1 off
```
Cache: respostas de erro do Cloud Run quando fechado não são cacheadas pelo dashboard (`/api/**` é `no-store`).

## O que protege a conta (camadas, todas gratuitas)
- Ingress fechado fora da demo; `max-instances=2`, concorrência 30, `min=0` (escala a zero).
- Limite por IP (180/min) e bloqueio por falhas de assinatura (10/min) **antes** de tocar no Firestore; HMAC por dispositivo; Firebase ID token + allowlist de e-mails para operadores.
- `/device/sensors` (legado) desligado. Poll ocioso do carro a cada 15 s (≈5,8k leituras/dia, só se estiver ligado e a API aberta).
- Orçamento R$ 5 + kill-switch (fecha o ingress sozinho se estourar).
- Segredos dos robôs no Secret Manager (`roboflow-device-secrets`); cópia local em `%USERPROFILE%\.roboflow-device-secrets.json` (fora do git).

## Publicar nova versão
- Backend: `.\infra\scripts\build-and-deploy.ps1` (mantém o ingress atual; o `gcloud run deploy` não o altera).
- Dashboard: `cd dashboard; npm run build; cd ..; .\infra\scripts\deploy-hosting.ps1`.
- Girar segredo: `gcloud secrets versions add roboflow-device-secrets --data-file=...` e redeploy/nova revisão (`latest`).
