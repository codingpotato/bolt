# Task System Design

## Goals

- Allow the agent to break work into discrete, serializable steps
- Support pausing, resuming, and delegating tasks
- Enable sub-agent execution with full context isolation
- Support task dependencies (DAG) for ordered execution
- Support approval gates for interactive human-in-the-loop workflows

## Task Model

```ts
type TaskStatus = 'pending' | 'waiting' | 'in_progress' | 'blocked' | 'awaiting_approval' | 'completed' | 'failed';

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  parentId?: string;        // set if this is a subtask
  subtaskIds: string[];
  sessionIds: string[];     // all sessions that have worked on this task (in order)
  dependsOn: string[];      // task IDs that must complete before this task can start
  requiresApproval: boolean; // if true, agent must call user_review before marking completed
  result?: string;          // output when completed
  error?: string;           // reason when failed
  createdAt: string;
  updatedAt: string;
}
```

`sessionIds` is appended with the current `sessionId` each time a session begins work on the task (i.e. when status transitions to `in_progress`). This field is used by the Memory Manager to locate relevant prior context in the L2 session store and inject it into the LLM context when the task is resumed.

`dependsOn` lists task IDs that must reach `completed` status before this task can transition out of `pending`. The execution loop checks dependencies before picking a task.

`requiresApproval` signals that the task output should be reviewed by the user via `user_review` before the task is marked `completed`. This is used for creative content that the user needs to approve (e.g. video storyboards, image prompts) before expensive downstream operations (image/video generation) proceed.

## Task Lifecycle

```
pending ──────────► in_progress ──────────► completed
                         │                      ▲
                         │                      │
                         ├──► awaiting_approval ─┘  (user approves)
                         │          │
                         │          └──► in_progress  (user requests changes)
                         │
                         └──► blocked  (external condition — agent set)
                                  │
                                  └──► in_progress  (condition resolved)

[created with unmet deps] ──► waiting ──► pending  (all deps completed)
                                    │
                                    └──► failed  (any dep failed — cascade)
```

### Status Definitions

| Status | Meaning |
|--------|---------|
| `pending` | Task is ready to start — all dependencies met, not yet picked up by the execution loop |
| `waiting` | Task has unmet `dependsOn` dependencies; will transition to `pending` when all complete |
| `in_progress` | Agent is actively working on this task |
| `blocked` | Agent explicitly set this — task is running but cannot proceed due to an external condition (not a dependency). Transitions back to `in_progress` when resolved. |
| `awaiting_approval` | Task output is ready and presented to the user for review via `user_review` |
| `completed` | Task finished successfully; `result` contains the output |
| `failed` | Task failed; `error` contains the reason |

## Todo List vs Tasks

These are two distinct but related concepts:

| Concept | Purpose | Tools |
|---------|---------|-------|
| **Todo list** | Flat, ordered checklist of immediate work items for the current session. Lightweight — a todo is just a title and a status. | `todo_create`, `todo_update`, `todo_list`, `todo_delete` |
| **Tasks** | Structured, serializable work items with full lifecycle tracking, subtasks, dependencies, approval gates, and results. Persist across sessions. | `task_create`, `task_update`, `task_list` |

Typical pattern: the agent breaks a goal into **tasks** (the plan), then works through them by managing a **todo list** (the current step). Tasks survive process restarts; the todo list is rebuilt from tasks when resuming.

### Todo Tools

- `todo_create` — add an item to the todo list
- `todo_update` — change status or description of an item
- `todo_list` — read the current ordered list
- `todo_delete` — remove an item by id

### Task Tools

- `task_create({ title, description, dependsOn?, requiresApproval? })` — create a task; returns `{ id }`
- `task_update({ id, status, result?, error? })` — update task status and result
- `task_list()` — return all tasks with current status and dependency info

## Dependency Resolution

When a task is created with `dependsOn`, it starts in `waiting` status. The execution loop monitors waiting tasks and advances them:

```
For each task with status == 'waiting':
  If any dependency is 'failed':
    → mark this task 'failed' (cascade failure)
  Else if all dependencies are 'completed':
    → mark this task 'pending' (now eligible to execute)
  Else:
    → remain 'waiting'

For each task with status == 'pending':
  → eligible to start (mark in_progress)
```

Tasks created with no `dependsOn` start directly in `pending` status.

Dependencies form a DAG (directed acyclic graph). Circular dependencies are detected at `task_create` time and rejected with a ToolError.

## Approval Workflow

For tasks with `requiresApproval: true`:

```
Agent completes the work
        │
        ▼
Agent calls user_review with task output
        │
        ▼
Task status → 'awaiting_approval'
        │
   ┌────┴────┐
approved    feedback
   │            │
completed    in_progress (agent adjusts based on feedback)
                   │
                   ▼
              user_review again → repeat
```

This pattern is critical for the content generation workflow:
- **Video storyboard** — user reviews before image generation starts
- **Image prompts** — user reviews before ComfyUI is called
- **Generated images** — user reviews before video generation starts

## Sub-agent Delegation

When a task is delegated to a sub-agent:

1. Parent creates a child `Task` with a clear description and success criteria
2. Parent calls the `subagent_run` tool with a prompt that includes the task description and success criteria
3. A new agent process starts with a fresh context containing only the task prompt
4. Sub-agent executes and returns a structured result
5. Parent receives the result and calls `task_update` to record the outcome

`subagent_run` input schema:
```ts
interface SubagentRunInput {
  prompt: string;          // full task description and success criteria
  allowedTools?: string[]; // optional tool allowlist for the child agent
}
```

**Context isolation:** the sub-agent has no access to the parent's message history, memory store, or other tasks.

## Serialization

All tasks are persisted to `.bolt/tasks.json` after every mutation. This allows bolt to resume an interrupted session and continue from the last known state.

## Execution Loop

```
Load task list
        │
        ▼
Advance waiting tasks:
  - 'waiting' + all deps completed → 'pending'
  - 'waiting' + any dep failed → 'failed' (cascade)

Find next eligible task:
  - status == 'pending'
        │
        ▼
Mark as in_progress → execute
        │
   ┌────┴──────────┐
success          failure
   │                 │
   ├─ if requiresApproval:
   │    → awaiting_approval
   │    → user_review
   │    → approved? → completed
   │    → feedback? → in_progress (loop)
   │
   └─ else:
        → completed       failed + error
        │
        ▼
Repeat until all tasks are completed or failed
```

## Example: Video Production Task Graph

```
┌──────────────────┐
│ analyze-trends   │  status: pending (no deps)
│ requiresApproval │
└────────┬─────────┘
         │ completes
┌────────▼─────────┐
│ generate-script  │  status: waiting → pending
│ requiresApproval │
└────────┬─────────┘
         │ completes
┌────────▼─────────┐
│ generate-image-  │  status: waiting → pending
│ prompts          │
│ requiresApproval │
└────────┬─────────┘
         │ completes
┌────────▼─────────┐
│ generate-images  │  status: waiting → pending
│ requiresApproval │  ← calls ComfyUI via MCP
└────────┬─────────┘
         │ completes
┌────────▼─────────┐
│ generate-video-  │  status: waiting → pending
│ prompts          │
│ requiresApproval │
└────────┬─────────┘
         │ completes
┌────────▼─────────┐
│ generate-videos  │  status: waiting → pending
│ requiresApproval │  ← calls ComfyUI via MCP
└──────────────────┘
```
