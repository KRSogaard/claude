import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, BackgroundTask, SkillUse } from '../types'

const PANE = 'agent-sidebar'
const TITLE = 'Agents'
const MAX_ROWS = 40
const MAX_TASKS = 30
const ENDED = ['completed', 'failed', 'killed', 'stopped']
const SETTLED = ['idle', 'completed', 'failed']
const QUIET_AFTER_MS = 3 * 60 * 1000
const STALE_AFTER_MS = 5 * 60 * 1000
const REMIND_AGAIN_AFTER_MS = 10 * 60 * 1000
const SHOW_ENDED_TASK_FOR_MS = 2 * 60 * 1000
const ACTIVITY_FIELDS = ['skill', 'command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt']
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'command', 'cwd']
const WORKTREE_PATH = /(\/[^\s'"`;|&]*?\/(?:\.claude\/worktrees|worktrees)\/[^/\s'"`;|&]+)/

// Change a tag when its type changes: it declines what an earlier version stored.
const agents = atom({ plugin: 'agent-sidebar', key: 'agents' } as const, [], { shape: 'agents-4' })
const tasks = atom({ plugin: 'agent-sidebar', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const clock = atom({ plugin: 'agent-sidebar', key: 'clock' } as const, 0)
const sessionCwd = atom({ plugin: 'agent-sidebar', key: 'sessionCwd' } as const, '')

function isEnded(status: string): boolean {
  return ENDED.includes(status)
}

function isSettled(status: string): boolean {
  return SETTLED.includes(status)
}

function statusIcon(status: string): string {
  if (status === 'completed') {
    return '✓'
  }
  if (status === 'failed') {
    return '✗'
  }
  if (status === 'killed' || status === 'stopped') {
    return '■'
  }
  if (status === 'running') {
    return '●'
  }
  return '○'
}

function statusColor(status: string): string {
  if (status === 'failed' || status === 'killed' || status === 'stopped') {
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

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function describeToolCall(tool: string, input: Record<string, unknown>): string {
  for (const field of ACTIVITY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') {
      return `${tool}: ${firstLine(value)}`
    }
  }
  return tool
}

function shellActivity(command: string): string {
  const lower = command.toLowerCase()
  if (/\b(test|tests|pytest|jest|vitest|gd-test)\b/.test(lower)) {
    return 'testing'
  }
  if (/\b(build|compile|tsc|restore)\b/.test(lower)) {
    return 'building'
  }
  if (/(^|[\s;&|])(git|gh)\s/.test(lower)) {
    return 'git'
  }
  return 'shell'
}

function activityOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const command = input['command']
    return shellActivity(typeof command === 'string' ? command : '')
  }
  if (['Read', 'Grep', 'Glob', 'LSP'].includes(tool)) {
    return 'reading'
  }
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) {
    return 'editing'
  }
  if (['WebFetch', 'WebSearch'].includes(tool) || /browser|chrome/i.test(tool)) {
    return 'browsing'
  }
  if (tool === 'Agent') {
    return 'delegating'
  }
  if (tool === 'Skill') {
    return 'using a skill'
  }
  if (tool === 'SendMessage') {
    return 'messaging'
  }
  if (tool === 'Monitor') {
    return 'watching'
  }
  const mcpServer = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool)
  if (mcpServer !== null) {
    return mcpServer[1] ?? 'mcp'
  }
  return tool.toLowerCase()
}

function worktreeIn(input: Record<string, unknown>): string | undefined {
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value === 'string') {
      const found = WORKTREE_PATH.exec(value)
      if (found !== null && found[1] !== undefined) {
        return found[1]
      }
    }
  }
  return undefined
}

function shortFolder(folder: string, cwd: string): string {
  if (cwd !== '' && folder.startsWith(cwd + '/')) {
    return folder.slice(cwd.length + 1)
  }
  const home = /^\/home\/[^/]+/.exec(folder)
  if (home !== null) {
    return '~' + folder.slice(home[0].length)
  }
  return folder
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

function backgroundTaskId(tool: string, result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined
  }
  const record = result as Record<string, unknown>
  const id = tool === 'Monitor' ? record['taskId'] : record['backgroundTaskId']
  return typeof id === 'string' && id !== '' ? id : undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  return JSON.stringify(content ?? '')
}

