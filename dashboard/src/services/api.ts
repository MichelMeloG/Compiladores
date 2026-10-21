/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApiResponse } from '../types';

/**
 * URL base do backend REST, configurada em `VITE_API_URL` (.env).
 * O padrão `/api` assume que o backend é servido na mesma origem
 * (ou via proxy reverso / `server.proxy` do Vite).
 */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string) || '/api';

/** Tempo máximo de espera por resposta do backend, em milissegundos. */
export const REQUEST_TIMEOUT_MS = 10000;

export class ApiError extends Error {
  /** Status HTTP, ou 0 quando a requisição nem chegou ao servidor. */
  status: number;
  data?: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }

  /** True quando o backend está inacessível (offline, DNS, CORS, timeout). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/**
 * Helper central de requisições HTTP.
 *
 * Toda comunicação com o backend passa por aqui — é o único ponto do
 * frontend que conhece `fetch`.
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;

  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type');
    const isJson = contentType !== null && contentType.includes('application/json');
    const data = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      throw new ApiError(
        (isJson && data?.message) ||
          `O servidor respondeu com erro ${response.status}.`,
        response.status,
        data
      );
    }

    // Aceita tanto o envelope `{ success, data }` quanto a carga crua.
    if (data && typeof data === 'object' && 'data' in data) {
      return data as ApiResponse<T>;
    }

    return { success: true, data: data as T };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }

    // A mensagem é exibida direto ao operador: sem URL nem jargão de rede.
    // O diagnóstico técnico fica no DevTools / console do navegador.
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `O servidor demorou mais de ${REQUEST_TIMEOUT_MS / 1000}s para responder.`
        : 'Sem resposta do servidor de dados.';

    throw new ApiError(message, 0);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Converte um erro qualquer em mensagem legível para a interface.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Erro inesperado ao consultar o backend.';
}
