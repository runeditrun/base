import { Outlet, createFileRoute } from '@tanstack/react-router'
import { requireOperator, loadBusinessBrand } from '../core/app/loaders'

export const Route = createFileRoute('/app')({
  beforeLoad: () => requireOperator(),
  loader: () => loadBusinessBrand(),
  head: () => ({ links: [{ rel: 'stylesheet', href: '/rer-business.css' }] }),
  component: AppLayout,
})

function AppLayout() {
  const business = Route.useLoaderData()
  return <>
    <section aria-label="Workspace" className="business-workspace">
      {business.logo ? <img src={business.logo} width="40" height="40" alt="" /> : null}
      <h2>{business.displayName ?? 'Default seed'}</h2>
      {business.ownerName ? <p>{business.ownerName}</p> : null}
      <p>Times shown in {business.timezone}</p>
      <a className="business-primary" href="/app/people">Open people</a>
    </section>
    <style>{`.business-workspace{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin:1rem 0}.business-workspace img{object-fit:contain}.business-workspace h2,.business-workspace p{margin:0}.business-primary{display:inline-block;padding:.6rem 1rem;border-radius:var(--rer-radius,12px);background:var(--rer-business-accent,var(--rer-accent,#334155));color:var(--rer-business-accent-text,var(--rer-accent-text,#fff));font-weight:600}`}</style>
    <Outlet />
  </>
}
