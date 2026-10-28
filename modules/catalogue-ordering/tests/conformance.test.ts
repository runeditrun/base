import { test } from 'node:test';
import { registerCatalogueOrderingConformance } from '../conformance/index.mjs';
import { runtime, supportedProfiles } from './runtime.mjs';

registerCatalogueOrderingConformance({ test, adapter: { profiles: supportedProfiles, open: runtime } });
