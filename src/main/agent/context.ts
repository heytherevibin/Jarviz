import type Store from 'electron-store'

export type MemoryKind = 'profile' | 'project' | 'conversation' | 'snippet'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  title: string
  text: string
  tags: string[]
  projectRoot?: string
  createdAt: number
  updatedAt: number
}

export type ToolPermissionMode = 'allow' | 'ask' | 'deny'

export interface ToolPermissions {
  // toolName -> mode
  tools: Record<string, ToolPermissionMode>
  // absolute roots allowed for filesystem tools
  allowedRoots: string[]
}

export interface ActivityEvent {
  id: string
  ts: number
  type: 'tool' | 'memory' | 'permission'
  label: string
  detail?: string
}

let store: Store | null = null

export function initAgentContext(s: Store): void {
  store = s
  // defaults
  if (!store.get('agent.permissions')) {
    store.set('agent.permissions', {
      tools: {},
      allowedRoots: [],
    } satisfies ToolPermissions)
  }
  if (!store.get('agent.memory')) {
    store.set('agent.memory', [] satisfies MemoryItem[])
  }
  if (!store.get('agent.activity')) {
    store.set('agent.activity', [] satisfies ActivityEvent[])
  }
  if (store.get('agent.memorySyncEnabled') === undefined) {
    store.set('agent.memorySyncEnabled', false)
  }
}

function mustStore(): Store {
  if (!store) throw new Error('Agent context not initialized')
  return store
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

// ── Activity ───────────────────────────────────────────────────────────────
export function activityAppend(e: Omit<ActivityEvent, 'id' | 'ts'> & { ts?: number }): void {
  const s = mustStore()
  const list = (s.get('agent.activity', []) as ActivityEvent[]).slice(-500)
  const evt: ActivityEvent = { id: uid('evt'), ts: e.ts ?? Date.now(), type: e.type, label: e.label, detail: e.detail }
  list.push(evt)
  s.set('agent.activity', list)
}

export function activityList(limit = 200): ActivityEvent[] {
  const s = mustStore()
  const list = (s.get('agent.activity', []) as ActivityEvent[])
  return list.slice(-Math.max(1, Math.min(500, limit)))
}

// ── Permissions ────────────────────────────────────────────────────────────
export function permissionsGet(): ToolPermissions {
  const s = mustStore()
  return s.get('agent.permissions') as ToolPermissions
}

export function permissionsSet(next: ToolPermissions): ToolPermissions {
  const s = mustStore()
  s.set('agent.permissions', next)
  activityAppend({ type: 'permission', label: 'Updated tool permissions' })
  return next
}

export function memorySyncEnabledGet(): boolean {
  return !!(mustStore().get('agent.memorySyncEnabled', false) as boolean)
}

export function memorySyncEnabledSet(on: boolean): boolean {
  mustStore().set('agent.memorySyncEnabled', !!on)
  activityAppend({ type: 'permission', label: 'Memory sync setting changed', detail: on ? 'enabled' : 'disabled' })
  return !!on
}

// ── Memory ────────────────────────────────────────────────────────────────
export function memoryList(opts?: { kind?: MemoryKind; projectRoot?: string; limit?: number }): MemoryItem[] {
  const s = mustStore()
  const limit = opts?.limit ?? 200
  let items = (s.get('agent.memory', []) as MemoryItem[])
  if (opts?.kind) items = items.filter(i => i.kind === opts.kind)
  if (opts?.projectRoot) items = items.filter(i => i.projectRoot === opts.projectRoot)
  return items
    .slice()
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, Math.max(1, Math.min(500, limit)))
}

export function memoryUpsert(input: {
  id?: string
  kind: MemoryKind
  title: string
  text: string
  tags?: string[]
  projectRoot?: string
}): MemoryItem {
  const s = mustStore()
  const now = Date.now()
  const items = (s.get('agent.memory', []) as MemoryItem[]).slice()
  const id = input.id || uid('mem')
  const existingIdx = items.findIndex(i => i.id === id)
  const next: MemoryItem = {
    id,
    kind: input.kind,
    title: input.title.trim().slice(0, 160) || 'Untitled',
    text: input.text.trim(),
    tags: (input.tags ?? []).map(t => t.trim()).filter(Boolean).slice(0, 24),
    projectRoot: input.projectRoot?.trim() || undefined,
    createdAt: existingIdx >= 0 ? items[existingIdx].createdAt : now,
    updatedAt: now,
  }
  if (existingIdx >= 0) items[existingIdx] = next
  else items.push(next)
  s.set('agent.memory', items.slice(-2000))
  activityAppend({ type: 'memory', label: existingIdx >= 0 ? 'Updated memory' : 'Saved memory', detail: next.title })
  return next
}

export function memoryDelete(id: string): boolean {
  const s = mustStore()
  const items = (s.get('agent.memory', []) as MemoryItem[]).slice()
  const idx = items.findIndex(i => i.id === id)
  if (idx < 0) return false
  const [removed] = items.splice(idx, 1)
  s.set('agent.memory', items)
  activityAppend({ type: 'memory', label: 'Deleted memory', detail: removed?.title })
  return true
}

export function memorySearch(query: string, opts?: { kind?: MemoryKind; projectRoot?: string; limit?: number }): MemoryItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const all = memoryList({ kind: opts?.kind, projectRoot: opts?.projectRoot, limit: 2000 })
  const scored = all
    .map(i => {
      const hay = `${i.title}\n${i.text}\n${i.tags.join(' ')}`.toLowerCase()
      let score = 0
      if (i.title.toLowerCase().includes(q)) score += 3
      if (i.tags.some(t => t.toLowerCase() === q)) score += 2
      if (hay.includes(q)) score += 1
      return { i, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => (b.score - a.score) || ((b.i.updatedAt || b.i.createdAt) - (a.i.updatedAt || a.i.createdAt)))
  const limit = opts?.limit ?? 20
  return scored.slice(0, Math.max(1, Math.min(100, limit))).map(s => s.i)
}

