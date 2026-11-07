export type SkillUse = { name: string; count: number }

export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
  model?: string
  name?: string
  folder?: string
  activity?: string
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

export type BackgroundTask = {
  id: string
  kind: 'shell' | 'monitor'
  activity: string
  label: string
  ownerAgentId?: string
  status: string
  startedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-sidebar': {
      agents: Shaped<AgentRow[]>
      tasks: Shaped<BackgroundTask[]>
      clock: number
      sessionCwd: string
    }
  }
}
