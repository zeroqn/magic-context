/**
 * Pi-side `todowrite` tool.
 *
 * # Why this exists
 *
 * OpenCode ships a built-in `todowrite` tool that the agent uses to manage
 * work-tracking state. Magic Context captures that state in
 * `session_meta.last_todo_state` via the `tool.execute.after` hook so the
 * synthetic-todowrite injector can resurface it across cache-busts.
 *
 * Pi-coding-agent has NO built-in `todowrite` — Pi treats todo management
 * as an extension concern (see `pi-mono/packages/coding-agent/examples/extensions/todo.ts`
 * for a community example). That means:
 *   1. The Pi LLM won't see a `todowrite` tool unless something registers it.
 *   2. Without registration, the agent can't emit `todowrite` calls, so
 *      synthetic-todowrite injection has nothing to surface.
 *   3. e2e tests can't drive the capture path either.
 *
 * Magic Context provides a built-in `todowrite` to close this parity gap.
 * The tool is intentionally minimal: it accepts the same `{ todos: [...] }`
 * shape OpenCode uses, returns a pretty-printed JSON acknowledgement
 * (matching OpenCode's `todo.ts` output), and lets the message_end capture
 * path in `index.ts` snapshot the args into `session_meta.last_todo_state`.
 *
 * Wire-shape parity verified against:
 *   - OpenCode source: `~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts`
 *   - Synthetic part shape: `packages/plugin/src/hooks/magic-context/todo-view.ts`
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	TITLE_DONE_STATUSES,
	TODO_PRIORITIES,
	TODO_STATUSES,
} from "@magic-context/core/hooks/magic-context/todo-view";
import { type Static, Type } from "typebox";
import {
	renderTodowriteCall,
	renderTodowriteResult,
	TODO_TOOL_NAME,
} from "./todo-view-pi";

const TodoItem = Type.Object({
	content: Type.String({ description: "Brief description of the task" }),
	status: Type.Union(TODO_STATUSES.map((v) => Type.Literal(v))),
	priority: Type.Optional(
		Type.Union(TODO_PRIORITIES.map((v) => Type.Literal(v))),
	),
	id: Type.Optional(
		Type.String({ description: "Optional stable id for the todo" }),
	),
});

const TodowriteParams = Type.Object({
	todos: Type.Array(TodoItem, {
		description:
			"Replace the current task list with this complete set of todos. Include every task you intend to track this turn — pending, in_progress, completed, or cancelled — because the list overwrites previous state.",
	}),
});

type TodowriteParamsT = Static<typeof TodowriteParams>;

const PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

/**
 * The first thing wrong with `todos`, in words the caller can act on, or `null` when the payload is
 * exactly what the capture accepts.
 *
 * # Why the tool validates what the capture already rejects
 *
 * `getCompatiblePiTodoCapture` accepts only this exact shape, and a payload it refuses changes **no**
 * state — the snapshot, the overlay, `session_meta.last_todo_state` and the synthetic injection all
 * keep the previous list. The tool's own output is the acknowledgement, so before this gate a payload
 * with, say, `status: "done"` returned the caller's own array in pretty JSON: the call *looked* like a
 * write while nothing had moved. A cell-routed call makes that worse, because the caller sees the text
 * only if it prints it (measured: `01a1421a` wrote the list twice from a cell, both results assigned to
 * a variable and never printed — whether either landed cannot be read off the transcript).
 *
 * The enum is the whole contract, so the message names the offending field rather than the rule.
 */
function incompatibleTodo(todos: unknown): string | null {
	if (!Array.isArray(todos)) return "`todos` is not an array";
	for (const [index, todo] of todos.entries()) {
		if (!todo || typeof todo !== "object")
			return `todos[${index}] is not an object`;
		const item = todo as {
			content?: unknown;
			status?: unknown;
			priority?: unknown;
		};
		if (typeof item.content !== "string" || item.content.length === 0) {
			return `todos[${index}].content is not a non-empty string`;
		}
		if (
			!TODO_STATUSES.includes(item.status as (typeof TODO_STATUSES)[number])
		) {
			return `todos[${index}].status is ${JSON.stringify(item.status)}, and the only statuses are ${TODO_STATUSES.join(", ")}`;
		}
		if (
			item.priority !== undefined &&
			!TODO_PRIORITIES.includes(
				item.priority as (typeof TODO_PRIORITIES)[number],
			)
		) {
			return `todos[${index}].priority is ${JSON.stringify(item.priority)}, and the only priorities are ${TODO_PRIORITIES.join(", ")} (or omit it)`;
		}
	}
	return null;
}

const PROMPT_GUIDELINES = [
	"Use `todowrite` for non-trivial work spanning 3+ steps, when the user gives you multiple tasks, or when you need to track progress across a verify/fix loop. Skip it for single-shot answers or trivial one-step work.",
	"Pass the COMPLETE updated todo list every time. This tool replaces the prior list rather than appending to it, so include pending, in_progress, completed, and cancelled tasks that should remain visible.",
	"When starting a task, mark exactly one todo `in_progress` before doing the work. Mark items `completed` immediately when done; use `cancelled` only for work that is no longer needed.",
	"Never mark a todo completed if verification is failing, implementation is partial, or an unresolved blocker remains. Keep it `in_progress` and add or update a todo for the blocker instead.",
];

export function createTodowriteTool(): ToolDefinition<typeof TodowriteParams> {
	return {
		name: TODO_TOOL_NAME,
		label: "Todos",
		description: "Manage the session task list.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodowriteParams,
		async execute(
			_toolCallId,
			params: TodowriteParamsT,
			_signal,
			_onUpdate,
			_ctx,
		) {
			const todos = params.todos ?? [];
			const invalid = incompatibleTodo(todos);
			if (invalid !== null) {
				// Loud, and `isError` so the transcript shows it as one: nothing was stored, and the caller
				// has to know that from the call itself rather than from a stale list later.
				return {
					content: [
						{
							type: "text" as const,
							text: `${TODO_TOOL_NAME}: the list was NOT updated — ${invalid}. No state changed and the current list stands as it was. Each item is \`{content, status}\` with status one of ${TODO_STATUSES.join(", ")} and optional priority ${TODO_PRIORITIES.join(", ")}.`,
						},
					],
					isError: true,
					details: { todos, title: "todos rejected", truncated: false },
				};
			}
			// Output shape matches OpenCode `todo.ts:46-52`: pretty-printed JSON
			// of the full todos array. Magic Context's `tool_execution_start`
			// and `message_end` handlers capture `params.todos` into
			// `session_meta.last_todo_state` directly, so this output is
			// purely for the agent's own visibility on the next turn.
			const active = todos.filter(
				(todo) => !TITLE_DONE_STATUSES.has(todo.status),
			).length;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(todos, null, 2),
					},
				],
				details: {
					todos,
					title: `${active} todos`,
					truncated: false,
				},
			};
		},
		renderCall(args, theme, context) {
			return renderTodowriteCall(args, theme, context);
		},
		renderResult(result, _opts, theme, context) {
			return renderTodowriteResult(result, theme, context);
		},
	};
}
