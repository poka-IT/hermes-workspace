import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { createTask, listTasks } from '../../server/tasks-store'
import type { TaskColumn, TaskPriority } from '../../server/tasks-store'
import {
  createKanbanTask,
  listKanbanTasks,
  isDashboardKanbanAvailable,
  type TaskListFilters,
} from '../../server/tasks-kanban-bridge'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isTaskColumn(value: unknown): value is TaskColumn {
  return (
    value === 'backlog' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'review' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'deleted'
  )
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

export const Route = createFileRoute('/api/hermes-tasks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        const url = new URL(request.url)
        const filters: TaskListFilters = {
          column: url.searchParams.get('column'),
          assignee: url.searchParams.get('assignee'),
          priority: url.searchParams.get('priority'),
          includeDone: url.searchParams.get('include_done') === 'true',
        }

        // Bridge: prefer the agent kanban (dispatcher-backed) so launched
        // tasks actually run. Falls back to the local tasks-store when the
        // dashboard is unavailable so the tab degrades gracefully.
        if (await isDashboardKanbanAvailable()) {
          try {
            const tasks = await listKanbanTasks(filters)
            return jsonResponse({ tasks })
          } catch {
            // Dashboard reachable at probe time but failed mid-call — fall
            // through to the local store rather than 500ing the tab.
          }
        }

        const tasks = listTasks(filters)
        return jsonResponse({ tasks })
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        try {
          const body = (await request.json()) as Record<string, unknown>
          if (!body.title || typeof body.title !== 'string') {
            return jsonResponse({ error: 'title is required' }, 400)
          }

          const input = {
            id: typeof body.id === 'string' ? body.id : undefined,
            title: body.title,
            description: typeof body.description === 'string' ? body.description : '',
            column: isTaskColumn(body.column) ? body.column : undefined,
            priority: isTaskPriority(body.priority) ? body.priority : undefined,
            assignee: typeof body.assignee === 'string' ? body.assignee : null,
            tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            due_date: typeof body.due_date === 'string' ? body.due_date : null,
            position: typeof body.position === 'number' ? body.position : 0,
            created_by: typeof body.created_by === 'string' ? body.created_by : 'user',
            // Optional agent-kanban workspace hint (kind:path, e.g. "dir:/workspace").
            workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
          }

          // Bridge: create on the agent kanban so the dispatcher can claim and
          // run it. Falls back to the local store when the dashboard is down.
          if (await isDashboardKanbanAvailable()) {
            try {
              const task = await createKanbanTask(input)
              return jsonResponse({ task }, 201)
            } catch {
              // Fall through to local store on a mid-call failure.
            }
          }

          const task = createTask(input)
          return jsonResponse({ task }, 201)
        } catch {
          return jsonResponse({ error: 'Invalid request body' }, 400)
        }
      },
    },
  },
})
