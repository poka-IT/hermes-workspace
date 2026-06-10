/**
 * Tasks tab ↔ agent kanban bridge.
 *
 * The Tasks tab historically used a local file-backed store
 * (`tasks-store.ts`), disconnected from the agent's real kanban. That meant
 * launching a task did nothing useful — the dispatcher never saw it. This
 * module re-wires the Tasks tab's server API onto the AGENT kanban via the
 * existing dashboard proxy (`kanban-dashboard-proxy.ts`), so tasks created in
 * the UI land on the same SQLite board the dispatcher polls and runs.
 *
 * Shape translation:
 *   - Frontend `TaskRecord` (column/description/priority/...) ⇄
 *     agent `DashboardKanbanTask` (status/body/numeric-priority/...).
 *   - Column ⇄ status mapping reuses the same vocabulary as
 *     `kanban-backend.ts` (mapDashboardStatusToLane / mapLaneToDashboardStatus)
 *     but specialised to the Tasks tab's `TaskColumn` enum.
 *
 * Availability is probed through `gateway-capabilities` (caps.kanban). Callers
 * should check `isDashboardKanbanAvailable()` and fall back to the local
 * `tasks-store` on `false` so the tab degrades gracefully instead of 500ing.
 */
import {
  ensureGatewayProbed,
  getCapabilities,
} from './gateway-capabilities'
import {
  createDashboardKanbanTask,
  fetchDashboardKanbanBoard,
  fetchDashboardKanbanTask,
  updateDashboardKanbanTask,
  type DashboardKanbanTask,
} from './kanban-dashboard-proxy'
import type { TaskColumn, TaskPriority, TaskRecord } from './tasks-store'

export type TaskListFilters = {
  column?: string | null
  assignee?: string | null
  priority?: string | null
  includeDone?: boolean
}

export type CreateKanbanTaskInput = {
  id?: string
  title: string
  description?: string
  column?: TaskColumn
  priority?: TaskPriority
  assignee?: string | null
  tags?: string[]
  due_date?: string | null
  position?: number
  created_by?: string
  /** Agent-kanban workspace hint, e.g. "dir:/workspace". */
  workspace?: string
}

export type UpdateKanbanTaskInput = {
  title?: string
  description?: string
  column?: TaskColumn
  priority?: TaskPriority
  assignee?: string | null
}

/**
 * True when the agent dashboard exposes the kanban plugin. Ensures the gateway
 * has been probed (TTL-cached) before reading the capability flag so the first
 * request after boot doesn't see a stale `false`.
 */
export async function isDashboardKanbanAvailable(): Promise<boolean> {
  try {
    await ensureGatewayProbed()
  } catch {
    // Probe failure → assume unavailable; caller falls back to local store.
  }
  return getCapabilities().kanban === true
}

// ── status ⇄ column mapping ─────────────────────────────────────────

/** Agent kanban status → Tasks-tab column. Mirrors mapDashboardStatusToLane. */
function statusToColumn(status: string | null | undefined): TaskColumn {
  switch ((status ?? '').toLowerCase()) {
    case 'triage':
    case 'queued':
      return 'backlog'
    case 'todo':
      return 'todo'
    case 'ready':
      // The Tasks tab has no dedicated "ready" column; surface ready (and
      // dispatcher-claimable) work in the todo column.
      return 'todo'
    case 'running':
    case 'claimed':
    case 'in_progress':
      return 'in_progress'
    case 'review':
      return 'review'
    case 'blocked':
      return 'blocked'
    case 'done':
    case 'complete':
    case 'completed':
      return 'done'
    case 'archived':
    case 'deleted':
      return 'deleted'
    default:
      return 'backlog'
  }
}

/**
 * Tasks-tab column → agent kanban status. Mirrors mapLaneToDashboardStatus,
 * with the Tasks-tab-specific rule that a freshly created card defaults to the
 * agent's "ready" status (so the dispatcher picks it up) UNLESS the chosen
 * column maps to backlog/todo (which should stay parked).
 */
function columnToStatus(column: TaskColumn | undefined): string {
  switch (column) {
    case 'backlog':
      return 'todo'
    case 'todo':
      return 'todo'
    case 'in_progress':
      // The dashboard rejects direct writes of 'running' — only the
      // dispatcher's claim path may move a task into 'running'. Mark it
      // 'ready' and let the dispatcher flip it on its next tick.
      return 'ready'
    case 'review':
      // 'review' isn't a first-class Hermes status; keep the task visible by
      // marking it 'ready'.
      return 'ready'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    case 'deleted':
      return 'archived'
    default:
      return 'ready'
  }
}

/** Default status for a NEW card: 'ready' unless the column parks it. */
function createStatusForColumn(column: TaskColumn | undefined): string {
  if (column === 'backlog' || column === 'todo') return 'todo'
  return columnToStatus(column)
}

