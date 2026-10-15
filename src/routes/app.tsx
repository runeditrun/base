import { Outlet, createFileRoute } from '@tanstack/react-router'
import { requireOperator } from '../core/app/loaders'

export const Route = createFileRoute('/app')({
  beforeLoad: () => requireOperator(),
  component: AppLayout,
})

function AppLayout() {
  return <Outlet />
}
