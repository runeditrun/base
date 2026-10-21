// Base-owned policy. The provider counter is local and eventually consistent,
// not an account-wide spend cap. Keep deployment metadata and runtime in sync.
export const searchPolicy = Object.freeze({ limit: 10, period: 60, cacheSeconds: 60, maxPending: 64 });
