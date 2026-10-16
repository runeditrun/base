import { createFileRoute } from '@tanstack/react-router'
import { OperatorAccess } from '../core/features/auth/access'
import { loadPrivateDashboard } from '../core/app/loaders'

export const Route = createFileRoute('/app/')({
  loader: () => loadPrivateDashboard(),
  component: OperatorApp,
})

function OperatorApp() {
  const dashboard = Route.useLoaderData()
  return (
    <section>
      <h1>Native session protected operator app</h1>
      <p>The private loader runs only after the parent session gate passes.</p>
      <p>Latest job: {dashboard.latestJob?.state ?? 'none'}</p>
      <p>Latest cron: {dashboard.latestSchedule?.cron ?? 'none'}</p>
      <p><a href="/app/people">People and recent activity</a></p>
      <OperatorAccess />
    </section>
  )
}
