// Constants the demo front Worker imports at runtime. Build-time planning (config.mjs) stays
// out of the front's module graph.
// Hashed build output: served immutable, and what the start page may prefetch.
export const hashedAsset = (assetsDir = 'assets') => new RegExp(`^/${assetsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*-[\\w-]{8,}\\.[\\w]+$`);
export const HASHED_ASSET = hashedAsset();
// Export one wrapper per binding, including when several bindings share a class.
export const objectClass = binding => `RerSeed_${binding}`;
