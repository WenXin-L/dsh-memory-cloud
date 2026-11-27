#!/usr/bin/env node
// Credential-free end-to-end check of dsh-memory-cloud-brain inside a real DSH host.
// See scripts/e2e/README.md. Needs Node >= 24.9, pnpm on PATH, and npm registry access
// only to install @deepseek-ai/dsh (skip with --dsh-dir).
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DSH_VERSION = process.env.DSH_VERSION ?? '0.2.2-rc.5'
const SCENARIOS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7']
const PROMPT_VERSION = 'memory-cloud-summary/3'
const PROMISE = '答应周五前把报告发给老板'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
if (flag('--help') || flag('-h')) {
  console.log(`node scripts/e2e/run-e2e.mjs [--keep] [--skip-build] [--dsh-dir <dir>] [--only s1,s2,...]

— 端到端检查 / End-to-end checks —
  --keep         保留临时目录和测试插件 / Keep the test home, logs and test plugins
  --skip-build   使用已有构建 / Use the existing plugin build
  --dsh-dir      使用已有 DSH 安装目录 / Use an existing DSH installation directory
  --only         按编号选择场景 / Run selected scenarios in order (s1–s7)`)
  process.exit(0)
}
const only = new Set((option('--only') ?? SCENARIOS.join(',')).split(',').map(item => item.trim()).filter(Boolean))

// ---------------------------------------------------------------------------
// Test-only plugins. Serialized with Function#toString into the temp dir; they
// never ship with the package.
// ---------------------------------------------------------------------------

