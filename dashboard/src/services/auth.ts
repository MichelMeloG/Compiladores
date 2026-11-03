import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';

// Firebase web configuration is public. Device secrets never belong here.
const apiKey = import.meta.env?.VITE_FIREBASE_API_KEY as string | undefined;
export const auth = apiKey ? getAuth(initializeApp({
  apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})) : null;

export async function login() {
  if (!auth) throw new Error('Login indisponível. Contate o responsável pelo sistema.');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(auth, provider);
}

export async function logout() {
  if (auth) await signOut(auth);
}

export async function idToken(): Promise<string | undefined> {
  return auth?.currentUser?.getIdToken();
}
