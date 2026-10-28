import { generateKeyPairSync } from 'node:crypto';

export default function binding() {
 const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
 return JSON.stringify({ appId: '42', installationId: '7', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
}