/** Scripted LLM adapter `fake` (no network). Conversation directives: [[long:N]], [[steps:K:N]], [[search:q]], [[read:id]], [[raw:id]]. */
function fakeLlmPlugin(LlmAdapter, LlmError, appendFileSync) {
  const FACT = /【事实：([^】]{1,40})】/g
  const textOf = content => (Array.isArray(content)
    ? content.map(block => (block?.type === 'text' || block?.type === 'reasoning' ? block.text ?? '' : block?.type === 'tool-call' ? `${block.name} ${block.arguments}` : '')).join('\n')
    : typeof content === 'string' ? content : '')
  const estimate = (text) => {
    let cjk = 0
    for (const char of text) if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(char)) cjk += 1
    return Math.ceil((cjk * 0.6 + (text.length - cjk) * 0.3) * 1.15)
  }
  const filler = (n, seed) => {
    const parts = ['今天我们继续聊天，', '这句话只是为了把上下文撑大一些，', '没有特别的含义，', '请把它当作普通的闲聊记录，', `第${seed}轮的补充说明，`]
    let out = ''
    for (let i = 0; out.length < n; i++) out += parts[i % parts.length]
    return `${out.slice(0, n)}。`
  }
  const facts = text => [...new Set([...text.matchAll(FACT)].map(match => match[1]))]
  const dueIn = days => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const stripMemory = text => text.replace(/<memory-cloud[\s\S]*?<\/memory-cloud>/g, '').replace(/<compacted-summary>[\s\S]*?<\/compacted-summary>/g, '')
  const isPrompt = message => message.role === 'user' && (message.source === undefined || message.source.kind === 'user')
  const steps = new Map()
  let counter = 0

  function fields(found, label, pad) {
    const shown = found.length === 0 ? ['日常闲聊'] : found
    const detail = pad > 0 ? `\n\n## 细节\n${filler(pad, 'x')}` : ''
    return {
      gist: `${label}：聊到${shown.slice(0, 2).join('、')}`.slice(0, 22),
      summary: `## 发生了什么\n${shown.slice(0, 8).map(fact => `- 用户提到${fact}`).join('\n')}\n\n## 关键事实\n${shown.slice(0, 4).join('；')}${detail}`,
      ongoing: ['继续测试记忆云'],
      importance: 6,
      keywords: shown.slice(0, 4).map(fact => fact.slice(0, 6)),
      people: ['用户'],
      dates: [{ date: '2026-11-23', what: '端到端测试' }],
      promises: shown.filter(fact => fact.startsWith('答应')).map(what => ({ what, who: '用户', due: dueIn(7) })),
    }
  }
  function* text(value, usage) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  function* tool(id, name, args, usage, prefix) {
    const json = JSON.stringify(args)
    let index = 0
    if (prefix !== undefined) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: prefix }
      yield { type: 'block-end', index, block: { type: 'text', text: prefix } }
      index += 1
    }
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: json }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  class FakeAdapter extends LlmAdapter {
    constructor(config) {
      super()
      this.config = config
    }

    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.config.contextWindow }, defaultMaxTokens: this.config.defaultMaxTokens })
    }

    listModels(provider) {
      return Promise.resolve([{ provider, id: 'fake-1', name: 'fake-1' }])
    }

    record(entry) {
      if (this.config.logFile) appendFileSync(this.config.logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
    }

    async * stream(options) {
      const n = ++counter
      const messages = options.messages ?? []
      const all = [options.system ?? '', JSON.stringify(options.tools ?? []), ...messages.map(message => textOf(message.content))].join('\n')
      const inputTokens = estimate(all)
      const usage = out => ({ inputTokens, outputTokens: Math.max(1, estimate(out)) })
      const lastText = messages.length === 0 ? '' : textOf(messages.at(-1).content)
      const base = { n, purpose: options.purpose ?? 'conversation', sessionId: options.sessionId ?? null, messages: messages.length, inputTokens }

      if (options.purpose === 'memory-cloud-summarize') {
        const rollup = (options.system ?? '').includes('时期总结')
        const transcript = (options.tools ?? []).some(item => item.name === 'memory_save')
        const kind = rollup ? 'rollup' : transcript ? 'transcript' : 'replay'
        const retry = /上面的(输出|结果)/.test(lastText)
        if (this.config.summarize === 'throw') {
          this.record({ ...base, kind, retry, result: 'throw' })
          throw new LlmError('e2e fake summarizer failure', 'E2E_FAKE_FAILURE')
        }
        if (this.config.summarize === 'garbage') {
          this.record({ ...base, kind, retry, result: 'garbage' })
          yield * text('嗯……我不太确定该怎么回答。', usage('x'))
          return
        }
        if (rollup) {
          const out = `这段时期主要在做端到端测试，${facts(lastText).slice(0, 3).join('、') || '记录了几次闲聊'}。`
          this.record({ ...base, kind, retry, result: 'text' })
          yield * text(out, usage(out))
          return
        }
        if (transcript) {
          const body = /<transcript>([\s\S]*)<\/transcript>/.exec(lastText)?.[1] ?? lastText
          const result = fields(facts(stripMemory(body)), '片段', this.config.summaryPad)
          this.record({ ...base, kind, retry, result: 'memory_save', facts: facts(stripMemory(body)) })
          yield * tool(`call_sum_${n}`, 'memory_save', result, usage(JSON.stringify(result)))
          return
        }
        const region = messages.slice(0, -1).map(message => stripMemory(textOf(message.content))).join('\n')
        const result = fields(facts(region), '检查点', this.config.summaryPad)
        const out = `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``
        this.record({ ...base, kind, retry, result: 'json', facts: facts(region), tools: (options.tools ?? []).length })
        yield * text(out, usage(out))
        return
      }
      if (options.purpose === 'compaction') {
        const region = messages.slice(0, -1).map(message => stripMemory(textOf(message.content))).join('\n')
        const out = `DEFAULT-SUMMARY (compaction-basic): ${facts(region).join(', ') || 'no facts'}`
        this.record({ ...base, kind: 'default-compaction', result: 'text' })
        yield * text(out, usage(out))
        return
      }
      if (options.purpose !== undefined) {
        this.record({ ...base, kind: 'other', result: 'text' })
        yield * text('E2E 测试会话', usage('E2E'))
        return
      }

      const prompt = textOf(messages.findLast(isPrompt)?.content)
      const last = messages.findLast(message => !(message.role === 'user' && !isPrompt(message)))
      const memoryBlocks = messages.filter(message => message.role === 'user' && message.source?.kind === 'memory-cloud').length
      const conv = { ...base, kind: 'conversation', memoryBlocks, prompt: prompt.slice(0, 60) }
      const key = options.sessionId ?? 'none'
      const stepMatch = /\[\[steps:(\d+):(\d+)\]\]/.exec(prompt)
      let state = steps.get(key)
      if (stepMatch !== null && state?.prompt !== prompt) {
        state = { prompt, wanted: Number(stepMatch[1]), size: Number(stepMatch[2]), done: 0, active: true }
        steps.set(key, state)
      }
      if (state?.active && (last?.role === 'tool' || state.done === 0)) {
        if (state.done < state.wanted) {
          state.done += 1
          const say = `第${state.done}步：${filler(state.size, `${n}-${state.done}`)}`
          this.record({ ...conv, result: 'step', step: state.done })
          yield * tool(`call_step_${n}`, 'memory_search', { query: `步骤${state.done}` }, usage(say), say)
          return
        }
        state.active = false
        this.record({ ...conv, result: 'steps-done' })
        yield * text(`完成了${state.wanted}步。`, usage('done'))
        return
      }
      if (last?.role === 'tool') {
        const result = textOf(last.content)
        this.record({ ...conv, result: 'answer-after-tool', toolResultChars: result.length })
        yield * text(`【工具结果回显】\n${result.slice(0, 1500)}`, usage(result))
        return
      }
      const directive = /\[\[(search|read|raw|long):([^\]]*)\]\]/.exec(prompt)
      if (directive !== null && directive[1] === 'search') {
        this.record({ ...conv, result: 'tool:memory_search' })
        yield * tool(`call_${n}`, 'memory_search', { query: directive[2] }, usage(directive[2]))
        return
      }
      if (directive !== null && directive[1] !== 'long') {
        const args = { id: directive[2], level: directive[1] === 'raw' ? 'raw' : 'summary' }
        this.record({ ...conv, result: 'tool:memory_read', args })
        yield * tool(`call_${n}`, 'memory_read', args, usage(JSON.stringify(args)))
        return
      }
      const size = directive !== null ? Number(directive[2]) : 400
      const found = facts(prompt)
      const out = `好的，我记住了${found.length > 0 ? found.map(fact => `「${fact}」`).join('') : '这一轮'}。${filler(size, n)}`
      this.record({ ...conv, result: 'text' })
      yield * text(out, usage(out))
    }
  }

  return {
    name: 'e2e-fake-llm',
    inject: ['llm'],
    apply(ctx, config = {}) {
      ctx.llm.registerAdapter(['fake'], new FakeAdapter({ contextWindow: 32768, defaultMaxTokens: 2000, summarize: 'ok', summaryPad: 0, ...config }))
    },
  }
}

/** Probe: log exporter, host-API actions at the end of a turn, and a host-side web driver. */
function probePlugin(appendFileSync, format) {
  return {
    name: 'e2e-probe',
    apply(ctx, config = {}) {
      const write = entry => appendFileSync(config.out, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
      // Registered without an effect so the shutdown logs of every plugin are captured too.
      ctx.root.logger.exporters.set(1e9, {
        levels: { default: 3 },
        export: (message) => {
          try {
            appendFileSync(config.logFile, `${new Date(message.ts).toISOString()} [${message.type}] ${message.name}: ${format(...message.args)}\n`)
          } catch {}
        },
      })
      process.on('unhandledRejection', reason => write({ action: 'unhandledRejection', reason: String(reason?.stack ?? reason) }))
      process.on('exit', code => write({ action: 'exit', code }))
      const memory = () => ctx.get('memoryCloud').api
      const engineOf = agent => ctx.get('agentPresets')?.serviceFor?.(agent, 'compaction') ?? ctx.get('compaction')
      const brandOf = service => service?.[Symbol.for('dsh-memory-cloud-brain.engine')] === true
      const checkpoints = (session) => {
        const found = []
        for (let seq = 0; seq < session.seq; seq++) {
          const event = session.eventAt(seq)
          if (event?.type !== 'user/message' || !['compact-checkpoint', 'memory-cloud'].includes(event.data?.source?.kind)) continue
          const body = (event.data.content ?? []).map(block => block.text ?? '').join('')
          found.push({ seq, kind: event.data.source.kind, memoryCloud: body.includes('<memory-cloud>'), defaultSummary: body.includes('DEFAULT-SUMMARY'), chars: body.length, visible: session.surface.nodes.includes(seq) })
        }
        return found
      }
      const compositions = () => (ctx.get('agentPresets')?.inspectCompositions?.() ?? [])
        .map(item => ({ id: item.id, modules: item.modules.map(module => module.moduleName).filter(name => /compaction|memory-cloud/.test(name)) }))

      let done = false
      ctx.on('agent/turn-stopping', async ({ agent }) => {
        if (done) return
        done = true
        for (const action of config.actions ?? []) {
          try {
            let result
            if (action === 'takeover') result = await memory().takeover()
            else if (action === 'restore') result = await memory().restore()
            else if (action === 'level5') result = await memory().setLevel(5)
            else if (action === 'level3') result = await memory().setLevel(3)
            else if (action === 'status') result = await memory().status(agent.session.id)
            else if (action === 'checkpoints') result = checkpoints(agent.session)
            else if (action.startsWith('unmatched:')) {
              const remote = ctx.get('memoryCloudRemote')
              const set = await remote.setConfig({ unmatchedSessions: action.slice('unmatched:'.length) })
              result = { ...set, live: (await remote.getConfig()).config.unmatchedSessions }
            }
            else if (action === 'engine') {
              const service = engineOf(agent)
              result = { name: service?.constructor?.name, brand: brandOf(service) }
            } else if (action.startsWith('cmd:')) {
              const execution = await ctx.get('commands').execute(agent, action.slice(4), [], new AbortController().signal)
              result = execution?.result ?? { error: 'command not found' }
            } else result = { error: `unknown action ${action}` }
            write({ action, session: agent.session.id, result })
          } catch (error) {
            write({ action, error: String(error?.stack ?? error) })
          }
        }
      })

      if (!config.webScript) return
      const agents = new Map()
      const waiters = new Map()
      ctx.on('agent/created', ({ agent }) => { agents.set(agent.session.id, agent) })
      ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        const waiter = waiters.get(agent.session.id)
        if (waiter !== undefined) {
          waiters.delete(agent.session.id)
          waiter()
        }
      })
      const converse = async (label, prompt) => {
        const controller = ctx.get('sessionController')
        const created = await controller.create({ cwd: config.cwd })
        const idle = new Promise(resolve => waiters.set(created.sessionId, resolve))
        await controller.prompt({ requestId: `e2e-${label}-${Date.now()}`, sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, new AbortController().signal)
        await Promise.race([idle, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no idle within 90 s`)), 90_000))])
        await new Promise(resolve => setTimeout(resolve, 500))
        const agent = agents.get(created.sessionId)
        const service = agent === undefined ? undefined : engineOf(agent)
        const status = await memory().status(created.sessionId)
        return { session: created.sessionId, preset: agent?.session.header.agentPreset, engine: service?.constructor?.name, brand: brandOf(service), mode: status.agent?.mode?.mode, checkpoints: agent === undefined ? [] : checkpoints(agent.session) }
      }
      ctx.effect(() => {
        const timer = setTimeout(async () => {
          const step = async (label, run) => {
            try {
              write({ action: label, result: await run() })
            } catch (error) {
              write({ action: label, error: String(error?.stack ?? error) })
            }
          }
          await step('web:loaded', async () => ({ memoryCloud: ctx.get('memoryCloud') !== undefined, compositions: compositions() }))
          await step('web:level5', () => memory().setLevel(5))
          await step('web:assist', () => converse('assist', '网页会话：【事实：网页端测试】[[long:200]]'))
          await step('web:takeover', () => memory().takeover())
          await step('web:compositions-after-takeover', async () => compositions())
          await step('web:engine', () => converse('engine', '网页引擎会话：【事实：网页引擎测试】请分步骤完成。[[steps:14:3000]]'))
          await step('web:restore', () => memory().restore())
          write({ action: 'web:done' })
        }, 3000)
        return () => clearTimeout(timer)
      })
    },
  }
}

