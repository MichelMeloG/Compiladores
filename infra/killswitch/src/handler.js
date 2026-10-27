import { decide, decodePushEnvelope } from './logic.js';

const INTERNAL_ONLY = 'INGRESS_TRAFFIC_INTERNAL_ONLY';

/** Log estruturado: o Cloud Logging lê `severity` e `message` do JSON em stdout. */
export function log(severity, message, extra = {}) {
  process.stdout.write(JSON.stringify({ severity, message, ...extra }) + '\n');
}

/**
 * Cria o handler. `deps` permite injetar fetch e token nos testes.
 *
 * Retornos:
 *  - 204: mensagem tratada (inclui "não cortar" e payload inválido; Pub/Sub não reentrega)
 *  - 500: falha ao chamar a API do Cloud Run (Pub/Sub reentrega com backoff)
 */
export function createHandler({ target, dryRun, fetchFn, getToken }) {
  return async function handle(body) {
    let alert;
    try {
      alert = decodePushEnvelope(body);
    } catch (err) {
      log('ERROR', 'mensagem de orçamento ilegível; ignorada', { error: err.message });
      return { status: 204 };
    }

    const decision = decide(alert);
    if (!decision.cut) {
      log(decision.reason === 'payload inválido' ? 'ERROR' : 'INFO', `sem corte: ${decision.reason}`, {
        threshold: alert?.alertThresholdExceeded,
      });
      return { status: 204 };
    }

    log('WARNING', 'ORÇAMENTO ATINGIDO: bloqueando tráfego público', {
      target,
      dryRun,
      reason: decision.reason,
    });

    if (dryRun) return { status: 204 };

    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const url = `https://run.googleapis.com/v2/${target}`;

      // Idempotência: se já está bloqueado, não repete.
      const current = await fetchFn(url, { headers });
      if (!current.ok) throw new Error(`GET falhou: ${current.status}`);
      const svc = await current.json();
      if (svc.ingress === INTERNAL_ONLY) {
        log('INFO', 'serviço já estava bloqueado', { target });
        return { status: 204 };
      }

      const res = await fetchFn(`${url}?updateMask=ingress`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ingress: INTERNAL_ONLY }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PATCH falhou: ${res.status} ${text.slice(0, 200)}`);
      }
      log('CRITICAL', 'ingress do serviço alterado para internal-only', { target });
      return { status: 204 };
    } catch (err) {
      log('ERROR', 'falha ao bloquear o serviço; será reentregue', { error: err.message });
      return { status: 500 };
    }
  };
}
