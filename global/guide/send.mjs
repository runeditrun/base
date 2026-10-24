// Best-effort delivery of guide events. A launch never waits for this, never
// reads what comes back and never retries: each post has two seconds, events go
// one after another so they arrive in order, and the first failure of any kind
// (offline, a server that is not live yet, 404, 429, a timeout, a bad answer)
// ends this launch's posting. Nothing about a post is written anywhere.
import { setTimeout as delay } from 'node:timers/promises';
import { originUrl } from '../../cli/business/api.mjs';

export const postTimeout = 2000;
// How long a command that is about to exit waits for events still on their way.
export const exitGrace = 500;

// The platform origin Business pairing already uses; RER_GUIDE_ORIGIN points it
// at another platform (a stage or a local test server).
export function guideOrigin(env = process.env) {
 try { return originUrl(env.RER_GUIDE_ORIGIN || undefined); } catch { return undefined; }
}

export function createSender(code, env = process.env) {
 const origin = guideOrigin(env), controller = new AbortController();
 let chain = Promise.resolve(), stopped = origin === undefined;
 return {
  send(event) {
   if (stopped) return;
   const body = JSON.stringify(event);
   chain = chain.then(async () => {
    if (stopped) return;
    try {
     const response = await fetch(`${origin}/api/run-guides/${code}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(postTimeout)]) });
     await response.body?.cancel();
     if (!response.ok) stopped = true;
    } catch { stopped = true; }
   });
  },
  // Wait for what is queued up to `grace`, then cut anything still open so the
  // process can exit.
  async settle(grace = exitGrace) {
   const timer = new AbortController();
   await Promise.race([chain, delay(grace, undefined, { signal: timer.signal }).catch(() => {})]);
   timer.abort();
   stopped = true;
   controller.abort();
  },
 };
}
