import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRegistrationOptions, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { TOOL_NAMES } from '../contracts.ts'
import { createMemoryToolHandlers, MemoryToolError } from './handlers.ts'
import type { IdArgs, MemoryToolHandlers, ToolDeps } from './handlers.ts'
import { renderFlag, renderRead, renderSearch, renderTimeline } from './render.ts'
import type { FlagAction, FlagOutput } from './render.ts'

/** Alias of the shared {@link TOOL_NAMES}. */
export const MEMORY_TOOL_NAMES = TOOL_NAMES

/** The calling agent DSH passes to tool bodies. */
export type MemoryToolCaller = NonNullable<ToolRunContext['agent']>

export type MemoryToolDeps = ToolDeps<MemoryToolCaller>

/** The slice of `ctx.tools` (`@deepseek-ai/dsh-tools` `ToolsService`) used here. */
export interface MemoryToolRegistry {
  register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof MemoryToolError) throw new HarnessError(error.message, `MEMORY_${error.code}`)
    throw error
  }
}

const idParameter = {
  type: 'string',
  required: true,
  description: 'Episode id from memory_search, memory_timeline, or the memory block, e.g. 20261120-2130_ab12cd34_1 (a leading # is fine).',
} as const

const flagOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    pinned: { type: 'boolean', required: true },
    hidden: { type: 'boolean', required: true },
    changed: { type: 'boolean', required: true },
  },
} as const

function flagTool(
  handlers: MemoryToolHandlers<MemoryToolCaller>,
  action: FlagAction,
  name: string,
  description: string,
): ToolDefinition {
  const handle: (agent: MemoryToolCaller | undefined, args: IdArgs) => Promise<FlagOutput> = handlers[action]
  return defineTool({
    name,
    description,
    parameters: { id: idParameter },
    output: {
      schema: flagOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderFlag(action, value) }],
    },
    execute: (args, exec) => run(() => handle(exec.agent, args)),
  })
}

/** Build the recall tool definitions; every one declares `output: {schema, render}`. */
export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const handlers = createMemoryToolHandlers(deps)
  return [
    defineTool({
      name: MEMORY_TOOL_NAMES.search,
      description: 'Search long-term memory of earlier conversations (this chat\'s memory only). Matches Chinese and English words, names, keywords, and dates in episode gists and summaries, and returns the true number of matches plus the best hits as "#id date gist". Convert relative dates such as "last week" or "上周" into from/to yourself. Follow up with memory_read; give up after a few lookups if nothing relevant turns up.',
      parameters: {
        query: { type: 'string', required: true, description: 'Words, names, or a date to look for. An empty query lists the episodes in the from/to range, newest first.' },
        from: { type: 'string', description: 'Only episodes on or after this local date: YYYY-MM-DD, YYYY-MM, YYYY, or an ISO date-time.' },
        to: { type: 'string', description: 'Only episodes on or before this local date (inclusive); same formats as from.' },
        limit: { type: 'integer', description: 'Maximum hits to return (default 8, at most 50).' },
        includeRaw: { type: 'boolean', description: 'Also scan original transcripts, slower and bounded. Use it when summaries do not mention the detail.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  date: { type: 'string', required: true },
                  gist: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                },
              },
            },
            notice: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: renderSearch(args.query, value) }],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => run(() => handlers.search(exec.agent, args, exec.signal)),
    }),
    defineTool({
      name: MEMORY_TOOL_NAMES.read,
      description: 'Read one remembered episode. level "summary" (default) says what happened, "gist" is the one-line version, and "raw" is the original transcript (user and assistant messages, tool calls and results), paged by records with offset/limit (continue from nextOffset). Output is capped to protect the context; when the context is nearly full, raw reads return the summary instead.',
      parameters: {
        id: idParameter,
        level: { type: 'string', enum: ['summary', 'gist', 'raw'], description: 'summary (default), gist, or raw.' },
        offset: { type: 'integer', description: 'raw only: first record to return (default 0).' },
        limit: { type: 'integer', description: 'raw only: maximum records to return (default 40, at most 200).' },
        includeSystem: { type: 'boolean', description: 'raw only: also show system records such as runtime-context reminders, compaction checkpoints, injected memory blocks, and log events (default false). Offsets then count every stored record, so keep the same value while paging.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            date: { type: 'string', required: true },
            level: { type: 'string', enum: ['summary', 'gist', 'raw'], required: true },
            text: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            offset: { type: 'integer' },
            count: { type: 'integer' },
            total: { type: 'integer' },
            hiddenRecords: { type: 'integer' },
            nextOffset: { type: 'integer' },
            notice: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
      },
      execute: (args, exec) => run(() => handlers.read(exec.agent, args, exec.signal)),
    }),
    defineTool({
      name: MEMORY_TOOL_NAMES.timeline,
      description: 'Show the episodes just before and after one episode, as dated gists, to place it in time or find how a story continued.',
      parameters: {
        id: idParameter,
        before: { type: 'integer', description: 'Episodes to show before it (default 3, at most 20).' },
        after: { type: 'integer', description: 'Episodes to show after it (default 3, at most 20).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  date: { type: 'string', required: true },
                  gist: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  current: { type: 'boolean', required: true },
                  sameSession: { type: 'boolean', required: true },
                  pinned: { type: 'boolean', required: true },
                },
              },
            },
            notice: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderTimeline(value) }],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => run(() => handlers.timeline(exec.agent, args, exec.signal)),
    }),
    flagTool(handlers, 'pin', MEMORY_TOOL_NAMES.pin, 'Pin an episode so memory blocks keep it prominent, e.g. when the user asks you to remember something for good.'),
    flagTool(handlers, 'unpin', MEMORY_TOOL_NAMES.unpin, 'Remove a pin set with memory_pin.'),
    flagTool(handlers, 'hide', MEMORY_TOOL_NAMES.hide, 'Hide an episode from memory blocks and search when the user asks you to drop it. Nothing is deleted; memory_unhide restores it.'),
    flagTool(handlers, 'unhide', MEMORY_TOOL_NAMES.unhide, 'Make an episode hidden with memory_hide visible again.'),
  ]
}

/**
 * Register every recall tool on `ctx.tools`. The returned disposer
 * unregisters them; Cordis also removes them when `ctx` is disposed.
 */
export function registerMemoryTools(
  ctx: { readonly tools: MemoryToolRegistry },
  deps: MemoryToolDeps,
  options?: ToolRegistrationOptions,
): () => void {
  const disposers: (() => void)[] = []
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {}
    }
  }
  try {
    for (const definition of createMemoryTools(deps)) disposers.push(ctx.tools.register(definition, options))
  } catch (error) {
    disposeAll()
    throw error
  }
  return disposeAll
}
