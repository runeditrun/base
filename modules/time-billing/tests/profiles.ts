import type { CapturePolicy } from '../types.ts';
import type { TimeBillingProfile } from '../conformance/index.mjs';

export const policies: readonly CapturePolicy[] = [
  {
    id: 'reviewed', revision: '1', review: 'required', rateStage: 'approval', manual: { incrementMs: '1', mode: 'exact' },
    timer: { rounding: { incrementMs: '1000', mode: 'half-up' }, dateBasis: 'stop', overlap: 'person' },
    billing: { rounding: { incrementMs: '360000', mode: 'ceil' }, money: 'half-up' },
  },
  {
    id: 'manual-invoice', revision: '1', review: 'none', rateStage: 'invoice',
    manual: { incrementMs: '60000', mode: 'half-up' }, timer: null,
    billing: { rounding: { incrementMs: '3600', mode: 'half-up' }, money: 'half-up' },
  },
];
export const profiles: readonly TimeBillingProfile[] = [
  { id: 'reviewed', policyId: 'reviewed', review: true, timer: true, billing: true, sample: { capturedMs: '36000', billedMs: '360000', at12500: '1250', at20000: '2000' } },
  { id: 'manual-invoice', policyId: 'manual-invoice', review: false, timer: false, billing: true, sample: { capturedMs: '60000', billedMs: '61200', at12500: '213', at20000: '340' } },
];
