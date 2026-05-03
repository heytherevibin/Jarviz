/**
 * MCP stdio clients: merge remote tool definitions into the Anthropic tool list
 * and dispatch jarviz_mcp_* tool calls back to the correct server.
 */
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export function parseMcpServers(raw: unknown): McpServerEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: McpServerEntry[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null
    const o = row as Record<string, unknown>
    const id = String(o.id ?? '').trim()
    const command = String(o.command ?? '').trim()
    if (!id || !command) return null
    const args = Array.isArray(o.args) ? o.args.map((x) => String(x)) : []
    const name = o.name != null ? String(o.name) : undefined
    const cwd = o.cwd != null ? String(o.cwd) : undefined
    const env = o.env && typeof o.env === 'object' && !Array.isArray(o.env) ? o.env as Record<string, string> : undefined
    const enabled = o.enabled === undefined ? true : Boolean(o.enabled)
    out.push({ id, name, command, args, cwd, env, enabled })
  }
  return out
}

export type McpServerEntry = {
  id: string
  name?: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /** When false, server is skipped (default: true) */
  enabled?: boolean
}

type Route = { serverId: string; originalName: string }

type Conn = { client: Client; transport: StdioClientTransport }

const connections = new Map<string, Conn>()
const routeByFullName = new Map<string, Route>()
let cachedMcpTools: Tool[] = []

function slug(s: string, max: number): string {
  const t = s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return (t || 'srv').slice(0, max)
}

function mcpToolFullName(serverId: string, toolName: string): string {
  const a = slug(serverId, 24)
  const b = slug(toolName, 36)
  const full = `jmcp_${a}_${b}`
  return full.length <= 64 ? full : `jmcp_${a}_${b.slice(0, 64 - 6 - a.length)}`
}

function mcpInputSchemaToAnthropic(schema: {
  type: 'object'
  properties?: Record<string, object>
  required?: string[]
}): Tool['input_schema'] {
  return {
    type:       'object',
    properties: (schema.properties ?? {}) as Record<string, unknown>,
    required:   schema.required,
  } as Tool['input_schema']
}

export function getMcpToolsForAnthropic(): Tool[] {
  return cachedMcpTools
}

export async function tryExecuteMcpTool(name: string, input: Record<string, unknown>): Promise<{ text: string } | null> {
  const route = routeByFullName.get(name)
  if (!route) return null
  const conn = connections.get(route.serverId)
  if (!conn) return { text: `MCP server "${route.serverId}" is not connected. Reload MCP in Settings.` }
  try {
    const res = await conn.client.callTool({ name: route.originalName, arguments: input })
    if ('toolResult' in res) {
      return { text: typeof res.toolResult === 'string' ? res.toolResult : JSON.stringify(res.toolResult) }
    }
    const parts = res.content ?? []
    const lines: string[] = []
    for (const p of parts) {
      if (p.type === 'text') lines.push(p.text)
      else if (p.type === 'image') lines.push(`[image ${p.mimeType}, ${p.data.length} chars base64]`)
      else lines.push(`[${p.type}]`)
    }
    const text = lines.join('\n').trim() || '(empty MCP result)'
    if (res.isError) return { text: `MCP tool error: ${text}` }
    return { text }
  } catch (e) {
    return { text: `MCP call failed: ${(e as Error).message}` }
  }
}

async function disconnectAll(): Promise<void> {
  for (const [, c] of connections) {
    try {
      await c.transport.close()
    } catch { /* noop */ }
  }
  connections.clear()
  routeByFullName.clear()
  cachedMcpTools = []
}

/** Reload MCP servers from electron-store key `mcpServers` (array). */
export async function mcpRefreshFromStore(store: { get: (k: string, d?: unknown) => unknown }): Promise<void> {
  await disconnectAll()
  const raw = store.get('mcpServers', []) as unknown
  const servers = parseMcpServers(raw)
  if (!servers) {
    if (Array.isArray(raw) && raw.length > 0) console.warn('[MCP] invalid mcpServers JSON — fix in Settings → Privacy')
    return
  }
  const nextTools: Tool[] = []

  for (const s of servers) {
    if (s.enabled === false) continue
    if (!s?.id || !String(s.command ?? '').trim()) continue
    const cmd = String(s.command).trim()
    const args = Array.isArray(s.args) ? s.args.map(String) : []
    try {
      const transport = new StdioClientTransport({
        command: cmd,
        args,
        cwd: s.cwd?.trim() || undefined,
        env: s.env && typeof s.env === 'object' ? s.env : undefined,
        stderr: 'inherit',
      })
      const client = new Client({ name: 'jarviz', version: '0.4.0' }, { capabilities: {} })
      await client.connect(transport)
      const listed = await client.listTools()
      connections.set(s.id, { client, transport })
      const label = (s.name ?? s.id).slice(0, 80)
      for (const t of listed.tools ?? []) {
        const full = mcpToolFullName(s.id, t.name)
        routeByFullName.set(full, { serverId: s.id, originalName: t.name })
        nextTools.push({
          name:        full,
          description: `[MCP: ${label}] ${t.description ?? t.name}`,
          input_schema: mcpInputSchemaToAnthropic(t.inputSchema),
        })
      }
      console.log(`[MCP] connected "${s.id}" (${listed.tools?.length ?? 0} tools)`)
    } catch (e) {
      console.error(`[MCP] failed to start server "${s.id}":`, (e as Error).message)
    }
  }
  cachedMcpTools = nextTools
}
