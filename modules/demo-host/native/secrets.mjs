// Hosted demos opt in by name. Only the existing SETUP generator encodings
// are supported; every value uses its own fresh 32 bytes of system entropy.
const CORE = new Set(['SESSION_SECRET', 'INSTALLATION_KEY', 'SETUP_TOKEN', 'OWNER_EMAIL']);
export function generatedSecrets(value = [], occupied = []) {
  if (!Array.isArray(value)) throw new Error('invalid-demo-generated-secrets: expected a list of {name, generate}');
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
      !Object.hasOwn(item, 'name') || !Object.hasOwn(item, 'generate') ||
      typeof item.name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.name) || !['hex', 'base64'].includes(item.generate)) {
      throw new Error('invalid-demo-generated-secrets: each entry needs a name (1-64 uppercase letters, digits or underscores) and generate (hex or base64)');
    }
    if (item.name.startsWith('RER_') || CORE.has(item.name) || occupied.includes(item.name)) throw new Error(`invalid-demo-generated-secrets: reserved or occupied name ${item.name}`);
    if (seen.has(item.name)) throw new Error(`invalid-demo-generated-secrets: duplicate name ${item.name}`);
    seen.add(item.name);
    return { name: item.name, generate: item.generate };
  });
}

export function visitorSecrets(declarations) {
  return Object.fromEntries(declarations.map(({ name, generate }) => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return [name, generate === 'hex' ? [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') : btoa(String.fromCharCode(...bytes))];
  }));
}
