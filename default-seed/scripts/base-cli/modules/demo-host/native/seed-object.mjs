import { env } from 'cloudflare:workers';

// Facets have SQLite and WebSockets but no native alarms. Keep the seed's
// original context (including native methods) and replace only the alarm API.
export function seedObject(Original, binding) {
  return class extends Original {
    constructor(ctx, bindings) {
      const call = (method, at) => env.RER_NATIVE_HOST.seedAlarm(binding, ctx.id.toString(), method, at);
      ctx.storage.setAlarm = at => call('set', at instanceof Date ? at.getTime() : at);
      ctx.storage.getAlarm = () => call('get');
      ctx.storage.deleteAlarm = () => call('delete');
      super(ctx, bindings);
    }
    async fetch(request) {
      if (request.headers.get('x-rer-native-alarm-key') === env.RER_NATIVE_KEY) {
        await super.alarm(JSON.parse(request.headers.get('x-rer-native-alarm-info')));
        return new Response(null, { status: 204 });
      }
      return super.fetch(request);
    }
  };
}
