export type ClauseKind = 'published' | 'target' | 'push-further'
export type ClauseStatus = 'done' | 'partial' | 'missing'

/** One row of the Status table, joined to the clause it judges. */
export interface ContractClause {
  /** "HOME-001". */
  id: string
  /** The clause title, as defined and as the row gives it: "Public landing". */
  title: string
  kind: ClauseKind
  status: ClauseStatus
  /** Repository paths backing a done or partial row, from the Evidence cell's backticks. */
  evidence: string[]
  /** What is missing, for a partial or missing row; may be empty for a done row. */
  gap: string
  /** The heading the clause is defined under: "Public landing", "Writing together". */
  area: string
  /** The row's 1-based line in CONTRACT.md. */
  line: number
}

export interface SeedContract {
  /** The commit the statuses were judged at: "8956e45". */
  commit: string
  /** The judged-at date as YYYY-MM-DD. */
  date: string
  /** From the "## Product target" table. */
  target: { category: string; incumbents: string[]; firstBuyer: string }
  /** Areas in the order the contract defines them, each with its clause IDs in table order. */
  areas: { name: string; clauses: string[] }[]
  /** Every clause, in Status table order. */
  clauses: ContractClause[]
  counts: { done: number; partial: number; missing: number; total: number }
}

export interface ContractProblem { line: number; message: string }

export class ContractError extends Error {
  file: string
  problems: ContractProblem[]
  constructor(file: string, problems: ContractProblem[])
}

export const kinds: readonly ClauseKind[]
export const statuses: readonly ClauseStatus[]
export const statusHeader: readonly string[]
export function plainText(value: string): string
/** Parse CONTRACT.md; throws a ContractError naming the line of every problem. */
export function parseContract(text: string, options?: { file?: string }): SeedContract
