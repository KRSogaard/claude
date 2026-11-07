export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-sidebar': { agents: Shaped<AgentRow[]> }
  }
}
