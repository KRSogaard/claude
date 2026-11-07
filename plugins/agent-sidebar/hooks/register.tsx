import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow } from '../types'

const PANE = 'agent-sidebar'
const TITLE = 'Agents'
const MAX_ROWS = 40
const ENDED = ['completed', 'failed', 'killed']

const agents = atom({ plugin: 'agent-sidebar', key: 'agents' } as const, [], {
  shape: 'agents-1',
})

function statusIcon(status: string): string {
  if (status === 'completed') {
    return '✓'
  }
  if (status === 'failed') {
    return '✗'
  }
  if (status === 'killed') {
    return '■'
  }
  if (status === 'running') {
    return '●'
  }
  return '○'
}

function statusColor(status: string): string {
  if (status === 'failed' || status === 'killed') {
    return 'red'
  }
  if (status === 'completed') {
    return 'green'
  }
  return 'yellow'
}

function isSameList(left: AgentRow[], right: AgentRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function refreshAgents($: EngineInterface): Promise<AgentRow[]> {
  const live = await $.agent.list()
  const stored = await read($, agents)
  const merged = stored.map(row => {
    const found = live.find(agent => agent.id === row.id)
    if (found === undefined) {
      const isStillMarkedActive = !ENDED.includes(row.status)
      return isStillMarkedActive ? { ...row, status: 'completed' } : row
    }
    return { ...row, status: found.status, description: found.description }
  })
  for (const agent of live) {
    const isNew = !merged.some(row => row.id === agent.id)
    if (isNew) {
      merged.push({
        id: agent.id,
        type: agent.type,
        description: agent.description,
        status: agent.status,
      })
    }
  }
  const kept = merged.slice(-MAX_ROWS)
  if (!isSameList(stored, kept)) {
    await update($, agents, () => kept)
  }
  return kept
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-sidebar',
      description: 'Show the subagents of this session in the right-hand pane',
    })
    $.clock.every(2000, async () => {
      const rows = await read($, agents)
      const hasActive = rows.some(row => !ENDED.includes(row.status))
      if (hasActive) {
        await refreshAgents($)
      }
    })
    const rows = await refreshAgents($)
    if (rows.length > 0) {
      void $.ui.open({ id: PANE, title: TITLE })
    }
    return next(e)
  })

  on('command.run', { command: 'agents-sidebar' }, async $ => {
    await refreshAgents($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Agents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await refreshAgents($)
    void $.ui.open({ id: PANE, title: TITLE })
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      await refreshAgents($)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    const viewedAgentId = e.props.view.agentId
    const room = Math.max(1, e.props.scroll.bodyRows - 2)
    const shown = rows.slice(-room).reverse()

    return (
      <Box flexDirection="column">
        <Button
          key="main"
          plain
          label={viewedAgentId === undefined ? '▶ Main agent' : '  Main agent'}
          onPress={() => $.ui.view({})}
        />
        {shown.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {shown.map(row => {
          const marker = row.id === viewedAgentId ? '▶' : statusIcon(row.status)
          return (
            <Box key={row.id} flexDirection="column">
              <Button
                key={'view-' + row.id}
                plain
                dimColor={ENDED.includes(row.status)}
                label={`${marker} ${row.type}`}
                onPress={() => $.ui.view({ agentId: row.id })}
              />
              <Text color={statusColor(row.status)} wrap="truncate-end">
                {'   '}
                {row.status} · {row.description}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const viewedAgentId = e.props.view.agentId
    if (viewedAgentId === undefined || e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    const viewed = rows.find(row => row.id === viewedAgentId)
    const name = viewed === undefined ? 'subagent' : `${viewed.type} – ${viewed.description}`

    return (
      <Box flexDirection="row" backgroundColor="yellow" paddingX={1} width="100%">
        <Box flexGrow={1}>
          <Text color="black" backgroundColor="yellow" bold wrap="truncate-end">
            ⚠ VIEWING SUBAGENT: {name}. Your next message goes to this subagent, not the main agent.
          </Text>
        </Box>
        <Button key="back" label="Back to main" onPress={() => $.ui.view({})} />
      </Box>
    )
  })
}
