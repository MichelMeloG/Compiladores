/**
 * Janela deslizante simples, por chave, em memória da instância.
 * Limitação assumida: com várias instâncias o limite efetivo é por instância;
 * o teto real de abuso é `max-instances` do Cloud Run + orçamento.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Retorna true se a requisição pode seguir. */
  allow(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.prune(t);
    return true;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) {
      if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
  }
}
