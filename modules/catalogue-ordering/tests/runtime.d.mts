import type { Database, ExportArtifact, Result } from '../types.ts';
import type { CatalogueConformanceRuntime, ConformanceProfile, RecoveryInspection } from '../conformance/index.mjs';

export const supportedProfiles: readonly ConformanceProfile[];
export interface NativeFixtureRuntime extends CatalogueConformanceRuntime {
  db: Database;
  inspect(): Promise<RecoveryInspection>;
  restoreArtifact(artifact: ExportArtifact): Promise<Result<{ restored: number }>>;
}
/** moduleRoot/CO_MODULE_ROOT lets the same Worker exercise a provenance-recorded source copy. */
export function runtime(options?: { seed?: boolean; moduleRoot?: string; nativeAdapter?: string }): Promise<NativeFixtureRuntime>;
