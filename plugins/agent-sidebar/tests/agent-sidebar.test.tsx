import { expect, test } from 'claude-code/testing'

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
  on('command.register', () => ({ value: { command: 'agents-sidebar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: live }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  live = []
  await $.command.run({ command: 'agents-sidebar' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await pane.find({ type: 'Text', text: /Review the diff/ })
  expect(row?.text).toContain('completed')
  await pane.unmount()
})
