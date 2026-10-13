import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { excludeLocalVariables } from './vite/exclude-local-variables.ts'
import { archiveOutputGuard } from './scripts/base-onboarding/archive-output.mjs'

// Only `vite dev` loads the local-only entry and the checkout's dev key; a build
// keeps src/server.ts and never sees either (rer build checks its output).
const local = (name: string) => process.env[name] ? { [name]: process.env[name] } : {}
const serve = { main: './src/server.dev.ts', vars: { ...local('RER_DEV_ORIGIN'), ...local('RER_DEV_KEY'), ...local('RER_DEV_IDENTITY'), ...local('RER_MODELS_SERVICE'), ...local('RER_MODELS_KEY'), ...local('RER_DEMO'), ...local('RER_DEMO_EXPIRES') } }
// A build routes requests the way rer deploy hosts it: the Worker runs before built
// files and hands them out through env.ASSETS. `rer preview` serves this output, so
// a prerendered page reaches the browser as the Worker's document (no-store,
// no-transform), exactly as deployed, never as a bare asset. `vite dev` keeps its own
// routing: there the Worker running first would also take Vite's module requests.
const built = { assets: { binding: 'ASSETS', run_worker_first: true }, vars: local('RER_DEV_ORIGIN') }

export default defineConfig(({ command, isPreview }) => ({
  // Prerender fetches the preview URL. Bind and advertise the same loopback
  // address even when a Linux container resolves localhost differently for
  // listeners and clients (IPv6 versus IPv4 with AI_ADDRCONFIG).
  preview: { host: '127.0.0.1' },
  // `vite dev` serves only the folders the app is built from (and what they
  // import, plus the public run site declaration its identity reads), never the rest of the checkout: not rer's private folders (the dev
  // key, installer state), export archives, settings or local data.
  server: { fs: { allow: ['src', 'public', 'node_modules', 'deploy-site.json'], deny: ['**/.rer/**', '**/.seed/**', '**/exports/**', '**/*.rer'] } },
  plugins: [
    cloudflare({ inspectorPort: false, viteEnvironment: { name: 'ssr' }, persistState: { path: process.env.RER_STATE_DIR ?? '.wrangler/state' },
      config: command === 'serve' && !isPreview ? serve : built,
    }),
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: [
        {
          path: '/reference',
          prerender: {
            enabled: true,
            outputPath: '/reference/index.html',
          },
        },
      ],
    }),
    react(),
    excludeLocalVariables(),
    archiveOutputGuard(),
  ],
}))
