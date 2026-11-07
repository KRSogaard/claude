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