/** Agent numeric priority → Tasks-tab priority. Defaults to 'medium'. */
function numericToPriority(priority: number | null | undefined): TaskPriority {
  switch (priority) {
    case 2:
      return 'high'
    case 1:
      return 'medium'
    case 0:
      return 'low'
    default:
      return 'medium'
  }
}

function priorityToNumeric(priority: TaskPriority | undefined): number | undefined {
  switch (priority) {
    case 'high':
      return 2
    case 'medium':
      return 1
    case 'low':
      return 0
    default:
      return undefined
  }
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : Math.round(value * 1000)
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

/** Map an agent kanban task into the frontend TaskRecord shape. */
export function dashboardTaskToRecord(task: DashboardKanbanTask): TaskRecord {
  const createdAt = normalizeTimestamp(task.created_at)
  const updatedAt = normalizeTimestamp(
    task.started_at ?? task.completed_at ?? task.created_at,
  )
  return {
    id: task.id,
    title: task.title,
    description: task.body ?? '',
    column: statusToColumn(task.status),
    priority: numericToPriority(task.priority),
    assignee: task.assignee ?? null,
    tags: [],
    due_date: null,
    position: 0,
    created_by: task.created_by ?? 'hermes-kanban',
    created_at: createdAt,
    updated_at: updatedAt,
    session_id: null,
  }
}

// ── public bridge API ───────────────────────────────────────────────

/** List agent kanban tasks, mapped + filtered into TaskRecord shape. */
export async function listKanbanTasks(
  filters: TaskListFilters = {},
): Promise<TaskRecord[]> {
  const board = await fetchDashboardKanbanBoard()
  let tasks: TaskRecord[] = []
  for (const column of board.columns) {
    for (const task of column.tasks) {
      tasks.push(dashboardTaskToRecord(task))
    }
  }

  if (!filters.includeDone) {
    tasks = tasks.filter((task) => task.column !== 'done')
  }
  if (filters.column) {
    tasks = tasks.filter((task) => task.column === filters.column)
  }
  if (filters.assignee) {
    tasks = tasks.filter((task) => task.assignee === filters.assignee)
  }
  if (filters.priority) {
    tasks = tasks.filter((task) => task.priority === filters.priority)
  }

  return tasks.sort(
    (a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at),
  )
}

/** Fetch one agent kanban task by id, mapped to TaskRecord. Null on 404. */
export async function getKanbanTask(taskId: string): Promise<TaskRecord | null> {
  const task = await fetchDashboardKanbanTask(taskId)
  return task ? dashboardTaskToRecord(task) : null
}

/** Create a task on the agent kanban, returning it in TaskRecord shape. */
export async function createKanbanTask(
  input: CreateKanbanTaskInput,
): Promise<TaskRecord> {
  // Default the workspace to dir:/workspace when none is provided so dispatched
  // crew agents can reach the cloned project repos under /workspace.
  const workspace = input.workspace?.trim() || 'dir:/workspace'
  const [workspaceKind, ...workspaceRest] = workspace.split(':')
  const workspacePath = workspaceRest.join(':')

  const task = await createDashboardKanbanTask({
    title: input.title.trim(),
    body: (input.description ?? '').trim() || undefined,
    assignee: input.assignee?.trim() || undefined,
    status: createStatusForColumn(input.column),
    priority: priorityToNumeric(input.priority),
    created_by: input.created_by?.trim() || 'hermes-workspace',
    workspace_kind: workspaceKind || 'dir',
    workspace_path: workspacePath || '/workspace',
  })
  return dashboardTaskToRecord(task)
}

/** Patch an agent kanban task (maps column → status). Null on 404. */
export async function updateKanbanTask(
  taskId: string,
  updates: UpdateKanbanTaskInput,
): Promise<TaskRecord | null> {
  const patch: Parameters<typeof updateDashboardKanbanTask>[1] = {}
  if (typeof updates.title === 'string' && updates.title.trim())
    patch.title = updates.title.trim()
  if (typeof updates.description === 'string') patch.body = updates.description
  if (updates.assignee !== undefined)
    patch.assignee = updates.assignee?.trim() || null
  if (updates.column !== undefined) patch.status = columnToStatus(updates.column)
  const priority = priorityToNumeric(updates.priority)
  if (priority !== undefined) patch.priority = priority

  if (Object.keys(patch).length === 0) {
    return getKanbanTask(taskId)
  }

  try {
    const updated = await updateDashboardKanbanTask(taskId, patch)
    return dashboardTaskToRecord(updated)
  } catch (err) {
    if (err instanceof Error && err.message.includes('→ 404')) return null
    throw err
  }
}

/**
 * "Delete" on the agent kanban. The plugin exposes no hard delete, so we
 * archive the task by setting its status to a terminal/archived state via the
 * update path. Returns false on 404. Throws if the dashboard rejects the
 * archive write (caller decides whether to surface a 501/error).
 */
export async function archiveKanbanTask(taskId: string): Promise<boolean> {
  const updated = await updateKanbanTask(taskId, { column: 'deleted' })
  return updated !== null
}
