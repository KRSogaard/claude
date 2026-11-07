export type SkillUse = { name: string; count: number }

export type TestResult = { passed: number; failed: number; total: number }

export type HeavyRun = { id: string; label: string; agentId?: string }

export type MainAgent = { files: string[]; tests?: TestResult }

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
  files: string[]
  tests?: TestResult
  answer?: string
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
  kind: 'shell' | 'monitor' | 'server'
  port?: number
  isHeavy: boolean
  tests?: TestResult
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
      heavyRuns: Shaped<HeavyRun[]>
      main: Shaped<MainAgent>
    }
  }
}
