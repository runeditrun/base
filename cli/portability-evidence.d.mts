import type { Plugin } from 'vite';
import type { MigrationEvidence } from '../modules/portability/worker-history.mjs';
export function generateMigrationEvidence(root:string,options?:{binding?:string}):Promise<MigrationEvidence>;
/** Seed opt-in: generates the server-only virtual:rer-legacy-migration-evidence module. */
export function legacyMigrationEvidence(options?:{binding?:string}):Plugin;
