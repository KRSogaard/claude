export type SkillUse = { name: string; count: number }

export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  model?: string
  name?: string
  skills: SkillUse[]
  now?: string
  toolsInFlight: number
  startedAt: number
  endedAt?: number
  lastActiveAt: number
  isListed: boolean
  settledAt?: number
  remindedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-sidebar': {
      agents: Shaped<AgentRow[]>
      clock: number
    }
  }
}
