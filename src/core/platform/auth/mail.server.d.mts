import type { MailSender } from '../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../bindings.server'
export function operatorMail(env: Bindings): MailSender | undefined;
