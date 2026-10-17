import { withDevIdentity } from '../dev/index.mjs';
import { app, config } from './dev-worker.mjs';

// The seed's served theme and mark, as a real seed's public folder serves them.
const mark = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#0f766e"/></svg>';
const served = {
  '/rer-theme.css': [":root{--rer-page:#fbf7ee;--rer-text:#1c2b2a;--rer-logo:url('/brand/mark.svg')}", 'text/css'],
  '/brand/mark.svg': [mark, 'image/svg+xml'],
  '/no-logo-theme.css': [':root{--rer-page:#fbf7ee;--rer-text:#1c2b2a}', 'text/css'],
};
const withPublicFiles = worker => ({
  async fetch(request, env, execution) {
    const file = served[new URL(request.url).pathname];
    return file ? new Response(file[0], { headers: { 'content-type': file[1] } }) : worker.fetch(request, env, execution);
  },
});

export default withDevIdentity(withPublicFiles(app), { config });
