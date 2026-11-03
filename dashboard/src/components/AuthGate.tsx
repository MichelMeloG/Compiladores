import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, login, logout } from '../services/auth';
import { apiRequest, ApiError } from '../services/api';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!auth) { setLoading(false); return; }
    let active = true;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(auth, async (next) => {
      const current = ++generation;
      setUser(next); setAllowed(false); setError(''); setLoading(true);
      try {
        if (next) {
          // Let the backend validate the verified email and operator allowlist.
          await apiRequest('robots');
          if (active && current === generation) setAllowed(true);
        }
      } catch (err) {
        if (active && current === generation) setError(err instanceof ApiError && err.status === 403
          ? 'Esta conta não tem acesso. Entre com uma conta autorizada pela equipe.'
          : 'Não foi possível validar seu acesso. Tente entrar novamente.');
      } finally {
        if (active && current === generation) setLoading(false);
      }
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const enter = async () => {
    setSigningIn(true); setError('');
    try { await login(); }
    catch (err) {
      const code = (err as { code?: string }).code;
      setError(code === 'auth/popup-blocked'
        ? 'Permita a janela de login no navegador e tente novamente.'
        : code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request'
          ? 'Login cancelado. Você pode tentar novamente.'
          : 'Não foi possível entrar com o Google. Tente novamente.');
    } finally { setSigningIn(false); }
  };
  const leave = async () => {
    try { await logout(); }
    catch { setError('Não foi possível sair. Tente novamente.'); }
  };

  if (allowed && user) return <>
    <div className="flex flex-wrap items-center justify-end gap-3 bg-white px-5 py-2 text-sm text-[#25372D] border-b border-[#E4ECE6]">
      <span>{user.email}</span>
      <button onClick={leave} className="underline">Sair</button>
    </div>
    {children}
  </>;

  return <main className="min-h-screen flex items-center justify-center bg-[#F7FAF8] p-6">
    <section className="w-full max-w-md rounded-2xl border border-[#E4ECE6] bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold text-[#25372D]">RoboFlow</h1>
      <p className="mt-3 text-sm text-[#66766C]">Entre com a conta Google autorizada para acompanhar os robôs e operar as rotas.</p>
      {loading ? <p role="status" className="mt-6">Verificando acesso…</p> : <>
        {user && <p className="mt-4 text-sm">Conta: {user.email}</p>}
        {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
        {auth ? <button onClick={user ? leave : enter} disabled={signingIn}
          className="mt-6 w-full rounded-lg bg-[#25372D] px-4 py-3 text-white disabled:opacity-60">
          {user ? 'Sair e trocar de conta' : signingIn ? 'Entrando…' : 'Entrar com Google'}
        </button> : <p role="alert" className="mt-6 text-sm text-red-700">Login indisponível. Contate o responsável pelo sistema.</p>}
      </>}
    </section>
  </main>;
}
