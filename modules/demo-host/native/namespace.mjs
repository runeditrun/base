import { createHash } from 'node:crypto';

class Id {
  constructor(value, name) { this.value = value; this.name = name; }
  toString() { return this.value; }
  equals(other) { return this.value === other.toString(); }
}
export class DemoNamespace {
  constructor(host, binding, key) { this.host = host; this.binding = binding; this.key = key; }
  idFromName(name) { return new Id(createHash('sha256').update(`${this.binding}:${name}`).digest('hex'), name); }
  idFromString(value) {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new TypeError('Invalid Durable Object id');
    return new Id(value.toLowerCase());
  }
  newUniqueId() { return new Id([...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')); }
  jurisdiction() { return this; }
  getByName(name, options) { return this.get(this.idFromName(name), options); }
  get(id) {
    const host = this.host, binding = this.binding, key = this.key, value = this.idFromString(id.toString());
    return new Proxy({ id, name: id.name }, { get(target, method) {
      if (method in target) return target[method];
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async (...args) => {
        if (method === 'fetch') {
          const request = args[0] instanceof Request ? args[0] : new Request(...args);
          const headers = new Headers(request.headers);
          headers.set('x-rer-native-object', `${binding}:${value}`);
          headers.set('x-rer-native-key', key);
          return host.fetch(new Request(request, { headers }));
        }
        return host.object(binding, value.toString(), method, args);
      };
    } });
  }
}
