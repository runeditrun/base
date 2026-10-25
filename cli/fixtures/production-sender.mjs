import { randomUUID } from 'node:crypto';

// A unique synthetic mailbox for the fake mail/provider edge. Reserved example
// domains cannot exercise a configured production sender anymore.
export const productionSender = `synthetic-clinic-1-${randomUUID()}@mail.runeditrun.com`;
