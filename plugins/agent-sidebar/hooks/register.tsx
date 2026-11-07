import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, SkillUse } from '../types'

const PANE = 'agent-sidebar'
const TITLE = 'Agents'
const MAX_ROWS = 40
const ENDED = ['completed', 'failed', 'killed']
const QUIET_AFTER_MS = 3 * 60 * 1000
const SETTLED = ['idle', 'completed', 'failed']
const STALE_AFTER_MS = 5 * 60 * 1000
const REMIND_AGAIN_AFTER_MS = 10 * 60 * 1000
const ACTIVITY_FIELDS = ['skill', 'command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt']

// Change the tag when AgentRow changes: it declines rows an earlier version stored.
const agents = atom({ plugin: 'agent-sidebar', key: 'agents' } as const, [], {
  shape: 'agents-3',
})
const clock = atom({ plugin: 'agent-sidebar', key: 'clock' } as const, 0)

function isEnded(status: string): boolean {
  return ENDED.includes(status)
}

function isSettled(status: string): boolean {
  return SETTLED.includes(status)
}

function staleFor(row: AgentRow, now: number): number | undefined {
  if (!row.isListed || row.settledAt === undefined || !isSettled(row.status)) {
    return undefined
  }
  const settledFor = now - row.settledAt
  return settledFor >= STALE_AFTER_MS ? settledFor : undefined
}

function isDueForReminder(row: AgentRow, now: number): boolean {
  const isStale = staleFor(row, now) !== undefined
  const hasBeenRemindedLately = row.remindedAt !== undefined && now - row.remindedAt < REMIND_AGAIN_AFTER_MS
  return isStale && !hasBeenRemindedLately
}

function staleReminder(rows: AgentRow[], now: number): string {
  const lines = rows.map(row => {
    const name = row.name === undefined ? '' : ` (name: ${row.name})`
    return `- ${row.type} "${row.description}", id ${row.id}${name}: ${row.status} for ${formatDuration(now - (row.settledAt ?? now))}`
  })
  return [
    'These subagents have finished or gone idle but are still open:',
    ...lines,
    'Stop each one you no longer need with TaskStop (task_id = its id). Keep one only if you will send it more work soon.',
  ].join('\n')
}

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

function shortModel(model: string): string {
  const family = /(opus|sonnet|haiku|fable)/.exec(model)
  if (family === null) {
    return model
  }
  return family[1] ?? model
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

function describeToolCall(tool: string, input: Record<string, unknown>): string {
  for (const field of ACTIVITY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') {
      const firstLine = value.trim().split('\n')[0] ?? ''
      return `${tool}: ${firstLine}`
    }
  }
  return tool
}

function addSkill(skills: SkillUse[], name: string): SkillUse[] {
  const isKnown = skills.some(skill => skill.name === name)
  if (!isKnown) {
    return [...skills, { name, count: 1 }]
  }
  return skills.map(skill => (skill.name === name ? { ...skill, count: skill.count + 1 } : skill))
}

function formatSkills(skills: SkillUse[]): string {
  return skills.map(skill => (skill.count > 1 ? `${skill.name} ×${skill.count}` : skill.name)).join(', ')
}

function finishNotice(row: AgentRow, status: string): string {
  if (status === 'completed') {
    return `✓ ${row.type} finished: ${row.description}`
  }
  return `✗ ${row.type} ${status}: ${row.description}`
}

async function refreshAgents($: EngineInterface): Promise<AgentRow[]> {
  const live = await $.agent.list()
  const now = await $.clock.now()
  const stored = await read($, agents)
  const finished: string[] = []

  const merged = stored.map(row => {
    const found = live.find(agent => agent.id === row.id)
    const nextStatus = found === undefined ? (isEnded(row.status) ? row.status : 'completed') : found.status
    const hasJustEnded = !isEnded(row.status) && isEnded(nextStatus)
    if (hasJustEnded) {
      finished.push(finishNotice(row, nextStatus))
    }
    const hasJustSettled = isSettled(nextStatus) && (!isSettled(row.status) || row.settledAt === undefined)
    const settledAt = isSettled(nextStatus) ? (hasJustSettled ? now : row.settledAt) : undefined
    return {
      ...row,
      status: nextStatus,
      isListed: found !== undefined,
      settledAt,
      name: found === undefined ? row.name : found.name,
      description: found === undefined ? row.description : found.description,
      endedAt: hasJustEnded ? now : row.endedAt,
    }
  })

  for (const agent of live) {
    const isNew = !merged.some(row => row.id === agent.id)
    if (isNew) {
      merged.push({
        id: agent.id,
        type: agent.type,
        description: agent.description,
        status: agent.status,
        name: agent.name,
        skills: [],
        toolsInFlight: 0,
        isListed: true,
        settledAt: isSettled(agent.status) ? now : undefined,
        startedAt: now,
        endedAt: isEnded(agent.status) ? now : undefined,
        lastActiveAt: now,
      })
    }
  }

  const kept = merged.slice(-MAX_ROWS)
  if (JSON.stringify(stored) !== JSON.stringify(kept)) {
    await update($, agents, () => kept)
  }
  for (const notice of finished) {
    $.ui.toast(notice)
  }
  return kept
}

