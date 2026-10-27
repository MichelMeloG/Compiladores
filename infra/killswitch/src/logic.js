/**
 * Lógica pura do kill-switch. Sem I/O, para ser testável.
 *
 * Mensagem de orçamento (Pub/Sub, schema 1.0), campos usados:
 *   costAmount, budgetAmount, alertThresholdExceeded, budgetDisplayName
 */

/** Decodifica o envelope de push do Pub/Sub. Lança Error se inválido. */
export function decodePushEnvelope(body) {
  const data = body?.message?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('envelope sem message.data');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    throw new Error('message.data não é JSON base64 válido');
  }
  return parsed;
}

/**
 * Decide se deve cortar. Só corta quando custo >= orçamento, ambos numéricos
 * e finitos, e o orçamento é positivo. Qualquer dado estranho => não corta
 * (o erro é registrado pelo chamador), para não derrubar o serviço por engano.
 */
export function decide(alert) {
  const cost = Number(alert?.costAmount);
  const budget = Number(alert?.budgetAmount);

  if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) {
    return { cut: false, reason: 'payload inválido' };
  }
  if (cost >= budget) {
    return { cut: true, reason: `custo ${cost} >= orçamento ${budget}` };
  }
  return { cut: false, reason: `custo ${cost} < orçamento ${budget}` };
}

/** Nome do recurso do serviço alvo, validado para evitar PATCH em outro lugar. */
export function validateTarget(name) {
  const re = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/services\/[a-z][a-z0-9-]{0,48}[a-z0-9]$/;
  if (typeof name !== 'string' || !re.test(name)) {
    throw new Error('TARGET_SERVICE inválido');
  }
  return name;
}
