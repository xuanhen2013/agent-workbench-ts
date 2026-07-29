import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AppShell, DemoHome } from './App'
import { JokeDemo } from './JokeDemo'

interface JokeSearch {
  threadId?: string
}

const rootRoute = createRootRoute({
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DemoHome,
})

const jokeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/demos/jokes',
  validateSearch: (search: Record<string, unknown>): JokeSearch => (
    typeof search.threadId === 'string'
      ? { threadId: search.threadId }
      : {}
  ),
  component: JokeDemo,
})

const routeTree = rootRoute.addChildren([indexRoute, jokeRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
