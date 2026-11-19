import type { ArchivePolicy, MigrationReplay } from './index.mjs';
type MigrationFile = {name:string;sha256:string;statements:string[]};
interface BundledEvidence {
 version:1;
 files:MigrationFile[];
 ownerSources?:never;
 objects:{name:string;sql:string;type:string;tbl_name:string}[];
 prefixes:{objects:number[];shadows:string[];seeds:{name:string;columns:string[];hashes:string[]}[]}[];
}
interface OrderedEvidence {
 version:2;
 files:(MigrationFile & {table?:string})[];
 ownerSources:{prefix:string;table:string}[];
 openDatabase():Promise<{exec(sql:string):void;all(sql:string):Record<string,string|null>[];close():void}>;
}
export type MigrationEvidence = BundledEvidence | OrderedEvidence;
/** Return a replay bound to the destination's hashed history or exact native Wrangler prefix, and complete schema. */
export function workerMigrations(db:D1Database,policy:ArchivePolicy,evidence:MigrationEvidence):Promise<MigrationReplay>;
