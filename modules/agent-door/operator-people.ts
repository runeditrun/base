import type { PeopleAdapter, Person } from './types.ts'

interface Operator { id: string; email: string; displayName: string; role: string; status: string }
/** Resolve the live native operator for each call; never retain a session snapshot. */
export function operatorAuthPeople(options: { db: D1Database; session(request: Request): Promise<{ operator: Operator } | null> }): PeopleAdapter {
  const person = (operator: Operator): Person => ({ id: operator.id, email: operator.email, name: operator.displayName, role: operator.role, active: operator.status === 'active' })
  return {
    async sponsor({ email }) {
      const operator = await options.db.prepare('SELECT id,email,display_name AS displayName,role,status FROM oa_operators WHERE email=?').bind(email).first<Operator>()
      return operator ? person(operator) : null
    },
    async session(request) {
      const session = await options.session(request)
      if (!session) return null
      const current = await options.db.prepare('SELECT id,email,display_name AS displayName,role,status FROM oa_operators WHERE id=?').bind(session.operator.id).first<Operator>()
      return current?.status === 'active' ? person(current) : null
    },
  }
}
