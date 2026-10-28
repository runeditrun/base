import { registerOperatorAuthConformance } from '../../../modules/operator-auth/conformance/index.mjs'
import { openConsumerRuntime } from './runtime.mjs'
export const nativeAuthRows = []
registerOperatorAuthConformance({ test: (name, run) => nativeAuthRows.push([name, {}, run]), adapter: { open: openConsumerRuntime, confirmationFonts: true, branding: { productName: 'Default seed reference', theme: '/rer-theme.css' } } })
