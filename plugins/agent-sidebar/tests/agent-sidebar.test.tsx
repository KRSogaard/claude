import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-sidebar',
  component: 'Pane',
  requestId: 'agent-sidebar',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
}

const REVIEWER = {
  id: 'agent-1',
  type: 'code-reviewer',
  description: 'Review the diff',
  status: 'running',
}

test('a started subagent is listed in the pane and named in the banner', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [REVIEWER] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await pane.find({ type: 'Text', text: /Review the diff/ })
  expect(row?.text).toContain('running')
  await pane.unmount()

  const onSubagent = await $.ui.mount({
    plugin: 'agent-sidebar',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { ...BAND_PROPS, view: { agentId: 'agent-1' } },
  })
  const banner = await onSubagent.find({ type: 'Text', text: /VIEWING SUBAGENT/ })
  expect(banner?.text).toContain('code-reviewer – Review the diff')
  await onSubagent.unmount()

  const onMain = await $.ui.mount({
    plugin: 'agent-sidebar',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { ...BAND_PROPS, view: {} },
  })
  expect(await onMain.find({ type: 'Text', text: /VIEWING SUBAGENT/ })).toBeUndefined()
  expect((await onMain.find({ type: 'Text', text: /engine band/ }))?.text).toBe('engine band')
  await onMain.unmount()
})

test('a subagent that drops out of the engine list stays as completed', async ($, on) => {
  let live = [REVIEWER]
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: live }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  live = []
  await $.command.run({ command: 'agents-sidebar', args: '' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await pane.find({ type: 'Text', text: /Review the diff/ })
  expect(row?.text).toContain('completed')
  await pane.unmount()
})

const MINUTE = 60 * 1000

test('the pane shows the skills an agent used and what it does now', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [REVIEWER] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Skill', skill: 'code-review', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Skill', skill: 'code-review', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Bash', command: 'dotnet test\nmore', agentId: 'agent-1' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /skills:/ }))?.text).toContain('code-review ×2')
  expect((await pane.find({ type: 'Text', text: /now:/ }))?.text).toContain('Bash: dotnet test')
  await pane.unmount()
})

test('the main agent is reminded once about a subagent left open', async ($, on) => {
  const reviewerIdle = { ...REVIEWER, status: 'idle' }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [reviewerIdle] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const early = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(early.context).toBeUndefined()

  await clock.advance(6 * MINUTE)
  const reminded = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(reminded.context?.[0]).toContain('id agent-1')
  expect(reminded.context?.[0]).toContain('TaskStop')

  const right = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(right.context).toBeUndefined()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /still open/ }))?.text).toContain('main agent reminded')
  await pane.unmount()
})

test('a pop-up says when a subagent finishes', async ($, on) => {
  let live = [REVIEWER]
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: live }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  live = [{ ...REVIEWER, status: 'completed' }]
  await $.command.run({ command: 'agents-sidebar', args: '' })

  expect(toasts).toContain('✓ code-reviewer finished: Review the diff')
})

test('an agent row shows its activity and the worktree it works in', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [REVIEWER] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let release = () => {}
  on('tool.call', () => new Promise(resolve => (release = () => resolve({ result: {} }))))

  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  const running = $.tool.call({
    tool: 'Bash',
    command: 'cd /home/me/repo/.claude/worktrees/feature-x && dotnet test',
    agentId: 'agent-1',
  })
  await new Promise(resolve => setTimeout(resolve, 20))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ key: 'view-agent-1' }))?.text).toContain('· testing ·')
  expect((await pane.find({ type: 'Text', text: /folder:/ }))?.text).toContain('.claude/worktrees/feature-x')
  await pane.unmount()
  release()
  await running
})

test('an agent started by another agent is shown under it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const child = { id: 'agent-2', type: 'Explore', description: 'Find callers', status: 'running', parentId: 'agent-1' }
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [REVIEWER, child] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ key: 'view-agent-2' }))?.text).toMatch(/^ {2}└ ● Explore/)
  expect((await pane.find({ key: 'view-agent-1' }))?.text).toMatch(/^● code-reviewer/)
  await pane.unmount()
})

test('a background command is listed while it runs and marked when it ends', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash-7' } }))
  mock.session(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'dotnet test App.slnx', run_in_background: true })

  const running = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await running.find({ type: 'Text', text: /testing ·/ }))?.text).toContain('●')
  expect(await running.find({ type: 'Text', text: /dotnet test App.slnx/ })).toBeDefined()
  await running.unmount()

  await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: '<task-notification><task-id>bash-7</task-id><status>completed</status></task-notification>' }] },
    door: 'delivery',
    origin: { kind: 'task-notification' },
  } as never)

  const ended = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ended.find({ type: 'Text', text: /testing ·/ }))?.text).toContain('✓')
  await ended.unmount()
})
