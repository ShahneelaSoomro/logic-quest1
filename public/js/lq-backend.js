/*
 * Logic Quest backend adapter.
 * The game was written against a tiny `claude.use("user" | "db" | "downloads")` API that only exists
 * inside Claude artifacts. This file provides the same interface backed by this project's REST API,
 * so the game code in index.html works unchanged. If a real `window.claude` already exists, it is left alone.
 */
(function () {
  'use strict';
  if (typeof window.claude !== 'undefined') return;

  // Backend URL comes from js/config.js. "" = same origin (server.js serves the game). null/"" on github.io = no backend.
  const BASE = (window.LQ_API_BASE || '').replace(/\/+$/, '');
  const NO_BACKEND = !BASE && /\.github\.io$/.test(location.hostname);
  const TK = 'lq_token';
  const getTok = () => { try { return localStorage.getItem(TK); } catch (e) { return null; } };
  async function api(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'X-LQ': '1' };
    const tok = getTok(); if (tok) headers.Authorization = 'Bearer ' + tok;
    const r = await fetch(BASE + url, { method, headers, credentials: BASE ? 'omit' : 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(method + ' ' + url + ' -> ' + r.status);
    return r.json();
  }

  const snap = (id, data) => ({ id, data: () => data });

  function collection(name) {
    return {
      async get() { const j = await api('GET', '/api/c/' + name); return { docs: j.items.map((i) => snap(i.id, i.data)) }; },
      doc: (id) => ({
        set: (data) => api('PUT', '/api/c/' + name + '/' + encodeURIComponent(id), data),
        delete: () => api('DELETE', '/api/c/' + name + '/' + encodeURIComponent(id)),
      }),
    };
  }

  const profileRef = {
    async get() { const j = await api('GET', '/api/profile'); return { exists: j.exists, data: () => j.data }; },
    set: (data) => api('PUT', '/api/profile', data),
    collection,
  };

  const services = {
    // Resolves to a guest-account id. If the API is unreachable (e.g. file:// or offline) id() returns null
    // and the game transparently falls back to localStorage.
    async user() {
      let id = null;
      if (!NO_BACKEND) {
        try {
          const j = await api('POST', '/api/session');
          id = j.id;
          if (j.token) { try { localStorage.setItem(TK, j.token); } catch (e) {} }
        } catch (e) { /* offline -> local only */ }
      }
      return { id: async () => id };
    },
    async db() { return { doc: () => profileRef }; }, // game asks for "data/users/<id>/profile"; the server scopes by session cookie
    async downloads() {
      return {
        async save({ filename, data }) {
          const url = URL.createObjectURL(data);
          const a = document.createElement('a');
          a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        },
      };
    },
  };

  window.claude = { use: async (name) => { if (!services[name]) throw new Error('Unknown service: ' + name); return services[name](); } };
})();
