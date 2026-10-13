import { test } from 'node:test'
import { registerOperatorAuthConformance } from '../../../modules/operator-auth/conformance/index.mjs'
import { openConsumerRuntime } from './runtime.mjs'
registerOperatorAuthConformance({ test, adapter: { open: openConsumerRuntime, confirmationFonts: true, branding: { productName: 'Default seed reference', theme: '/rer-theme.css' } } })
