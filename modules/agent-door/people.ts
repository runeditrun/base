import type { Person, PeopleAdapter, PreparedBy, Principal } from './types.ts'
export const businessRole = (people: PeopleAdapter, person: Person) => people.businessRole ? people.businessRole(person) : person.role === 'owner' ? 'owner' : person.role === 'admin' ? 'editor' : null
export const preparedBy = ({ person, agent }: Pick<Principal, 'person' | 'agent'>): PreparedBy => ({ agent: { id: agent.id, name: agent.name }, for: { id: person.id, name: person.name }, label: `${agent.name} for ${person.name}` })
export const matchesRef = (people: PeopleAdapter, person: Person, sponsor: string, ref: string) => ref === 'sponsor' ? person.id === sponsor : ref.startsWith('person:') ? person.id === ref.slice(7) : ref === `role:${businessRole(people, person)}`
