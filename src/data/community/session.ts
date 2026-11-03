/*
 * Community session: sign-in with an existing account, in the system browser.
 *
 * The app makes a PKCE verifier and opens the server's sign-in page; the
 * browser comes back with a one-time code — to the app's loopback address on
 * the desktop (src-tauri/src/community.rs), to public/community-auth.html in
 * a pop-up on the web — and the app trades code + verifier for a session
 * token. The token is kept in the system's credential store on the desktop,
 * in the browser's storage on the web.
 */
import { createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../../bindings";
import * as kv from "../kv";
import { COMMUNITY_URL, api, request, setApiToken, setUnauthorizedHandler, type Me } from "./api";

const WEB = import.meta.env.MODE === "web";
const WEB_TOKEN_KEY = "ot:community:token";

const [me, setMe] = createSignal<Me | null>(null);
const [ready, setReady] = createSignal(false);
const [signingIn, setSigningIn] = createSignal(false);
/** The signed-in account (null: signed out), once `initSession` settled. */
export { me, ready, signingIn };

export const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub", discord: "Discord", dev: "Test account" };

function randomString(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readToken(): Promise<string | null> {
  if (WEB) return kv.getItem(WEB_TOKEN_KEY);
  return commands.communityTokenGet().catch(() => null);
}

async function saveToken(token: string | null): Promise<void> {
  setApiToken(token);
  if (WEB) {
    if (token) kv.setItem(WEB_TOKEN_KEY, token);
    else kv.removeItem(WEB_TOKEN_KEY);
    return;
  }
  const r = await commands.communityTokenSet(token);
  if (r.status === "error") console.warn("[community] session kept until the app closes:", r.error);
}

setUnauthorizedHandler(() => {
  void saveToken(null);
  setMe(null);
});

let initStarted = false;
/** Restores the saved session (once). */
export async function initSession(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  const token = await readToken();
  if (token) {
    setApiToken(token);
    await refreshMe().catch(() => {});
  }
  setReady(true);
}

export async function refreshMe(): Promise<void> {
  setMe(await api.me());
}

// ── The browser's return ────────────────────────────────────────────────

let cancelWeb: (() => void) | null = null;

/** Desktop: the loopback address and a wait for the browser's query. */
async function desktopReturn(): Promise<{ redirect: string; query: () => Promise<string> }> {
  const port = await commands.communityAuthListen();
  if (port.status === "error") throw new Error(port.error);
  return {
    redirect: `http://127.0.0.1:${port.data}/community-auth`,
    query: async () => {
      const r = await commands.communityAuthWait();
      if (r.status === "error") throw new Error(r.error);
      return r.data;
    },
  };
}

/** Web: a pop-up that posts the query back (public/community-auth.html). */
function webReturn(): { redirect: string; open: (url: string) => Promise<string> } {
  return {
    redirect: `${location.origin}/community-auth.html`,
    open: (url) =>
      new Promise<string>((resolve, reject) => {
        const popup = window.open(url, "ot-community-auth", "width=520,height=700");
        if (!popup) return reject(new Error("The browser blocked the sign-in window."));
        const done = () => {
          window.removeEventListener("message", onMessage);
          clearInterval(timer);
          cancelWeb = null;
        };
        const onMessage = (e: MessageEvent) => {
          if (e.origin !== location.origin || e.data?.type !== "community-auth") return;
          done();
          resolve(String(e.data.query ?? ""));
        };
        const timer = setInterval(() => {
          if (popup.closed) {
            done();
            reject(new Error("cancelled"));
          }
        }, 500);
        cancelWeb = () => {
          popup.close();
          done();
          reject(new Error("cancelled"));
        };
        window.addEventListener("message", onMessage);
      }),
  };
}

/** Signs in with `provider`. Rejects with "cancelled" when the user gave up. */
export async function signIn(provider: string): Promise<void> {
  if (signingIn()) return;
  setSigningIn(true);
  try {
    const state = randomString();
    const verifier = randomString();
    const challenge = await challengeOf(verifier);
    const start = (redirect: string) =>
      `${COMMUNITY_URL}/auth/start?` + new URLSearchParams({ provider, state, challenge, redirect }).toString();
    let query: string;
    if (WEB) {
      const w = webReturn();
      query = await w.open(start(w.redirect));
    } else {
      const d = await desktopReturn();
      await openUrl(start(d.redirect));
      query = await d.query();
    }
    const params = new URLSearchParams(query);
    if (params.get("state") !== state) throw new Error("The sign-in answer doesn't match. Try again.");
    const code = params.get("code");
    if (!code) throw new Error(params.get("error") === "access_denied" ? "cancelled" : "The sign-in did not complete.");
    const { token } = await request<{ token: string }>("POST", "/auth/token", { code, verifier });
    await saveToken(token);
    await refreshMe();
  } finally {
    setSigningIn(false);
  }
}

export function cancelSignIn(): void {
  if (WEB) cancelWeb?.();
  else void commands.communityAuthCancel();
}

export async function signOut(): Promise<void> {
  await api.logout().catch(() => {});
  await saveToken(null);
  setMe(null);
}

/** Deletes the account on the server, then signs out here. */
export async function deleteAccount(): Promise<void> {
  await api.deleteAccount();
  await saveToken(null);
  setMe(null);
}
