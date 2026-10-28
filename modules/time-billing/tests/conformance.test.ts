import { test } from 'node:test';
import { registerTimeBillingConformance } from '../conformance/index.mjs';
import { openTimeBillingRuntime } from './runtime.mjs';
import { profiles } from './profiles.ts';

registerTimeBillingConformance({ test, adapter: { profiles, open: openTimeBillingRuntime } });