async function changeAgent($: EngineInterface, agentId: string, change: (row: AgentRow, now: number) => AgentRow) {
  const rows = await read($, agents)
  const isKnown = rows.some(row => row.id === agentId)
  if (!isKnown) {
    await refreshAgents($)
  }
  const now = await $.clock.now()
  await update($, agents, list => list.map(row => (row.id === agentId ? change(row, now) : row)))
}

async function remindAboutStaleAgents<R extends { deny?: string; context?: readonly string[] }>(
  $: EngineInterface,
  ran: R,
): Promise<R> {
  if (ran.deny !== undefined) {
    return ran
  }
  const rows = await refreshAgents($)
  const now = await $.clock.now()
  const due = rows.filter(row => isDueForReminder(row, now))
  if (due.length === 0) {
    return ran
  }
  const dueIds = due.map(row => row.id)
  await update($, agents, list => list.map(row => (dueIds.includes(row.id) ? { ...row, remindedAt: now } : row)))
  return { ...ran, context: [...(ran.context ?? []), staleReminder(due, now)] }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-sidebar',
      description: 'Show the subagents of this session in the right-hand pane',
    })
    $.clock.every(1000, async () => {
      const rows = await read($, agents)
      const hasActive = rows.some(row => !isEnded(row.status))
      if (hasActive) {
        const now = await $.clock.now()
        await update($, clock, () => now)
        await refreshAgents($)
      }
    })
    const rows = await refreshAgents($)
    if (rows.length > 0) {
      void openPane($)
    }
    return next(e)
  })

  on('command.run', { command: 'agents-sidebar' }, async $ => {
    await refreshAgents($)
    await openPane($)
    return { text: 'Agents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await refreshAgents($)
    const agentId = spawned.agentId
    const model = spawned.model
    if (agentId !== undefined && model !== undefined) {
      await changeAgent($, agentId, row => ({ ...row, model }))
    }
    void openPane($)
    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) {
      return remindAboutStaleAgents($, await next(e))
    }
    const activity = describeToolCall(e.tool, e as unknown as Record<string, unknown>)
    const skillName = e.tool === 'Skill' ? (e as unknown as { skill?: string }).skill : undefined
    await changeAgent($, agentId, (row, now) => ({
      ...row,
      now: activity,
      skills: skillName === undefined ? row.skills : addSkill(row.skills, skillName),
      toolsInFlight: row.toolsInFlight + 1,
      lastActiveAt: now,
    }))
    try {
      return await next(e)
    } finally {
      await changeAgent($, agentId, (row, now) => ({
        ...row,
        toolsInFlight: Math.max(0, row.toolsInFlight - 1),
        lastActiveAt: now,
      }))
    }
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const agentId = e.agentId
    if (agentId !== undefined) {
      await changeAgent($, agentId, (row, now) => ({ ...row, model: e.model, lastActiveAt: now }))
    }
    return step
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
    await read($, clock)
    const now = await $.clock.now()
    const viewedAgentId = e.props.view.agentId
    const shown = [...rows].reverse()

    const runningCount = rows.filter(row => !isEnded(row.status)).length
    const doneCount = rows.filter(row => row.status === 'completed').length
    const failedCount = rows.filter(row => row.status === 'failed' || row.status === 'killed').length

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {runningCount} running · {doneCount} done · {failedCount} failed
        </Text>
        <Button
          key="main"
          plain
          label={viewedAgentId === undefined ? '▶ Main agent' : '  Main agent'}
          onPress={() => $.ui.view({})}
        />
        {shown.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {shown.map(row => {
          const isActive = !isEnded(row.status)
          const marker = row.id === viewedAgentId ? '▶' : statusIcon(row.status)
          const elapsed = formatDuration((row.endedAt ?? now) - row.startedAt)
          const model = row.model === undefined ? '' : ` · ${shortModel(row.model)}`
          const quietFor = now - row.lastActiveAt
          const isQuiet = isActive && row.toolsInFlight === 0 && quietFor >= QUIET_AFTER_MS
          const isLongTool = isActive && row.toolsInFlight > 0 && quietFor >= QUIET_AFTER_MS
          const nowLine = row.now === undefined ? undefined : isLongTool ? `${row.now} (${formatDuration(quietFor)})` : row.now
          return (
            <Box key={row.id} flexDirection="column" marginTop={1}>
              <Button
                key={'view-' + row.id}
                plain
                dimColor={!isActive}
                label={`${marker} ${row.type} · ${elapsed}${model}`}
                onPress={() => $.ui.view({ agentId: row.id })}
              />
              <Text color={statusColor(row.status)} wrap="truncate-end">
                {'   '}
                {row.status} · {row.description}
              </Text>
              {isActive && nowLine !== undefined && (
                <Text dimColor wrap="truncate-end">
                  {'   now: '}
                  {nowLine}
                </Text>
              )}
              {row.skills.length > 0 && (
                <Text color="cyan" wrap="truncate-end">
                  {'   skills: '}
                  {formatSkills(row.skills)}
                </Text>
              )}
              {staleFor(row, now) !== undefined && (
                <Text color="#ff8800" bold wrap="truncate-end">
                  {'   ⚠ still open '}
                  {formatDuration(staleFor(row, now) ?? 0)}
                  {row.remindedAt === undefined ? '' : ' · main agent reminded'}
                </Text>
              )}
              {isQuiet && (
                <Text color="#ff8800" bold wrap="truncate-end">
                  {'   ⚠ quiet '}
                  {formatDuration(quietFor)}
                </Text>
              )}
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
