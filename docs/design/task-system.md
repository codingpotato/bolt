# Task System Design

## Goals

- Allow the agent to break work into discrete, serializable steps
- Support pausing, resuming, and delegating tasks
- Enable sub-agent execution with full context isolation
- Support task dependencies (DAG) for ordered execution
- Support approval gates for interactive human-in-the-loop workflows

## Task Model

```ts
type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'awaiting_approval' | 'completed' | 'failed';

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
   │                     │                      ▲
   │                     │                      │
   │                     ├──► awaiting_approval ─┘  (user approves)
   │                     │          │
   │                     │          └──► in_progress  (user requests changes)
   │                     │
   │                     └──► failed
   │
   └──► blocked  (dependency not met)
           │
           └──► pending  (dependency completed)
```

### Status Definitions

| Status | Meaning |
|--------|---------|
| `pending` | Task created but not yet started (may be waiting for dependencies) |
| `in_progress` | Agent is actively working on this task |
| `blocked` | Task cannot proceed — either a dependency is not met, or an external condition is blocking |
| `awaiting_approval` | Task output is ready and presented to the user for review |
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

When the agent picks the next task to execute, the execution loop applies this logic:

```
For each task with status == 'pending':
  If task.dependsOn is empty or all dependencies are 'completed':
    → eligible to start (mark in_progress)
  Else if any dependency is 'failed':
    → mark this task as 'failed' (cascade failure)
  Else:
    → skip (dependencies not yet met)
```

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
Find next eligible task:
  - status == 'pending'
  - all dependsOn tasks are 'completed'
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
│ analyze-trends   │  (no deps)
│ requiresApproval │
└────────┬─────────┘
         │
┌────────▼─────────┐
│ generate-script  │  (depends on: analyze-trends)
│ requiresApproval │
└────────┬─────────┘
         │
┌────────▼─────────┐
│ generate-image-  │  (depends on: generate-script)
│ prompts          │
│ requiresApproval │
└────────┬─────────┘
         │
┌────────▼─────────┐
│ generate-images  │  (depends on: generate-image-prompts)
│ requiresApproval │  ← calls ComfyUI via MCP
└────────┬─────────┘
         │
┌────────▼─────────┐
│ generate-video-  │  (depends on: generate-images)
│ prompts          │
│ requiresApproval │
└────────┬─────────┘
         │
┌────────▼─────────┐
│ generate-videos  │  (depends on: generate-video-prompts)
│ requiresApproval │  ← calls ComfyUI via MCP
└──────────────────┘
```
