import type { TimeBillingConformanceAdapter, TimeBillingConformanceRuntime } from '../conformance/index.mjs';
export function openTimeBillingRuntime(options: Parameters<TimeBillingConformanceAdapter['open']>[0]): Promise<TimeBillingConformanceRuntime>;