function pluginModule(factory, imports, args) {
  return [
    ...imports,
    `const plugin = (${factory.toString()})(${args})`,
    'export const name = plugin.name',
    'export const inject = plugin.inject',
    'export const apply = plugin.apply',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'mcb-e2e-'))
const paths = {
  home: join(work, 'home'),
  dshHome: join(work, 'dsh-home'),
  cwd: join(work, 'cwd'),
  logs: join(work, 'logs'),
  overlays: join(work, 'overlays'),
}
for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true })
const dshDir = option('--dsh-dir') === undefined ? join(work, 'dsh') : resolve(option('--dsh-dir'))
const pluginDir = join(dshDir, `.mcb-e2e-plugins-${process.pid}`)
const files = {
  llm: join(paths.logs, 'llm.jsonl'),
  probe: join(paths.logs, 'probe.jsonl'),
  dsh: join(paths.logs, 'dsh.log'),
}
const memoryRoot = join(paths.dshHome, 'memory-cloud')
const results = []
let current = 'setup'
let webProcess

function which(command) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, command))) return dir
  }
  return undefined
}

const hostPath = [...new Set([dirname(process.execPath), which('pnpm'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean))].join(delimiter)
/** The DSH process environment: nothing inherited (no credentials), throwaway HOME and DSH_HOME, telemetry off. */
const dshEnv = { PATH: hostPath, HOME: paths.home, DSH_HOME: paths.dshHome, DSH_TELEMETRY_DISABLED: '1', TERM: 'dumb' }
const dshBin = () => join(dshDir, 'node_modules', '.bin', 'dsh')

function log(message, ...args) {
  console.log(`[e2e] ${format(message, ...args)}`)
}

function check(name, ok, detail = '') {
  results.push({ scenario: current, name, ok: Boolean(ok), detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${current} · ${name}${detail === '' ? '' : ` — ${detail}`}`)
  return Boolean(ok)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 180_000, cwd: options.cwd ?? work, env: options.env ?? dshEnv })
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function jsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** Line offsets so a check reads only what one step appended. */
function mark() {
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, existsSync(file) ? readFileSync(file, 'utf8').length : 0]))
}
function since(at, key) {
  return existsSync(files[key]) ? readFileSync(files[key], 'utf8').slice(at[key]) : ''
}
function sinceJsonl(at, key) {
  return since(at, key).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function overlay(name, settings = {}) {
  const yaml = [
    '- id: agent-default-model',
    '  config:',
    '    provider: fake',
    '    model: fake-1',
    '- insert:',
    '    - id: e2e-fake-llm',
    `      name: ${JSON.stringify(join(pluginDir, 'fake-llm.mjs'))}`,
    '      config:',
    `        contextWindow: ${settings.window ?? 32768}`,
    '        defaultMaxTokens: 2000',
    `        summarize: ${settings.summarize ?? 'ok'}`,
    '        summaryPad: 900',
    `        logFile: ${JSON.stringify(files.llm)}`,
    '    - id: e2e-probe',
    `      name: ${JSON.stringify(join(pluginDir, 'probe.mjs'))}`,
    '      config:',
    `        out: ${JSON.stringify(files.probe)}`,
    `        logFile: ${JSON.stringify(files.dsh)}`,
    `        actions: ${JSON.stringify(settings.actions ?? [])}`,
    `        webScript: ${settings.webScript === true}`,
    `        cwd: ${JSON.stringify(paths.cwd)}`,
    ...settings.extra ?? [],
    '',
  ].join('\n')
  const file = join(paths.overlays, `${name}.yml`)
  writeFileSync(file, yaml)
  return file
}

/** One headless task; `session` resumes an existing Session. */
function turn(overlayFile, session, prompt) {
  const args = ['--profile', 'headless', '--patch', overlayFile, '--json', ...session === undefined ? [] : ['--session-id', session], prompt]
  const result = run(dshBin(), args, { cwd: paths.cwd, check: false })
  const final = result.stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  }).findLast(event => event?.type === 'final')
  return { status: result.status, session: final?.sessionId, text: final?.text ?? '', reason: final?.reason?.kind, stderr: result.stderr }
}

function probeResult(at, action) {
  return sinceJsonl(at, 'probe').findLast(entry => entry.action === action)
}

function index() {
  const file = join(memoryRoot, 'scopes', 'owner', 'index.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { episodes: [], rollups: [] }
}
function state() {
  const file = join(memoryRoot, 'state.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { queue: [] }
}
function episodesOf(session) {
  const tag = session.replace(/^session-/, '').slice(0, 8)
  return index().episodes.filter(meta => meta.sessionId === session || meta.id.includes(`_${tag}_`))
}
function episodeDir(meta) {
  return join(memoryRoot, 'scopes', 'owner', meta.dir)
}
function summarizerLog() {
  return jsonl(join(memoryRoot, 'logs', 'summarizer.jsonl'))
}
function profilePatch(profile) {
  return readFileSync(join(paths.dshHome, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
}
/** `disabled` of row `id` in a profile patch, in flow (`{ id: x, disabled: true }`) or block style (after a settings write). */
function rowDisabled(patch, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`id: ${escaped}(?:,\\s*|\\n\\s+)disabled: (true|false)`).exec(patch)
  return match === null ? undefined : match[1] === 'true'
}
function injectedChars(at, session) {
  const line = since(at, 'dsh').split('\n').find(item => item.includes(`injecting memory block into session ${session} (session-start`))
  return line === undefined ? undefined : Number(/, (\d+) chars/.exec(line)?.[1])
}
function snapshotOf(session) {
  const dir = join(memoryRoot, 'scopes', 'owner', 'snapshots')
  const name = readdirSync(dir).filter(file => file.startsWith(`${session}-`)).sort((a, b) => Number(a.split('-').at(-1).slice(0, -3)) - Number(b.split('-').at(-1).slice(0, -3)))[0]
  return name === undefined ? '' : readFileSync(join(dir, name), 'utf8')
}
function count(text, pattern) {
  return text.split('\n').filter(line => pattern.test(line)).length
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const context = {}

async function s1() {
  current = 's1'
  log('S1 headless engine mode: takeover through the host API, compactions, checkpoints, continuation')
  let at = mark()
  const enable = turn(overlay('takeover', { actions: ['unmatched:owner', 'takeover'] }), undefined, '启用接管[[long:50]]')
  const owner = probeResult(at, 'unmatched:owner')?.result
  check('setConfig persists unmatchedSessions: owner for the remaining runs', owner?.ok === true && owner?.live === 'owner' && /unmatchedSessions: owner/.test(profilePatch('headless')), JSON.stringify(owner))
  const outcome = probeResult(at, 'takeover')?.result
  check('takeover via pluginManager succeeds and asks for a restart', enable.status === 0 && outcome?.ok === true && outcome?.outcome?.application === 'restart-required', JSON.stringify(outcome?.outcome?.application))
  const patch = profilePatch('headless')
  check('profile patch disables compaction-basic and enables the engine row', rowDisabled(patch, 'compaction-basic') === true && rowDisabled(patch, 'dsh-memory-cloud-brain-engine') === false, JSON.stringify(patch.split('\n').filter(line => !line.startsWith('#'))))

  at = mark()
  const long = turn(overlay('s1', { actions: ['status', 'engine', 'checkpoints'] }), undefined, `长任务：【事实：我的猫叫团子】【事实：我住在杭州】【事实：${PROMISE}】请分步骤完成。[[steps:16:3000]]`)
  context.s1Session = long.session
  check('steps turn completes after compactions', long.status === 0 && long.text.includes('完成了16步'), long.text.slice(0, 40))
  const s1Status = probeResult(at, 'status')?.result
  check('engine mode on the host-level MemoryCompactionEngine', s1Status?.agent?.mode?.mode === 'engine' && probeResult(at, 'engine')?.result?.brand === true)
  check('status reports the owner firewall decision and the owner scope', s1Status?.configured?.unmatchedSessions === 'owner' && s1Status?.firewall?.mode === 'owner' && s1Status?.agent?.scope?.scope === 'owner' && s1Status?.agent?.scope?.private === true, JSON.stringify(s1Status?.firewall))
  const logText = since(at, 'dsh')
  const pressure = count(logText, /memory-compaction-engine: compaction \(step pressure\)/)
  const idle = count(logText, /idle consolidation of session .* compacted the context/)
  const stored = count(logText, /stored the checkpoint summary of .* without another model call/)
  check('at least two pressure compactions by our engine', pressure >= 2, `${pressure} pressure + ${idle} idle compactions`)
  check('every compaction episode reused the checkpoint summary (no second model call)', stored === pressure + idle, `${stored} stored`)
  const marks = probeResult(at, 'checkpoints')?.result ?? []
  const memoryCheckpoints = marks.filter(item => item.kind === 'compact-checkpoint' && item.memoryCloud)
  check('session log checkpoints carry the <memory-cloud> block', memoryCheckpoints.length >= 2, `${memoryCheckpoints.length} memory checkpoints`)
  const replay = sinceJsonl(at, 'llm').filter(entry => entry.kind === 'replay').length
  check('one replay summarizer call per compaction', replay === pressure + idle, `${replay} replay calls`)
  const compacted = episodesOf(long.session).filter(meta => meta.sealReason === 'compaction')
  const filesOk = compacted.length >= 2 && compacted.every(meta => ['raw.jsonl', 'summary.md', 'gist.md'].every(file => existsSync(join(episodeDir(meta), file))))
  check('compaction episodes have raw.jsonl, summary.md, gist.md', filesOk, compacted.map(meta => meta.id).join(', '))
  check(`checkpoint summaries carry promptVersion ${PROMPT_VERSION}`, filesOk && compacted.every(meta => readFileSync(join(episodeDir(meta), 'summary.md'), 'utf8').includes(`promptVersion: ${PROMPT_VERSION}`)))
  const kinds = summarizerLog()
  const second = compacted.filter(meta => kinds.some(entry => entry.episode === meta.id && entry.kind === 'episode'))
  check('no background summary for engine-summarized episodes', compacted.every(meta => kinds.some(entry => entry.episode === meta.id && entry.kind === 'checkpoint')) && second.length === 0, second.map(meta => meta.id).join(', '))

  const facts = ['下周三要去看牙医', '我妹妹叫小雨', '我在学吉他']
  let continued = true
  for (const fact of facts) {
    const next = turn(overlay('s1-more'), long.session, `续聊：【事实：${fact}】[[long:5000]]`)
    continued &&= next.status === 0 && next.session === long.session && next.text.includes(fact)
  }
  check('the conversation continues across later turns', continued)
}

async function s2() {
  current = 's2'
  log('S2 new session: one injected block, distant gists, recent summaries, recall tools')
  for (const fact of ['周末打算去西湖', '我的生日是三月五日', '我最喜欢的颜色是蓝色']) turn(overlay('s2-fill'), context.s1Session, `再聊：【事实：${fact}】[[long:2000]]`)
  const cat = index().episodes.find(meta => meta.status === 'summarized' && existsSync(join(episodeDir(meta), 'summary.md')) && readFileSync(join(episodeDir(meta), 'summary.md'), 'utf8').includes('我的猫叫团子'))
  check('an episode summary mentions the cat', cat !== undefined)
  let at = mark()
  const read = turn(overlay('s2'), undefined, `新会话：你还记得我的猫吗？[[read:${cat?.id}]]`)
  const block = snapshotOf(read.session)
  check('memory_read #id returns the summary', read.status === 0 && read.text.includes('用户提到我的猫叫团子') && read.text.includes('· summary'))
  const calls = sinceJsonl(at, 'llm').filter(entry => entry.kind === 'conversation')
  check('the injected block appears exactly once per request', calls.length > 0 && calls.every(entry => entry.memoryBlocks === 1), calls.map(entry => entry.memoryBlocks).join(','))
  const distant = block.split('## 近期摘要')[0].split('## 远期总结')[1] ?? ''
  check('distant entries are one-line gists, recent ones summaries', block.includes('## 远期总结') && block.includes('## 近期摘要') && !distant.includes('【发生了什么】') && /## 近期摘要[\s\S]*【发生了什么】/.test(block))
  const agenda = block.split('## 远期总结')[0]
  check('an open promise with a future due date is on the agenda of a new session', new RegExp(`约定（用户，截止 [^）]+）：${PROMISE} #`).test(agenda), agenda.split('\n').filter(line => line.includes('约定')).join(' | ') || 'no agenda line')
  at = mark()
  const raw = turn(overlay('s2'), read.session, `原文呢[[raw:${cat?.id}]]`)
  check('a raw read returns the original text', raw.status === 0 && raw.text.includes('· raw') && raw.text.includes('【事实：我的猫叫团子】'))
  check('a raw read hides the runtime-context record by default', raw.status === 0 && !raw.text.includes('<system-reminder>') && !raw.text.includes('Current working directory'))
  const search = turn(overlay('s2'), read.session, '搜一下[[search:团子]]')
  check('memory_search finds the episode', search.status === 0 && search.text.includes(cat?.id ?? '?'))

  at = mark()
  turn(overlay('s2-isolate', { actions: ['unmatched:isolated'] }), undefined, '切换到隔离[[long:50]]')
  const isolate = probeResult(at, 'unmatched:isolated')?.result
  check('setConfig switches unmatchedSessions to isolated', isolate?.ok === true && isolate?.live === 'isolated' && /unmatchedSessions: isolated/.test(profilePatch('headless')), JSON.stringify(isolate))
  at = mark()
  const isolated = turn(overlay('s2-isolated', { actions: ['status'] }), undefined, '隔离会话：你知道我的猫吗？[[search:团子]]')
  const isoStatus = probeResult(at, 'status')?.result
  check('an isolated session gets its own scope and the isolated firewall decision', isolated.status === 0 && isoStatus?.firewall?.mode === 'isolated' && isoStatus?.agent?.scope?.private === false && isoStatus?.agent?.scope?.scope !== 'owner', JSON.stringify(isoStatus?.agent?.scope?.scope))
  const isoCalls = sinceJsonl(at, 'llm').filter(entry => entry.kind === 'conversation' && entry.sessionId === isolated.session)
  check('an isolated session receives no owner memory block', isoCalls.length > 0 && isoCalls.every(entry => entry.memoryBlocks === 0) && injectedChars(at, isolated.session) === undefined, isoCalls.map(entry => entry.memoryBlocks).join(','))
  check('memory_search in an isolated session returns no owner hits', isolated.text.includes('没有找到片段') && !isolated.text.includes(cat?.id ?? '?'), isolated.text.slice(0, 120))
  at = mark()
  turn(overlay('s2-owner', { actions: ['unmatched:owner'] }), undefined, '恢复 owner[[long:50]]')
  check('setConfig switches unmatchedSessions back to owner', probeResult(at, 'unmatched:owner')?.result?.live === 'owner' && /unmatchedSessions: owner/.test(profilePatch('headless')))
}

async function s3() {
  current = 's3'
  log('S3 level change: threshold and block size follow the level')
  for (let i = 0; i < 6; i++) turn(overlay('s3-fill'), undefined, `补充会话${i}：【事实：补充事实${i}】[[long:300]]`)
  let at = mark()
  const l3 = turn(overlay('s3-l3', { window: 131072, actions: ['status'] }), undefined, '档位3新会话[[long:50]]')
  const l3Budget = probeResult(at, 'status')?.result?.agent?.budget
  const l3Chars = injectedChars(at, l3.session)
  at = mark()
  const l3Steps = turn(overlay('s3-l3-steps', { window: 131072 }), undefined, '档位3长任务：请分步骤完成。[[steps:14:3000]]')
  check('level 3 on a 128K window does not compact at ~40K tokens', l3Steps.status === 0 && count(since(at, 'dsh'), /memory-compaction-engine: compaction/) === 0)
  at = mark()
  turn(overlay('s3-set', { window: 131072, actions: ['level5'] }), undefined, '设置档位5[[long:50]]')
  const set = probeResult(at, 'level5')?.result
  check('setLevel(5) writes through ctx.settings into the profile patch', set?.ok === true && set?.via === 'settings' && /level: 5/.test(profilePatch('headless')), JSON.stringify(set))
  at = mark()
  const l5 = turn(overlay('s3-l5', { window: 131072, actions: ['status'] }), undefined, '档位5新会话[[long:50]]')
  const l5Budget = probeResult(at, 'status')?.result?.agent?.budget
  const l5Chars = injectedChars(at, l5.session)
  check('threshold follows the level (level 3 uses the host default 0.8 W below 320K)', l3Budget?.thresholdTokens === 104857 && l5Budget?.thresholdTokens === 32768, `${l3Budget?.thresholdTokens} → ${l5Budget?.thresholdTokens}`)
  check('the new session block shrinks', l3Chars > 0 && l5Chars > 0 && l5Chars < l3Chars, `${l3Chars} → ${l5Chars} chars (M ${l3Budget?.memoryBudgetTokens} → ${l5Budget?.memoryBudgetTokens})`)
  at = mark()
  const l5Steps = turn(overlay('s3-l5-steps', { window: 131072 }), undefined, '档位5长任务：请分步骤完成。[[steps:14:3000]]')
  check('level 5 compacts the same turn', l5Steps.status === 0 && count(since(at, 'dsh'), /memory-compaction-engine: compaction \(step pressure\)/) >= 1)
}

async function s4() {
  current = 's4'
  log('S4 summarizer failure: fallback to the default checkpoint, failed episodes retried with backoff')
  let at = mark()
  const thrown = turn(overlay('s4-throw', { window: 131072, summarize: 'throw', actions: ['checkpoints'] }), undefined, '失败测试：【事实：我的车是红色的】请分步骤完成。[[steps:14:3000]]')
  const failedAt = Date.now()
  const logText = since(at, 'dsh')
  check('the turn completes and DSH exits 0', thrown.status === 0 && thrown.text.includes('完成了14步'))
  check('the engine falls back (compose-error)', /summarize fallback \(compose-error\)/.test(logText))
  check('the checkpoint is compaction-basic\'s own summary', (probeResult(at, 'checkpoints')?.result ?? []).some(item => item.kind === 'compact-checkpoint' && item.defaultSummary && !item.memoryCloud))
  const failed = episodesOf(thrown.session).filter(meta => meta.sealReason === 'compaction')
  const queued = state().queue.filter(job => failed.some(meta => meta.id === job.episode))
  check('the compaction episode is marked failed and queued with backoff', failed.length > 0 && failed.every(meta => meta.status === 'failed' && meta.attempts === 1) && queued.length === failed.length && queued.every(job => job.notBefore >= failedAt + 20_000), failed.map(meta => `${meta.id}:${meta.status}`).join(', '))
  at = mark()
  const garbage = turn(overlay('s4-garbage', { window: 131072, summarize: 'garbage' }), undefined, '垃圾输出：请分步骤完成。[[steps:14:3000]]')
  const parseFallback = `summarize fallback (compose-error) for ${garbage.session}: 已重试一次，仍未能解析出一行总结和摘要。 / Could not parse the gist and summary after one retry.`
  check('garbage output: one stricter retry, then fallback, turn completes', garbage.status === 0 && garbage.text.includes('完成了14步') && since(at, 'dsh').includes(parseFallback) && sinceJsonl(at, 'llm').some(entry => entry.kind === 'replay' && entry.retry))
  const retried = [...failed, ...episodesOf(garbage.session).filter(meta => meta.sealReason === 'compaction')]
  await sleep(Math.max(0, failedAt + 31_000 - Date.now()))
  for (let attempt = 0; attempt < 6 && !retried.every(meta => index().episodes.find(item => item.id === meta.id)?.status === 'summarized'); attempt++) {
    turn(overlay('s4-ok', { window: 131072 }), undefined, `恢复${attempt}[[long:50]]`)
  }
  check('failed episodes are summarized after the backoff', retried.every(meta => index().episodes.find(item => item.id === meta.id)?.status === 'summarized'), retried.map(meta => `${meta.id}:${index().episodes.find(item => item.id === meta.id)?.status}`).join(', '))
}

async function s5() {
  current = 's5'
  log('S5 assist mode: host compaction, block refilled, episode summarized in the background')
  let at = mark()
  turn(overlay('s5-restore', { actions: ['restore'] }), undefined, '还原[[long:50]]')
  const restored = probeResult(at, 'restore')?.result
  check('restore via pluginManager', restored?.ok === true && restored?.outcome?.application === 'restart-required' && rowDisabled(profilePatch('headless'), 'dsh-memory-cloud-brain-engine') !== false)
  at = mark()
  const basic = ['- id: compaction-basic', '  config:', '    headroomTokens: 4096', '    retainTokens: 1500', '    maxTokens: 2000']
  const assist = turn(overlay('s5', { actions: ['status'], extra: basic }), undefined, '辅助模式：【事实：我在深圳出差】请分步骤完成。[[steps:16:3000]]')
  const logText = since(at, 'dsh')
  check('assist mode with compaction-basic', assist.status === 0 && probeResult(at, 'status')?.result?.agent?.mode?.mode === 'assist')
  const host = logText.indexOf('basic-compaction-engine: compaction (step pressure)')
  check('compaction-basic compacted under pressure', host >= 0)
  check('the memory block is refilled on the next step', host >= 0 && logText.slice(host).includes(`injecting memory block into session ${assist.session} (refill, assist mode`))
  const sealed = episodesOf(assist.session).filter(meta => meta.sealReason === 'compaction')
  const background = sealed.filter(meta => meta.status === 'summarized' && summarizerLog().some(entry => entry.episode === meta.id && entry.kind === 'episode'))
  check('compaction episodes are summarized in the background', sealed.length > 0 && background.length >= 1, `${background.length}/${sealed.length}`)
  check(`background summaries carry promptVersion ${PROMPT_VERSION}`, background.length >= 1 && summarizerLog().filter(entry => entry.kind === 'episode' && entry.ok && background.some(meta => meta.id === entry.episode)).every(entry => entry.promptVersion === PROMPT_VERSION))
}

async function s6() {
  current = 's6'
  log('S6 web profile: load, assist by default, configEditor takeover, engine session, restore')
  const at = mark()
  const ready = new Promise((resolve) => {
    webProcess = spawn(dshBin(), ['--profile', 'web', '--patch', overlay('web', { window: 131072, webScript: true }), '--no-open', '--port', '0'], { cwd: paths.cwd, env: dshEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    webProcess.stdout.on('data', (chunk) => {
      out += chunk
      const url = /(http:\/\/\S+\?token=\S+)/.exec(out)?.[1]
      if (url !== undefined) resolve(url)
    })
    webProcess.stderr.on('data', chunk => appendFileSync(join(paths.logs, 'web.stderr'), chunk))
    webProcess.on('exit', () => resolve(undefined))
  })
  const url = await Promise.race([ready, sleep(60_000)])
  check('dsh web starts', typeof url === 'string', url ?? 'no URL')
  for (let waited = 0; waited < 150_000 && probeResult(at, 'web:done') === undefined; waited += 1000) await sleep(1000)
  const get = action => probeResult(at, action)
  check('the plugin loads (memoryCloud service)', get('web:loaded')?.result?.memoryCloud === true)
  check('ctx.settings.update applies a level live', get('web:level5')?.result?.ok === true)
  const assist = get('web:assist')?.result
  check('without takeover a preset session runs in assist mode', assist?.mode === 'assist' && assist?.engine === 'BasicCompactionEngine', JSON.stringify({ mode: assist?.mode, engine: assist?.engine }))
  check('configEditor takeover applies', get('web:takeover')?.result?.ok === true && get('web:takeover')?.result?.action === 'applied')
  const standard = (get('web:compositions-after-takeover')?.result ?? []).filter(item => item.id === 'standard')
  check('the new standard composition mounts dsh-memory-cloud-brain/engine', standard.some(item => item.modules.includes('dsh-memory-cloud-brain/engine') && !item.modules.includes('@deepseek-ai/dsh-compaction-basic')))
  const engine = get('web:engine')?.result
  check('a new session after takeover uses our engine and gets memory checkpoints', engine?.brand === true && engine?.mode === 'engine' && (engine?.checkpoints ?? []).some(item => item.kind === 'compact-checkpoint' && item.memoryCloud), JSON.stringify({ engine: engine?.engine, mode: engine?.mode }))
  check('engine compactions reuse the checkpoint summary', count(since(at, 'dsh'), /stored the checkpoint summary .* without another model call/) >= 1)
  check('restore removes the preset override', get('web:restore')?.result?.action === 'restored' && !/preset-standard/.test(profilePatch('web')))
  if (typeof url === 'string') {
    try {
      const first = await fetch(url, { redirect: 'manual' })
      const cookie = (first.headers.getSetCookie?.() ?? []).map(item => item.split(';')[0]).join('; ')
      const page = await fetch(new URL(first.headers.get('location') ?? '/', url), { headers: { cookie } })
      const html = await page.text()
      check('the web index serves the browser half', html.includes('dsh-memory-cloud-brain/client.js'))
    } catch (error) {
      check('the web index serves the browser half', false, String(error))
    }
  }
  context.webAt = at
}

async function s7() {
  current = 's7'
  log('S7 shutdown: episodes flushed or adoptable, no stale locks, clean exit')
  if (webProcess !== undefined && webProcess.exitCode === null) {
    const exited = new Promise(resolve => webProcess.once('exit', (code, signal) => resolve({ code, signal })))
    const started = Date.now()
    webProcess.kill('SIGINT')
    const outcome = await Promise.race([exited, sleep(20_000).then(() => undefined)])
    check('dsh web exits on SIGINT', outcome !== undefined, outcome === undefined ? 'still running after 20 s' : `${JSON.stringify(outcome)} after ${Date.now() - started} ms`)
    if (outcome === undefined) webProcess.kill('SIGKILL')
  }
  const lockFiles = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name.endsWith('.lock')) lockFiles.push(join(dir, entry.name))
    }
  }
  if (existsSync(memoryRoot)) walk(memoryRoot)
  check('no lock files left in the memory store', lockFiles.length === 0, lockFiles.join(', '))
  const rejections = jsonl(files.probe).filter(entry => entry.action === 'unhandledRejection')
  check('no unhandled rejections in any run', rejections.length === 0, rejections.map(entry => entry.reason.split('\n')[0]).join(' | '))
  const dshLog = existsSync(files.dsh) ? readFileSync(files.dsh, 'utf8') : ''
  check('no store lock timeouts', !/timed out waiting for the writer lock/.test(dshLog))
  check('no job attempts burned by a shutdown', !/Summarization requires a provider and a model\.|no provider\/model route/.test(dshLog))
  const web = jsonl(files.probe).filter(entry => entry.action === 'web:assist' || entry.action === 'web:engine').map(entry => entry.result?.session).filter(Boolean)
  const ended = web.flatMap(session => episodesOf(session).filter(meta => meta.sealReason === 'end'))
  const queue = state().queue
  check('web sessions were sealed at shutdown and queued or summarized', web.length > 0 && ended.length === web.length && ended.every(meta => meta.status === 'summarized' || queue.some(job => job.episode === meta.id && job.attempts === 0)), ended.map(meta => `${meta.id}:${meta.status}`).join(', '))
  const exits = jsonl(files.probe).filter(entry => entry.action === 'exit')
  check('every headless run exited 0', exits.filter(entry => entry.code !== 0 && entry.code !== 130).length === 0, `${exits.length} exits`)
}

// ---------------------------------------------------------------------------

async function main() {
  log('work dir %s', work)
  if (option('--dsh-dir') === undefined) {
    log('installing @deepseek-ai/dsh@%s', DSH_VERSION)
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), '{ "private": true }\n')
    // npm runs with the caller's environment (registry, proxy, cache); only the DSH processes are isolated.
    for (let attempt = 1; ; attempt++) {
      const installed = run('npm', ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${DSH_VERSION}`], { cwd: dshDir, env: process.env, timeoutMs: 900_000, check: false })
      if (installed.status === 0) break
      if (attempt >= 2) throw new Error(`npm install @deepseek-ai/dsh@${DSH_VERSION} failed:\n${installed.stderr.slice(-2000)}`)
      log('npm install failed (attempt %d), retrying', attempt)
    }
  }
  if (!existsSync(dshBin())) throw new Error(`no dsh binary at ${dshBin()}`)
  if (!flag('--skip-build')) {
    log('building the plugin (pnpm build)')
    run('pnpm', ['build'], { cwd: REPO, env: process.env })
  }
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'fake-llm.mjs'), pluginModule(fakeLlmPlugin, ["import { appendFileSync } from 'node:fs'", "import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'"], 'LlmAdapter, LlmError, appendFileSync'))
  writeFileSync(join(pluginDir, 'probe.mjs'), pluginModule(probePlugin, ["import { appendFileSync } from 'node:fs'", "import { format } from 'node:util'"], 'appendFileSync, format'))
  for (const profile of ['headless', 'web']) {
    log('dsh plugin --profile %s add %s', profile, REPO)
    run(dshBin(), ['plugin', '--profile', profile, 'add', REPO], { timeoutMs: 300_000 })
  }
  for (const [id, scenario] of Object.entries({ s1, s2, s3, s4, s5, s6, s7 })) {
    if (!only.has(id)) continue
    try {
      await scenario()
    } catch (error) {
      check('scenario ran to completion', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' '))
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (webProcess !== undefined && webProcess.exitCode === null) webProcess.kill('SIGKILL')
    if (!flag('--keep')) {
      rmSync(pluginDir, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
    process.exit(130)
  })
}

let exitCode = 0
try {
  await main()
} catch (error) {
  console.error(`[e2e] setup failed: ${error?.stack ?? error}`)
  exitCode = 2
} finally {
  if (webProcess !== undefined && webProcess.exitCode === null) webProcess.kill('SIGKILL')
  const failed = results.filter(result => !result.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed`)
  for (const result of failed) console.log(`[e2e] FAILED ${result.scenario} · ${result.name}${result.detail === '' ? '' : ` — ${result.detail}`}`)
  if (failed.length > 0 && exitCode === 0) exitCode = 1
  if (flag('--keep')) {
    log('kept %s (logs in %s)', work, paths.logs)
  } else {
    rmSync(pluginDir, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}
process.exit(exitCode)
