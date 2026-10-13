export type Rule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';
export interface Enabled { enabled?: boolean }
export interface BoundaryConfig {
  version: 1;
  sourceRoot?: string;
  tsconfig?: string;
  includeTypeOnly?: boolean;
  rules?: {
    R1?: false | (Enabled & { allowedPrefixes?: string[] });
    R2?: false | (Enabled & { mounts?: string[] | Record<string, true | string[]> });
    R3?: false | (Enabled & { exceptions?: string[] });
    R4?: false | (Enabled & { specifiers?: string[]; specifierPrefixes?: string[]; clientModules?: string[]; allowedFiles?: string[]; allowedDirectories?: string[] });
    R5?: false | (Enabled & { importScopes?: string[]; environmentScopes?: string[]; specifierPatterns?: string[]; allowedDirectories?: string[] });
    R6?: false | Enabled;
    R7?: false | (Enabled & { files?: string[]; pattern?: string });
    R8?: false | (Enabled & { files?: string[]; prefix?: string });
  };
}
export interface Violation {
  rule: Rule;
  file: string;
  line: number;
  column: number;
  specifier: string | null;
  target: string | null;
  message: string;
}
export interface BoundaryResult { files: number; violations: Violation[] }
export function checkBoundaries(options: { root: string; config?: BoundaryConfig }): Promise<BoundaryResult>;
