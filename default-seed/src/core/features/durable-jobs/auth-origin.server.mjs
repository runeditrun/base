import { requireOrigin } from '../../../../../modules/operator-auth/http.mjs';

export function validSalesOrigin(request, config, mutation) {
  try { requireOrigin(request, config); } catch { return false; }
  return !mutation || (request.headers.get('origin') === config.origin && request.headers.get('sec-fetch-site') !== 'cross-site');
}
