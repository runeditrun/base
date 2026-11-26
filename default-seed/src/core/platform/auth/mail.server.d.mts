import type { MailSender } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../bindings.server'
export function operatorMail(env: Bindings): MailSender | undefined;
export function ownerOnlyMail(env: Pick<Bindings, 'MAIL_PROVIDER' | 'RER_DEMO' | 'AUTH_LOCAL' | 'AUTH_ORIGIN'>): boolean;
export function operatorMailHooks(env: Bindings): { beforeMagicLink?: (input: { email: string }) => boolean };