function endedTaskIn(text: string): { id: string; status: string } | undefined {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]
  if (id === undefined || status === undefined || !isEnded(status.trim())) {
    return undefined
  }
  return { id: id.trim(), status: status.trim() }
}

function orderAsTree(rows: AgentRow[]): { row: AgentRow; depth: number }[] {
  const ids = rows.map(row => row.id)
  const childrenOf = (parentId: string | undefined) =>
    rows
      .filter(row => (parentId === undefined ? row.parentId === undefined || !ids.includes(row.parentId) : row.parentId === parentId))
      .reverse()
  const ordered: { row: AgentRow; depth: number }[] = []
  const visit = (row: AgentRow, depth: number) => {
    ordered.push({ row, depth })
    for (const child of childrenOf(row.id)) {
      visit(child, depth + 1)
    }
  }
  for (const root of childrenOf(undefined)) {
    visit(root, 0)
  }
  return ordered
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
      parentId: found === undefined ? row.parentId : found.parentId,
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
        parentId: agent.parentId,
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

async function trackBackgroundTask(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  ownerAgentId: string | undefined,
) {
  const id = backgroundTaskId(tool, result)
  if (id === undefined) {
    return
  }
  const now = await $.clock.now()
  const isMonitor = tool === 'Monitor'
  const command = typeof input['command'] === 'string' ? (input['command'] as string) : ''
  const description = typeof input['description'] === 'string' ? (input['description'] as string) : ''
  const task: BackgroundTask = {
    id,
    kind: isMonitor ? 'monitor' : 'shell',
    activity: isMonitor ? 'watching' : shellActivity(command),
    label: firstLine(isMonitor ? description || command : command || description),
    ownerAgentId,
    status: 'running',
    startedAt: now,
  }
  await update($, tasks, list => [...list.filter(one => one.id !== id), task].slice(-MAX_TASKS))
}

async function endBackgroundTask($: EngineInterface, id: string, status: string) {
  const now = await $.clock.now()
  await update($, tasks, list =>
    list.map(task => (task.id === id && !isEnded(task.status) ? { ...task, status, endedAt: now } : task)),
  )
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, sessionCwd, () => e.cwd)
    await $.command.register({
      name: 'agents-sidebar',
      description: 'Show the subagents of this session in the right-hand pane',
    })
    $.clock.every(1000, async () => {
      const rows = await read($, agents)
      const backgroundTasks = await read($, tasks)
      const hasActive = rows.some(row => !isEnded(row.status)) || backgroundTasks.some(task => !isEnded(task.status))
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
    if (agentId !== undefined) {
      const model = spawned.model
      const folder = e.cwd
      await changeAgent($, agentId, row => ({
        ...row,
        model: model ?? row.model,
        folder: folder ?? row.folder,
      }))
    }
    void openPane($)
    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const agentId = e.agentId
    if (agentId === undefined) {
      const ran = await next(e)
      if (ran.deny === undefined) {
        await trackBackgroundTask($, e.tool, input, ran.result, undefined)
      }
      return remindAboutStaleAgents($, ran)
    }

    const doing = describeToolCall(e.tool, input)
    const activity = activityOf(e.tool, input)
    const worktree = worktreeIn(input)
    const skillName = e.tool === 'Skill' ? (input['skill'] as string | undefined) : undefined
    await changeAgent($, agentId, (row, now) => ({
      ...row,
      now: doing,
      activity,
      folder: worktree ?? row.folder,
      skills: skillName === undefined ? row.skills : addSkill(row.skills, skillName),
      toolsInFlight: row.toolsInFlight + 1,
      lastActiveAt: now,
    }))
    try {
      const ran = await next(e)
      if (ran.deny === undefined) {
        await trackBackgroundTask($, e.tool, input, ran.result, agentId)
      }
      return ran
    } finally {
      await changeAgent($, agentId, (row, now) => ({
        ...row,
        toolsInFlight: Math.max(0, row.toolsInFlight - 1),
        activity: row.toolsInFlight <= 1 ? 'thinking' : row.activity,
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

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.origin.kind === 'task-notification') {
      const ended = endedTaskIn(textOf(e.message.content))
      if (ended !== undefined) {
        await endBackgroundTask($, ended.id, ended.status)
      }
    }
    return stored
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    const backgroundTasks = await read($, tasks)
    const cwd = await read($, sessionCwd)
    await read($, clock)
    const now = await $.clock.now()
    const viewedAgentId = e.props.view.agentId

    const runningCount = rows.filter(row => !isEnded(row.status)).length
    const doneCount = rows.filter(row => row.status === 'completed').length
    const failedCount = rows.filter(row => row.status === 'failed' || row.status === 'killed').length
    const shownTasks = backgroundTasks
      .filter(task => !isEnded(task.status) || now - (task.endedAt ?? now) < SHOW_ENDED_TASK_FOR_MS)
      .reverse()

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {runningCount} running · {doneCount} done · {failedCount} failed
        </Text>
        {shownTasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Background</Text>
            {shownTasks.map(task => {
              const owner = rows.find(row => row.id === task.ownerAgentId)
              const ownerLabel = owner === undefined ? '' : ` · ${owner.type}`
              const elapsed = formatDuration((task.endedAt ?? now) - task.startedAt)
              return (
                <Box key={'task-' + task.id} flexDirection="column">
                  <Text color={statusColor(task.status)} wrap="truncate-end">
                    {statusIcon(task.status)} {task.activity} · {elapsed}
                    {ownerLabel}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'   '}
                    {task.label}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
        <Box marginTop={1}>
          <Button
            key="main"
            plain
            label={viewedAgentId === undefined ? '▶ Main agent' : '  Main agent'}
            onPress={() => $.ui.view({})}
          />
        </Box>
        {rows.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {orderAsTree(rows).map(({ row, depth }) => {
          const indent = '  '.repeat(depth)
          const pad = indent + '   '
          const isActive = !isEnded(row.status)
          const marker = row.id === viewedAgentId ? '▶' : statusIcon(row.status)
          const branch = depth > 0 ? '└ ' : ''
          const elapsed = formatDuration((row.endedAt ?? now) - row.startedAt)
          const model = row.model === undefined ? '' : ` · ${shortModel(row.model)}`
          const activity = isActive && row.status === 'running' && row.activity !== undefined ? ` · ${row.activity}` : ''
          const quietFor = now - row.lastActiveAt
          const isQuiet = isActive && row.toolsInFlight === 0 && quietFor >= QUIET_AFTER_MS
          const isLongTool = isActive && row.toolsInFlight > 0 && quietFor >= QUIET_AFTER_MS
          const nowLine = row.now === undefined ? undefined : isLongTool ? `${row.now} (${formatDuration(quietFor)})` : row.now
          const stale = staleFor(row, now)
          return (
            <Box key={row.id} flexDirection="column" marginTop={1}>
              <Button
                key={'view-' + row.id}
                plain
                dimColor={!isActive}
                label={`${indent}${branch}${marker} ${row.type}${activity} · ${elapsed}${model}`}
                onPress={() => $.ui.view({ agentId: row.id })}
              />
              <Text color={statusColor(row.status)} wrap="truncate-end">
                {pad}
                {row.status} · {row.description}
              </Text>
              {row.folder !== undefined && (
                <Text color="magenta" wrap="truncate-start">
                  {pad}
                  {'folder: '}
                  {shortFolder(row.folder, cwd)}
                </Text>
              )}
              {isActive && nowLine !== undefined && (
                <Text dimColor wrap="truncate-end">
                  {pad}
                  {'now: '}
                  {nowLine}
                </Text>
              )}
              {row.skills.length > 0 && (
                <Text color="cyan" wrap="truncate-end">
                  {pad}
                  {'skills: '}
                  {formatSkills(row.skills)}
                </Text>
              )}
              {stale !== undefined && (
                <Text color="#ff8800" bold wrap="truncate-end">
                  {pad}
                  {'⚠ still open '}
                  {formatDuration(stale)}
                  {row.remindedAt === undefined ? '' : ' · main agent reminded'}
                </Text>
              )}
              {isQuiet && (
                <Text color="#ff8800" bold wrap="truncate-end">
                  {pad}
                  {'⚠ quiet '}
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
