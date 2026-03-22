# Task System Design

## Goals

- Allow the agent to break work into discrete, serializable steps
- Support pausing, resuming, and delegating tasks
- Enable sub-agent execution with full context isolation

## Task Model

```ts
type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  parentId?: string;        // set if this is a subtask
  subtaskIds: string[];
  sessionIds: string[];     // all sessions that have worked on this task (in order)
  result?: string;          // output when completed
  error?: string;           // reason when failed
  createdAt: string;
  updatedAt: string;
}
```

`sessionIds` is appended with the current `sessionId` each time a session begins work on the task (i.e. when status transitions to `in_progress`). This field is used by the Memory Manager to locate relevant prior context in the L2 session store and inject it into the LLM context when the task is resumed.

## Todo List vs Tasks

These are two distinct but related concepts:

| Concept | Purpose | Tools |
|---------|---------|-------|
| **Todo list** | Flat, ordered checklist of immediate work items for the current session. Lightweight — a todo is just a title and a status. | `todo_create`, `todo_update`, `todo_list`, `todo_delete` |
| **Tasks** | Structured, serializable work items with full lifecycle tracking, subtasks, parent/child relationships, and results. Persist across sessions. | `task_create`, `task_update`, `task_list` |

Typical pattern: the agent breaks a goal into **tasks** (the plan), then works through them by managing a **todo list** (the current step). Tasks survive process restarts; the todo list is rebuilt from tasks when resuming.

### Todo Tools

- `todo_create` — add an item to the todo list
- `todo_update` — change status or description of an item
- `todo_list` — read the current ordered list
- `todo_delete` — remove an item by id

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
Find next pending task
        │
        ▼
Mark as in_progress → execute
        │
   ┌────┴────┐
success    failure
   │           │
completed   failed + error
        │
        ▼
Repeat until list is empty
```
