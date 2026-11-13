import { atom, read, update } from 'claude-code';
const PANE = 'agent-sidebar';
const TITLE = 'Agents';
const MAX_ROWS = 40;
const MAX_TASKS = 30;
const ENDED = ['completed', 'failed', 'killed', 'stopped'];
const SETTLED = ['idle', 'completed', 'failed'];
const QUIET_AFTER_MS = 3 * 60 * 1000;
const STALE_AFTER_MS = 5 * 60 * 1000;
const REMIND_AGAIN_AFTER_MS = 10 * 60 * 1000;
const SHOW_ENDED_TASK_FOR_MS = 2 * 60 * 1000;
const HEAVY_RUN_LIMIT = 3;
const MAX_FILES = 50;
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const HEAVY_COMMAND = /\bdotnet\s+(build|test|run|publish|restore)\b|\bgd-test\b/;
const SERVER_PORT = /(?:--urls?[= ]\S*?:|--port[= ]|\s-p\s+|PORT=|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d{2,5})\b/i;
const ACTIVITY_FIELDS = ['skill', 'command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt'];
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'command', 'cwd'];
const WORKTREE_PATH = /(\/[^\s'"`;|&]*?\/(?:\.claude\/worktrees|worktrees)\/[^/\s'"`;|&]+)/;
// Change a tag when its type changes: it declines what an earlier version stored.
const agents = atom({ plugin: 'agent-sidebar', key: 'agents' }, [], { shape: 'agents-5' });
const tasks = atom({ plugin: 'agent-sidebar', key: 'tasks' }, [], { shape: 'tasks-2' });
const heavyRuns = atom({ plugin: 'agent-sidebar', key: 'heavyRuns' }, [], { shape: 'heavy-1' });
const main = atom({ plugin: 'agent-sidebar', key: 'main' }, { files: [] }, { shape: 'main-1' });
const clock = atom({ plugin: 'agent-sidebar', key: 'clock' }, 0);
const sessionCwd = atom({ plugin: 'agent-sidebar', key: 'sessionCwd' }, '');
function isEnded(status) {
    return ENDED.includes(status);
}
// A finished agent leaves the pane at once; its toast already said how it ended. One in view stays until left.
function isStillShown(row, viewedAgentId) {
    return !isEnded(row.status) || row.id === viewedAgentId;
}
function isSettled(status) {
    return SETTLED.includes(status);
}
function statusIcon(status) {
    if (status === 'completed') {
        return '✓';
    }
    if (status === 'failed') {
        return '✗';
    }
    if (status === 'killed' || status === 'stopped') {
        return '■';
    }
    if (status === 'running') {
        return '●';
    }
    return '○';
}
function statusColor(status) {
    if (status === 'failed' || status === 'killed' || status === 'stopped') {
        return 'red';
    }
    if (status === 'completed') {
        return 'green';
    }
    return 'yellow';
}
function shortModel(model) {
    const family = /(opus|sonnet|haiku|fable)/.exec(model);
    if (family === null) {
        return model;
    }
    return family[1] ?? model;
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}
function firstLine(text) {
    return text.trim().split('\n')[0] ?? '';
}
function describeToolCall(tool, input) {
    for (const field of ACTIVITY_FIELDS) {
        const value = input[field];
        if (typeof value === 'string' && value.trim() !== '') {
            return `${tool}: ${firstLine(value)}`;
        }
    }
    return tool;
}
function shellActivity(command) {
    const lower = command.toLowerCase();
    if (/\b(test|tests|pytest|jest|vitest|gd-test)\b/.test(lower)) {
        return 'testing';
    }
    if (/\b(build|compile|tsc|restore)\b/.test(lower)) {
        return 'building';
    }
    if (/(^|[\s;&|])(git|gh)\s/.test(lower)) {
        return 'git';
    }
    return 'shell';
}
function activityOf(tool, input) {
    if (tool === 'Bash') {
        const command = input['command'];
        return shellActivity(typeof command === 'string' ? command : '');
    }
    if (['Read', 'Grep', 'Glob', 'LSP'].includes(tool)) {
        return 'reading';
    }
    if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) {
        return 'editing';
    }
    if (['WebFetch', 'WebSearch'].includes(tool) || /browser|chrome/i.test(tool)) {
        return 'browsing';
    }
    if (tool === 'Agent') {
        return 'delegating';
    }
    if (tool === 'Skill') {
        return 'using a skill';
    }
    if (tool === 'SendMessage') {
        return 'messaging';
    }
    if (tool === 'Monitor') {
        return 'watching';
    }
    const mcpServer = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool);
    if (mcpServer !== null) {
        return mcpServer[1] ?? 'mcp';
    }
    return tool.toLowerCase();
}
function worktreeIn(input) {
    for (const field of PATH_FIELDS) {
        const value = input[field];
        if (typeof value === 'string') {
            const found = WORKTREE_PATH.exec(value);
            if (found !== null && found[1] !== undefined) {
                return found[1];
            }
        }
    }
    return undefined;
}
function shortFolder(folder, cwd) {
    if (cwd !== '' && folder.startsWith(cwd + '/')) {
        return folder.slice(cwd.length + 1);
    }
    const home = /^\/home\/[^/]+/.exec(folder);
    if (home !== null) {
        return '~' + folder.slice(home[0].length);
    }
    return folder;
}
function addSkill(skills, name) {
    const isKnown = skills.some(skill => skill.name === name);
    if (!isKnown) {
        return [...skills, { name, count: 1 }];
    }
    return skills.map(skill => (skill.name === name ? { ...skill, count: skill.count + 1 } : skill));
}
function formatSkills(skills) {
    return skills.map(skill => (skill.count > 1 ? `${skill.name} ×${skill.count}` : skill.name)).join(', ');
}
function finishNotice(row, status) {
    if (status === 'completed') {
        return `✓ ${row.type} finished: ${row.description}`;
    }
    return `✗ ${row.type} ${status}: ${row.description}`;
}
function staleFor(row, now) {
    if (!row.isListed || row.settledAt === undefined || !isSettled(row.status)) {
        return undefined;
    }
    const settledFor = now - row.settledAt;
    return settledFor >= STALE_AFTER_MS ? settledFor : undefined;
}
function isDueForReminder(row, now) {
    const isStale = staleFor(row, now) !== undefined;
    const hasBeenRemindedLately = row.remindedAt !== undefined && now - row.remindedAt < REMIND_AGAIN_AFTER_MS;
    return isStale && !hasBeenRemindedLately;
}
function staleReminder(rows, now) {
    const lines = rows.map(row => {
        const name = row.name === undefined ? '' : ` (name: ${row.name})`;
        return `- ${row.type} "${row.description}", id ${row.id}${name}: ${row.status} for ${formatDuration(now - (row.settledAt ?? now))}`;
    });
    return [
        'These subagents have finished or gone idle but are still open:',
        ...lines,
        'Stop each one you no longer need with TaskStop (task_id = its id). Keep one only if you will send it more work soon.',
    ].join('\n');
}
function closeQuietAgentRequest(row, quietFor) {
    const name = row.name === undefined ? '' : ` (name: ${row.name})`;
    return [
        `The subagent ${row.type} "${row.description}", id ${row.id}${name}, has been quiet for ${formatDuration(quietFor)}: ${row.status}, no tool running.`,
        'Is it safe to close? If you are not waiting on its result and will not send it more work, stop it with TaskStop (task_id = its id).',
        'If it is still needed, leave it running and tell me in one line why.',
    ].join('\n');
}
async function askMainAgentToClose($, row, quietFor) {
    await $.ui.toast(`Asked the main agent whether ${row.type} can be closed`);
    await $.prompt.submit({ text: closeQuietAgentRequest(row, quietFor) });
}
function backgroundTaskId(tool, result) {
    if (typeof result !== 'object' || result === null) {
        return undefined;
    }
    const record = result;
    const id = tool === 'Monitor' ? record['taskId'] : record['backgroundTaskId'];
    return typeof id === 'string' && id !== '' ? id : undefined;
}
function textOf(content) {
    if (typeof content === 'string') {
        return content;
    }
    return JSON.stringify(content ?? '');
}
function endedTaskIn(text) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
    const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
    const outputFile = /<output-file>([^<]+)<\/output-file>/.exec(text)?.[1];
    if (id === undefined || status === undefined || !isEnded(status.trim())) {
        return undefined;
    }
    return { id: id.trim(), status: status.trim(), outputFile: outputFile?.trim() };
}
function isHeavyCommand(command) {
    return HEAVY_COMMAND.test(command);
}
function serverPort(command) {
    const found = SERVER_PORT.exec(command);
    if (found === null || found[1] === undefined) {
        return undefined;
    }
    const port = Number(found[1]);
    return Number.isFinite(port) ? port : undefined;
}
function addTotals(sum, failed, passed, total) {
    const base = sum ?? { passed: 0, failed: 0, total: 0 };
    return { passed: base.passed + passed, failed: base.failed + failed, total: base.total + total };
}
function parseTestSummary(output) {
    let sum;
    const vstest = /(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/g;
    for (const match of output.matchAll(vstest)) {
        sum = addTotals(sum, Number(match[1]), Number(match[2]), Number(match[4]));
    }
    if (sum !== undefined) {
        return sum;
    }
    const summary = /Test summary:\s*total:\s*(\d+),\s*failed:\s*(\d+),\s*succeeded:\s*(\d+)/gi;
    for (const match of output.matchAll(summary)) {
        sum = addTotals(sum, Number(match[2]), Number(match[3]), Number(match[1]));
    }
    return sum;
}
function formatTests(tests) {
    if (tests.failed > 0) {
        return `✗ ${tests.failed} failed of ${tests.total}`;
    }
    return `✓ ${tests.passed} passed`;
}
function shellOutput(result) {
    if (typeof result !== 'object' || result === null) {
        return '';
    }
    const record = result;
    const stdout = typeof record['stdout'] === 'string' ? record['stdout'] : '';
    const stderr = typeof record['stderr'] === 'string' ? record['stderr'] : '';
    return `${stdout}\n${stderr}`;
}
function fileName(path) {
    return path.split('/').pop() ?? path;
}
function formatFiles(files) {
    const shown = files.slice(-3).map(fileName).join(', ');
    const more = files.length > 3 ? ` (+${files.length - 3})` : '';
    return shown + more;
}
function addFile(files, path) {
    return [...files.filter(one => one !== path), path].slice(-MAX_FILES);
}
function sharedFiles(row, rows, mainFiles) {
    if (isEnded(row.status)) {
        return [];
    }
    const shared = [];
    for (const file of row.files) {
        const other = rows.find(one => one.id !== row.id && !isEnded(one.status) && one.files.includes(file));
        if (other !== undefined) {
            shared.push({ file, with: other.type });
        }
        else if (mainFiles.includes(file)) {
            shared.push({ file, with: 'main agent' });
        }
    }
    return shared;
}
function orderAsTree(rows) {
    const ids = rows.map(row => row.id);
    const childrenOf = (parentId) => rows
        .filter(row => (parentId === undefined ? row.parentId === undefined || !ids.includes(row.parentId) : row.parentId === parentId))
        .reverse();
    const ordered = [];
    const visit = (row, depth) => {
        ordered.push({ row, depth });
        for (const child of childrenOf(row.id)) {
            visit(child, depth + 1);
        }
    };
    for (const root of childrenOf(undefined)) {
        visit(root, 0);
    }
    return ordered;
}
async function refreshAgents($) {
    const live = await $.agent.list();
    const now = await $.clock.now();
    const stored = await read($, agents);
    const finished = [];
    const merged = stored.map(row => {
        const found = live.find(agent => agent.id === row.id);
        const nextStatus = found === undefined ? (isEnded(row.status) ? row.status : 'completed') : found.status;
        const hasJustEnded = !isEnded(row.status) && isEnded(nextStatus);
        if (hasJustEnded) {
            finished.push(finishNotice(row, nextStatus));
        }
        const hasJustSettled = isSettled(nextStatus) && (!isSettled(row.status) || row.settledAt === undefined);
        const settledAt = isSettled(nextStatus) ? (hasJustSettled ? now : row.settledAt) : undefined;
        return {
            ...row,
            status: nextStatus,
            isListed: found !== undefined,
            settledAt,
            name: found === undefined ? row.name : found.name,
            parentId: found === undefined ? row.parentId : found.parentId,
            description: found === undefined ? row.description : found.description,
            endedAt: hasJustEnded ? now : row.endedAt,
        };
    });
    for (const agent of live) {
        const isNew = !merged.some(row => row.id === agent.id);
        if (isNew) {
            merged.push({
                id: agent.id,
                type: agent.type,
                description: agent.description,
                status: agent.status,
                parentId: agent.parentId,
                name: agent.name,
                skills: [],
                files: [],
                toolsInFlight: 0,
                isListed: true,
                settledAt: isSettled(agent.status) ? now : undefined,
                startedAt: now,
                endedAt: isEnded(agent.status) ? now : undefined,
                lastActiveAt: now,
            });
        }
    }
    const kept = merged.slice(-MAX_ROWS);
    if (JSON.stringify(stored) !== JSON.stringify(kept)) {
        await update($, agents, () => kept);
    }
    for (const notice of finished) {
        $.ui.toast(notice);
    }
    return kept;
}
async function changeAgent($, agentId, change) {
    const rows = await read($, agents);
    const isKnown = rows.some(row => row.id === agentId);
    if (!isKnown) {
        await refreshAgents($);
    }
    const now = await $.clock.now();
    await update($, agents, list => list.map(row => (row.id === agentId ? change(row, now) : row)));
}
async function remindAboutStaleAgents($, ran) {
    if (ran.deny !== undefined) {
        return ran;
    }
    const rows = await refreshAgents($);
    const now = await $.clock.now();
    const due = rows.filter(row => isDueForReminder(row, now));
    if (due.length === 0) {
        return ran;
    }
    const dueIds = due.map(row => row.id);
    await update($, agents, list => list.map(row => (dueIds.includes(row.id) ? { ...row, remindedAt: now } : row)));
    return { ...ran, context: [...(ran.context ?? []), staleReminder(due, now)] };
}
async function trackBackgroundTask($, tool, input, result, ownerAgentId) {
    const id = backgroundTaskId(tool, result);
    if (id === undefined) {
        return;
    }
    const now = await $.clock.now();
    const isMonitor = tool === 'Monitor';
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    const description = typeof input['description'] === 'string' ? input['description'] : '';
    const port = isMonitor ? undefined : serverPort(command);
    const kind = isMonitor ? 'monitor' : port !== undefined ? 'server' : 'shell';
    const activity = isMonitor ? 'watching' : port !== undefined ? `server :${port}` : shellActivity(command);
    const task = {
        id,
        kind,
        port,
        isHeavy: !isMonitor && port === undefined && isHeavyCommand(command),
        activity,
        label: firstLine(isMonitor ? description || command : command || description),
        ownerAgentId,
        status: 'running',
        startedAt: now,
    };
    await update($, tasks, list => [...list.filter(one => one.id !== id), task].slice(-MAX_TASKS));
}
async function endBackgroundTask($, id, status, outputFile) {
    const now = await $.clock.now();
    const task = (await read($, tasks)).find(one => one.id === id);
    const tests = task !== undefined && task.activity === 'testing' ? await readTestResult($, outputFile) : undefined;
    await update($, tasks, list => list.map(one => (one.id === id && !isEnded(one.status) ? { ...one, status, endedAt: now, tests } : one)));
    if (tests !== undefined && task?.ownerAgentId !== undefined) {
        await changeAgent($, task.ownerAgentId, row => ({ ...row, tests }));
    }
    if (tests !== undefined && task !== undefined && task.ownerAgentId === undefined) {
        await update($, main, current => ({ ...current, tests }));
    }
}
async function readTestResult($, outputFile) {
    if (outputFile === undefined) {
        return undefined;
    }
    try {
        return parseTestSummary(await $.fs.read(outputFile));
    }
    catch {
        return undefined;
    }
}
async function startHeavyRun($, id, command, agentId) {
    if (!isHeavyCommand(command)) {
        return;
    }
    await update($, heavyRuns, list => [...list.filter(one => one.id !== id), { id, label: firstLine(command), agentId }]);
}
async function endHeavyRun($, id) {
    const list = await read($, heavyRuns);
    if (list.some(one => one.id === id)) {
        await update($, heavyRuns, current => current.filter(one => one.id !== id));
    }
}
async function recordShellResult($, command, result, agentId) {
    if (shellActivity(command) !== 'testing') {
        return;
    }
    const tests = parseTestSummary(shellOutput(result));
    if (tests === undefined) {
        return;
    }
    if (agentId === undefined) {
        await update($, main, current => ({ ...current, tests }));
        return;
    }
    await changeAgent($, agentId, row => ({ ...row, tests }));
}
async function recordEditedFile($, path, agentId) {
    const before = await read($, agents);
    const mainBefore = await read($, main);
    if (agentId === undefined) {
        await update($, main, current => ({ ...current, files: addFile(current.files, path) }));
    }
    else {
        await changeAgent($, agentId, row => ({ ...row, files: addFile(row.files, path) }));
    }
    const editor = agentId === undefined ? 'main agent' : before.find(row => row.id === agentId)?.type ?? 'an agent';
    const otherEditor = before.find(row => row.id !== agentId && !isEnded(row.status) && row.files.includes(path));
    const isMainOther = agentId !== undefined && mainBefore.files.includes(path);
    const isNewClash = otherEditor !== undefined || isMainOther;
    const wasEditedByThisOneBefore = agentId === undefined ? mainBefore.files.includes(path) : before.find(row => row.id === agentId)?.files.includes(path) === true;
    if (isNewClash && !wasEditedByThisOneBefore) {
        const other = otherEditor === undefined ? 'main agent' : otherEditor.type;
        $.ui.toast(`⚠ ${editor} and ${other} both edited ${fileName(path)}`);
    }
}
async function recordToolResult($, tool, input, result, agentId) {
    if (tool === 'Bash' && input['run_in_background'] !== true) {
        await recordShellResult($, String(input['command'] ?? ''), result, agentId);
    }
    const path = input['file_path'] ?? input['notebook_path'];
    if (EDIT_TOOLS.includes(tool) && typeof path === 'string') {
        await recordEditedFile($, path, agentId);
    }
}
async function openPane($) {
    await $.ui.open({ id: PANE, title: TITLE });
}
export const register = on => {
    on('session.start', async ($, e, next) => {
        await update($, sessionCwd, () => e.cwd);
        await $.command.register({
            name: 'agents-sidebar',
            description: 'Show the subagents of this session in the right-hand pane',
        });
        $.clock.every(1000, async () => {
            const rows = await read($, agents);
            const backgroundTasks = await read($, tasks);
            const hasActive = rows.some(row => !isEnded(row.status)) || backgroundTasks.some(task => !isEnded(task.status));
            if (hasActive) {
                const now = await $.clock.now();
                await update($, clock, () => now);
                await refreshAgents($);
            }
        });
        const rows = await refreshAgents($);
        if (rows.length > 0) {
            void openPane($);
        }
        return next(e);
    });
    on('command.run', { command: 'agents-sidebar' }, async ($) => {
        await refreshAgents($);
        await openPane($);
        return { text: 'Agents pane opened.' };
    });
    on('agent.spawn', async ($, e, next) => {
        const spawned = await next(e);
        await refreshAgents($);
        const agentId = spawned.agentId;
        if (agentId !== undefined) {
            const model = spawned.model;
            const folder = e.cwd;
            await changeAgent($, agentId, row => ({
                ...row,
                model: model ?? row.model,
                folder: folder ?? row.folder,
            }));
        }
        void openPane($);
        return spawned;
    });
    on('tool.call', async ($, e, next) => {
        const input = e;
        const agentId = e.agentId;
        if (agentId === undefined) {
            const command = e.tool === 'Bash' ? String(input['command'] ?? '') : '';
            const isForeground = e.tool === 'Bash' && input['run_in_background'] !== true;
            if (isForeground) {
                await startHeavyRun($, e.tool_use_id, command, undefined);
            }
            let ran;
            try {
                ran = await next(e);
            }
            finally {
                await endHeavyRun($, e.tool_use_id);
            }
            if (ran.deny === undefined) {
                await trackBackgroundTask($, e.tool, input, ran.result, undefined);
                await recordToolResult($, e.tool, input, ran.result, undefined);
            }
            return remindAboutStaleAgents($, ran);
        }
        const doing = describeToolCall(e.tool, input);
        const activity = activityOf(e.tool, input);
        const worktree = worktreeIn(input);
        const skillName = e.tool === 'Skill' ? input['skill'] : undefined;
        await changeAgent($, agentId, (row, now) => ({
            ...row,
            now: doing,
            activity,
            folder: worktree ?? row.folder,
            skills: skillName === undefined ? row.skills : addSkill(row.skills, skillName),
            toolsInFlight: row.toolsInFlight + 1,
            lastActiveAt: now,
        }));
        const command = e.tool === 'Bash' ? String(input['command'] ?? '') : '';
        if (e.tool === 'Bash' && input['run_in_background'] !== true) {
            await startHeavyRun($, e.tool_use_id, command, agentId);
        }
        try {
            const ran = await next(e);
            if (ran.deny === undefined) {
                await trackBackgroundTask($, e.tool, input, ran.result, agentId);
                await recordToolResult($, e.tool, input, ran.result, agentId);
            }
            return ran;
        }
        finally {
            await endHeavyRun($, e.tool_use_id);
            await changeAgent($, agentId, (row, now) => ({
                ...row,
                toolsInFlight: Math.max(0, row.toolsInFlight - 1),
                activity: row.toolsInFlight <= 1 ? 'thinking' : row.activity,
                lastActiveAt: now,
            }));
        }
    });
    on('turn.step', async function* ($, e, next) {
        const step = yield* next(e);
        const agentId = e.agentId;
        if (agentId !== undefined) {
            await changeAgent($, agentId, (row, now) => ({ ...row, model: e.model, lastActiveAt: now }));
        }
        return step;
    });
    on('turn.complete', async ($, e, next) => {
        const result = await next(e);
        const agentId = e.agentId;
        if (agentId !== undefined) {
            await refreshAgents($);
            const answer = firstLine(e.answer ?? '');
            if (answer !== '') {
                await changeAgent($, agentId, row => ({ ...row, answer }));
            }
        }
        return result;
    });
    on('session.append', async ($, e, next) => {
        const stored = await next(e);
        if (e.origin.kind === 'task-notification') {
            const ended = endedTaskIn(textOf(e.message.content));
            if (ended !== undefined) {
                await endBackgroundTask($, ended.id, ended.status, ended.outputFile);
            }
        }
        return stored;
    });
    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
        const { Box, Text, Button } = $.ui.resolve(e);
        const storedRows = await read($, agents);
        const backgroundTasks = await read($, tasks);
        const cwd = await read($, sessionCwd);
        const runsInFlight = await read($, heavyRuns);
        const mainAgent = await read($, main);
        await read($, clock);
        const now = await $.clock.now();
        const viewedAgentId = e.props.view.agentId;
        const rows = storedRows.filter(row => isStillShown(row, viewedAgentId));
        const runningCount = rows.filter(row => !isEnded(row.status)).length;
        const doneCount = rows.filter(row => row.status === 'completed').length;
        const failedCount = rows.filter(row => row.status === 'failed' || row.status === 'killed').length;
        const heavyCount = runsInFlight.length + backgroundTasks.filter(task => task.isHeavy && !isEnded(task.status)).length;
        const shownTasks = backgroundTasks
            .filter(task => !isEnded(task.status) || now - (task.endedAt ?? now) < SHOW_ENDED_TASK_FOR_MS)
            .reverse();
        return (<Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {runningCount} running · {doneCount} done · {failedCount} failed
        </Text>
        {heavyCount >= HEAVY_RUN_LIMIT && (<Text color="#ff8800" bold wrap="truncate-end">
            ⚠ {heavyCount} builds/tests at once (limit {HEAVY_RUN_LIMIT}): memory risk
          </Text>)}
        {shownTasks.length > 0 && (<Box flexDirection="column" marginTop={1}>
            <Text bold>Background</Text>
            {shownTasks.map(task => {
                    const owner = rows.find(row => row.id === task.ownerAgentId);
                    const ownerLabel = owner === undefined ? '' : ` · ${owner.type}`;
                    const elapsed = formatDuration((task.endedAt ?? now) - task.startedAt);
                    return (<Box key={'task-' + task.id} flexDirection="column">
                  <Text color={statusColor(task.status)} wrap="truncate-end">
                    {statusIcon(task.status)} {task.activity} · {elapsed}
                    {ownerLabel}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'   '}
                    {task.label}
                  </Text>
                  {task.tests !== undefined && (<Text color={task.tests.failed > 0 ? 'red' : 'green'} wrap="truncate-end">
                      {'   tests: '}
                      {formatTests(task.tests)}
                    </Text>)}
                </Box>);
                })}
          </Box>)}
        <Box marginTop={1}>
          <Button key="main" plain label={viewedAgentId === undefined ? '▶ Main agent' : '  Main agent'} onPress={() => $.ui.view({})}/>
        </Box>
        {mainAgent.tests !== undefined && (<Text color={mainAgent.tests.failed > 0 ? 'red' : 'green'} wrap="truncate-end">
            {'   tests: '}
            {formatTests(mainAgent.tests)}
          </Text>)}
        {rows.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {orderAsTree(rows).map(({ row, depth }) => {
                const indent = '  '.repeat(depth);
                const pad = indent + '   ';
                const isActive = !isEnded(row.status);
                const marker = row.id === viewedAgentId ? '▶' : statusIcon(row.status);
                const branch = depth > 0 ? '└ ' : '';
                const elapsed = formatDuration((row.endedAt ?? now) - row.startedAt);
                const model = row.model === undefined ? '' : ` · ${shortModel(row.model)}`;
                const activity = isActive && row.status === 'running' && row.activity !== undefined ? ` · ${row.activity}` : '';
                const quietFor = now - row.lastActiveAt;
                const isQuiet = isActive && row.toolsInFlight === 0 && quietFor >= QUIET_AFTER_MS;
                const isLongTool = isActive && row.toolsInFlight > 0 && quietFor >= QUIET_AFTER_MS;
                const nowLine = row.now === undefined ? undefined : isLongTool ? `${row.now} (${formatDuration(quietFor)})` : row.now;
                const stale = staleFor(row, now);
                const clashes = sharedFiles(row, rows, mainAgent.files);
                const isSettledOrEnded = !isActive || row.status === 'idle';
                return (<Box key={row.id} flexDirection="column" marginTop={1}>
              <Button key={'view-' + row.id} plain dimColor={!isActive} label={`${indent}${branch}${marker} ${row.type}${activity} · ${elapsed}${model}`} onPress={() => $.ui.view({ agentId: row.id })}/>
              <Text color={statusColor(row.status)} wrap="truncate-end">
                {pad}
                {row.status} · {row.description}
              </Text>
              {row.folder !== undefined && (<Text color="magenta" wrap="truncate-start">
                  {pad}
                  {'folder: '}
                  {shortFolder(row.folder, cwd)}
                </Text>)}
              {isActive && nowLine !== undefined && (<Text dimColor wrap="truncate-end">
                  {pad}
                  {'now: '}
                  {nowLine}
                </Text>)}
              {row.files.length > 0 && (<Text wrap="truncate-end">
                  {pad}
                  {'files: '}
                  {formatFiles(row.files)}
                </Text>)}
              {clashes.map(clash => (<Text key={'clash-' + row.id + clash.file} color="red" bold wrap="truncate-end">
                  {pad}
                  {'⚠ same file as '}
                  {clash.with}
                  {': '}
                  {fileName(clash.file)}
                </Text>))}
              {row.tests !== undefined && (<Text color={row.tests.failed > 0 ? 'red' : 'green'} wrap="truncate-end">
                  {pad}
                  {'tests: '}
                  {formatTests(row.tests)}
                </Text>)}
              {isSettledOrEnded && row.answer !== undefined && (<Text dimColor italic wrap="truncate-end">
                  {pad}
                  {'→ '}
                  {row.answer}
                </Text>)}
              {row.skills.length > 0 && (<Text color="cyan" wrap="truncate-end">
                  {pad}
                  {'skills: '}
                  {formatSkills(row.skills)}
                </Text>)}
              {stale !== undefined && (<Text color="#ff8800" bold wrap="truncate-end">
                  {pad}
                  {'⚠ still open '}
                  {formatDuration(stale)}
                  {row.remindedAt === undefined ? '' : ' · main agent reminded'}
                </Text>)}
              {isQuiet && (<Button key={'quiet-' + row.id} plain label={`${pad}⚠ quiet ${formatDuration(quietFor)} · click to ask main agent to close`} onPress={() => askMainAgentToClose($, row, quietFor)}/>)}
            </Box>);
            })}
      </Box>);
    });
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const viewedAgentId = e.props.view.agentId;
        if (viewedAgentId === undefined || e.props.hasSurvey) {
            return next(e);
        }
        const { Box, Text, Button } = $.ui.resolve(e);
        const rows = await read($, agents);
        const viewed = rows.find(row => row.id === viewedAgentId);
        const name = viewed === undefined ? 'subagent' : `${viewed.type} – ${viewed.description}`;
        return (<Box flexDirection="row" backgroundColor="yellow" paddingX={1} width="100%">
        <Box flexGrow={1}>
          <Text color="black" backgroundColor="yellow" bold wrap="truncate-end">
            ⚠ VIEWING SUBAGENT: {name}. Your next message goes to this subagent, not the main agent.
          </Text>
        </Box>
        <Button key="back" label="Back to main" onPress={() => $.ui.view({})}/>
      </Box>);
    });
};
