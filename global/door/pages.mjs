// The door's own small pages: the index, starting, start button, failure and
// unknown-name pages. Plain HTML; the starting page polls the door's state
// path (a fetch, which never starts a site) and reloads, keeping the fragment.
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const style = `:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1b;--muted:#666;--line:#ddd;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--muted:#a3a39d;--line:#333;--accent:#8fb0ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px}h1{font-size:20px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;margin:20px 0}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
a{color:var(--accent)}code{font:13px ui-monospace,monospace}button{font:inherit;padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}
pre{white-space:pre-wrap;background:rgba(127,127,127,.12);padding:12px;border-radius:6px;font:13px ui-monospace,monospace}`;

function page(title, body, { script = '' } = {}) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><title>${escape(title)}</title><style>${style}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

export const rebootNote = 'After a reboot or logout the front door needs <code>rer door start</code> (or any <code>rer dev</code> in a door-mode checkout).';

export function indexPage({ port, version, sites }) {
 const rows = sites.map(site => {
  const link = site.mode === 'door' || site.state !== 'running' ? site.doorUrl : site.url;
  const direct = site.mode === 'direct' ? ` <span class="muted">direct${site.url && site.url !== site.doorUrl ? `: <a href="${escape(site.url)}">${escape(site.url)}</a>` : ''}</span>` : '';
  return `<tr><td><a href="${escape(link)}/">${escape(site.name)}</a>${direct}</td><td>${escape(site.state)}</td><td class="muted"><code>${escape(site.path)}</code></td></tr>`;
 }).join('');
 return page('rer front door', `<h1>rer front door</h1><p class="muted">Port ${port} · rer ${escape(version)}. A site starts when you open it and stops when idle.</p>
${sites.length ? `<table><thead><tr><th>Site</th><th>State</th><th>Checkout</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No checkouts are registered. Add one with <code>rer door add PATH</code>.</p>'}
<p class="muted">Add a checkout with <code>rer door add PATH</code>; see sign-in links with <code>rer door status --links</code>. ${rebootNote}</p>`);
}

const poll = `const fragment=location.hash;async function check(){try{const r=await fetch('/__rer/door/state',{cache:'no-store'});const s=await r.json();
if(s.state==='running'){if(s.redirect){location.replace(s.redirect+location.pathname+location.search+fragment);}else{location.reload();}return;}
if(s.state==='failed'){document.getElementById('status').textContent='The site could not start:';const p=document.getElementById('reason');p.textContent=s.reason;p.hidden=false;return;}}catch{}setTimeout(check,1000);}check();`;

export function startingPage(name) {
 return page(`Starting ${name}`, `<h1>Starting ${escape(name)}…</h1><p id="status" class="muted">This page reloads when the site is ready. A first start can take a minute.</p><pre id="reason" hidden></pre>`, { script: poll });
}

export function confirmPage(name, to) {
 return page(`Start ${name}?`, `<h1>${escape(name)} is not running</h1><p>Another site sent you here. Start it?</p><form method="post" action="/__rer/door/start?to=${encodeURIComponent(to)}"><button type="submit">Start ${escape(name)}</button></form>`);
}

export function failurePage(name, reason, to) {
 return page(`${name} could not start`, `<h1>${escape(name)} could not start</h1><pre>${escape(reason)}</pre><form method="post" action="/__rer/door/start?to=${encodeURIComponent(to)}"><button type="submit">Try again</button></form>`);
}

export function unknownPage(name, port) {
 return page('No such site', `<h1>No checkout is registered as ${escape(name)}</h1><p>Register a checkout with <code>rer door add PATH</code>, then open <code>http://NAME.localhost:${port}</code>. <a href="http://localhost:${port}/">All sites</a>.</p>`);
}
