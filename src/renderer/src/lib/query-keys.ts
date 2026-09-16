/** TanStack Query keys for every query in the renderer, from one factory (plan §15). */
export const queryKeys = {
  app: {
    info: ['app', 'info'] as const
  },
  settings: ['settings'] as const,
  backup: {
    status: ['backup', 'status'] as const
  }
}
