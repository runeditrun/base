import type { ReactNode } from 'react'
import { fontLinks } from '../../../foundation/runtime/font-head'
import { pageStyle } from '../../../foundation/runtime/page-style'
import { HydrationUnit } from '../../../foundation/runtime/hydration/unit'
import { introCss, introGuardScript } from '../../../foundation/runtime/hydration/intro-guard'
import { theme } from '../core/app/theme'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    links: [{ rel: 'icon', type: 'image/svg+xml', href: '/brand/mark.svg' }],
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'description', content: 'A real Cloudflare reference seed.' },
      { title: 'Default seed reference' },
    ],
  }),
  notFoundComponent: NotFound,
  component: Root,
})

function Root() {
  return (
    <Document>
      {/* Root chrome sits in hydration units too: outside every boundary, a
          mismatch here would client-render the whole document. */}
      <HydrationUnit>
        <header>
          <nav aria-label="Reference navigation">
            <a href="/" data-rer-name>Default seed</a>{' '}
            <Link to="/records">Public record</Link>{' '}
            <Link to="/reference">Prerendered reference</Link>{' '}
            <Link to="/app">Operator app</Link>
          </nav>
        </header>
      </HydrationUnit>
      <main>
        <Outlet />
      </main>
      <HydrationUnit>
        <footer>
          {/* An address is the only child of its element, so a browser that links it changes nothing React checks. */}
          <p>Questions about this reference: <a href="mailto:records@example.com">records@example.com</a></p>
        </footer>
      </HydrationUnit>
    </Document>
  )
}

function NotFound() {
  return <section><h1>Document not found</h1><p>This Worker has no document at this path.</p></section>
}

function Document({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {fontLinks.map(link => <link key={link.href} {...link} />)}
        <link rel="stylesheet" href={theme.href} />
        <HeadContent />
        {/* Intros never replay after a hydration rebuild (src/base/hydration/README.md). */}
        <script dangerouslySetInnerHTML={{ __html: introGuardScript }} />
        <style>{introCss}</style>
        {/* The seed's own pages read the same --rer-* tokens as Base's frames. */}
        <style>{pageStyle + `.auth-panel { box-sizing: border-box; padding: 2rem; background: var(--rer-surface, #ffffff); border-radius: var(--rer-radius, 12px); } .auth-panel input:not([type=hidden]), .auth-panel select { padding: .5rem .75rem; border: 1px solid var(--rer-border, #64748b); border-radius: calc(var(--rer-radius, 12px) / 2); background: var(--rer-surface, #ffffff); color: var(--rer-text, #172033); } .auth-panel button { padding: .5rem 1rem; border: 0; border-radius: var(--rer-radius, 12px); background: var(--rer-accent, var(--rer-text, #172033)); color: var(--rer-accent-text, var(--rer-surface, #ffffff)); font-weight: 600; cursor: pointer; } .auth-panel p { color: var(--rer-muted, #475569); } main { max-width: 72rem; } @media (prefers-reduced-motion: no-preference) { [data-intro] { animation: reference-intro .6s ease-out both; } } @keyframes reference-intro { from { opacity: 0; transform: translateY(.75rem); } } nav { display: flex; flex-wrap: wrap; gap: 1rem; } .auth-panel { max-width: 40rem; margin-top: 2rem; } .auth-panel form { display: grid; gap: .75rem; margin-block: 1rem; } .auth-panel label { display: grid; gap: .25rem; } .auth-panel input, .auth-panel select, .auth-panel button { box-sizing: border-box; max-width: 100%; min-height: 2.75rem; font: inherit; } .auth-panel li { margin-bottom: 1rem; overflow-wrap: anywhere; }`}</style>
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
