import { providerSecrets } from './policy.mjs';
// Names only, and only names required by this proof. The evidence credential is
// checked by the independent writer; this process must never receive it.
for (const name of providerSecrets) if (process.env[name]?.trim()) console.log(name);
if (providerSecrets.some(name => !process.env[name]?.trim())) process.exitCode = 1;
