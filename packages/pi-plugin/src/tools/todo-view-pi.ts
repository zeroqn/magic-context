import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	TITLE_DONE_STATUSES,
	TODO_PRIORITIES,
	TODO_STATUSES,
} from "@magic-context/core/hooks/magic-context/todo-view";
import { isBoundChild } from "../pi-registry";
import {
	decideTodoSettle,
	forgetTodoSettleState,
	noteRunStart,
	readLiveWork,
	type SettleSurface,
	TODO_SETTLE_EVENT,
	type TodoSettleEvent,
} from "../pi-todo-settle";

export const TODO_TOOL_NAME = "todowrite";
export const TODOS_COMMAND_NAME = "todos";

/** The entry type the run-boundary nudge is recorded under (see `pi-todo-settle.ts`). */
export const TODO_REFRESH_CUSTOM_TYPE = "magic-context-todo-refresh";

const WIDGET_KEY = "magic-context-todos";
const MAX_TODO_CONTENT_ROWS = 12;

export { TODO_PRIORITIES, TODO_STATUSES };

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export interface TodoItem {
	content: string;
	status: TodoStatus;
	priority?: TodoPriority;
	id?: string;
}

export interface TodoSnapshot {
	todos: TodoItem[];
	/**
	 * True when this list was **loaded** from storage rather than written in this process.
	 *
	 * `session_start` seeds the panel from `session_meta.last_todo_state`, which on a resumed session is
	 * as old as the last write of the previous life of that session — measured at 6h44m in
	 * `.scratch/todo-desync/TARBALL-01a1421a.md`, where the panel came back showing "3 in progress" for
	 * work that had finished hours earlier. The overlay says so in its heading; the first write of the
	 * session clears it.
	 */
	restored?: boolean;
}

interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	cancelled: number;
}

const STATUS_GLYPH: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	cancelled: "✗",
};

const STATUS_COLOR: Record<TodoStatus, Parameters<Theme["fg"]>[0]> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	cancelled: "error",
};

const snapshotsBySession = new Map<string, TodoSnapshot>();
const MAX_TODOWRITE_RENDER_CACHE_ENTRIES = 50;

// Current Pi versions build transcript tool components from streaming
// assistant updates, so todowrite can first render with partial or missing
// args. Later tool start/end events mark the call complete but do not replace
// the args already captured on that component. Cache validated todos by
// toolCallId so transcript renders can recover the final list when the
// component keeps stale args.
const cachedTodowriteTodosByToolCallId = new Map<string, TodoItem[]>();

type ToolRenderContext = { toolCallId?: string } | undefined;

function isTodoStatus(value: unknown): value is TodoStatus {
	return TODO_STATUSES.includes(value as TodoStatus);
}

function isTodoPriority(value: unknown): value is TodoPriority {
	return TODO_PRIORITIES.includes(value as TodoPriority);
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({ ...todo }));
}

export function rememberTodowriteToolCallTodos(
	toolCallId: string | undefined,
	todos: readonly TodoItem[],
): void {
	if (!toolCallId) return;
	cachedTodowriteTodosByToolCallId.delete(toolCallId);
	cachedTodowriteTodosByToolCallId.set(toolCallId, cloneTodos(todos));
	while (
		cachedTodowriteTodosByToolCallId.size > MAX_TODOWRITE_RENDER_CACHE_ENTRIES
	) {
		const oldestKey = cachedTodowriteTodosByToolCallId.keys().next().value;
		if (typeof oldestKey !== "string") break;
		cachedTodowriteTodosByToolCallId.delete(oldestKey);
	}
}

function getCachedTodowriteToolCallTodos(
	toolCallId: string | undefined,
): TodoItem[] | null {
	if (!toolCallId) return null;
	const todos = cachedTodowriteTodosByToolCallId.get(toolCallId);
	return todos ? cloneTodos(todos) : null;
}

export function clearTodowriteToolCallTodos(): void {
	cachedTodowriteTodosByToolCallId.clear();
}

export function parseTodos(input: unknown): TodoItem[] | null {
	if (!Array.isArray(input)) return null;
	const todos: TodoItem[] = [];
	for (const item of input) {
		if (item === null || typeof item !== "object") return null;
		const raw = item as Record<string, unknown>;
		if (typeof raw.content !== "string" || !isTodoStatus(raw.status)) {
			return null;
		}
		const todo: TodoItem = {
			content: raw.content,
			status: raw.status,
		};
		if (isTodoPriority(raw.priority)) todo.priority = raw.priority;
		if (typeof raw.id === "string" && raw.id.length > 0) todo.id = raw.id;
		todos.push(todo);
	}
	return todos;
}

export function parseTodoStateJson(
	stateJson: string | null | undefined,
): TodoItem[] | null {
	if (!stateJson) return null;
	try {
		return parseTodos(JSON.parse(stateJson));
	} catch {
		return null;
	}
}

export function setTodoSnapshot(sessionId: string, todos: unknown): boolean {
	const parsed = parseTodos(todos);
	if (parsed === null) return false;
	// A write, not a load: the list is this session's own from here on (see `restored`).
	snapshotsBySession.set(sessionId, { todos: parsed, restored: false });
	return true;
}

export function seedTodoSnapshotFromStateJson(
	sessionId: string,
	stateJson: string | null | undefined,
): boolean {
	const parsed = parseTodoStateJson(stateJson);
	if (parsed === null) {
		snapshotsBySession.delete(sessionId);
		return false;
	}
	snapshotsBySession.set(sessionId, { todos: parsed, restored: true });
	return true;
}

export function getTodoSnapshot(sessionId: string | undefined): TodoSnapshot {
	if (!sessionId) return { todos: [] };
	const snapshot = snapshotsBySession.get(sessionId);
	return snapshot
		? {
				todos: cloneTodos(snapshot.todos),
				restored: snapshot.restored === true,
			}
		: { todos: [] };
}

export function clearTodoSnapshot(sessionId: string): void {
	snapshotsBySession.delete(sessionId);
}

export function __resetTodoSnapshotsForTests(): void {
	snapshotsBySession.clear();
	clearTodowriteToolCallTodos();
}

function getSessionId(ctx: {
	sessionManager?: { getSessionId?: () => string | undefined };
}): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function countTodos(todos: readonly TodoItem[]): TodoCounts {
	const counts: TodoCounts = {
		total: todos.length,
		pending: 0,
		inProgress: 0,
		completed: 0,
		cancelled: 0,
	};
	for (const todo of todos) {
		switch (todo.status) {
			case "pending":
				counts.pending++;
				break;
			case "in_progress":
				counts.inProgress++;
				break;
			case "completed":
				counts.completed++;
				break;
			case "cancelled":
				counts.cancelled++;
				break;
		}
	}
	return counts;
}

function activeTitleCount(todos: readonly TodoItem[]): number {
	// OpenCode's todowrite title excludes only completed todos; cancelled items
	// remain in the model-visible active count for wire-shape parity.
	return todos.filter((todo) => !TITLE_DONE_STATUSES.has(todo.status)).length;
}

function formatCounts(counts: TodoCounts): string {
	if (counts.total === 0) return "No todos";
	const parts = [`${counts.completed}/${counts.total} completed`];
	if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);
	if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
	return parts.join(" · ");
}

function formatTodoLine(
	todo: TodoItem,
	theme: Theme,
	options: { showId?: boolean } = {},
): string {
	const glyph = theme.fg(STATUS_COLOR[todo.status], STATUS_GLYPH[todo.status]);
	const id =
		options.showId && todo.id ? `${theme.fg("accent", `#${todo.id}`)} ` : "";
	const color =
		todo.status === "pending" || todo.status === "in_progress" ? "text" : "dim";
	let content = theme.fg(color, todo.content);
	if (todo.status === "completed" || todo.status === "cancelled") {
		content = theme.strikethrough(content);
	}
	return `${glyph} ${id}${content}`;
}

function formatCommandLine(todo: TodoItem): string {
	const id = todo.id ? `#${todo.id} ` : "";
	return `  ${STATUS_GLYPH[todo.status]} ${id}${todo.content}`;
}

/**
 * Pi's TUI re-renders every transcript component on every frame (continuously
 * while the working spinner runs), and a long session holds hundreds of todowrite
 * results. The rows are fixed once the component exists, so render once per
 * width; invalidate() drops the cache so a theme change still repaints.
 */
function lineComponent(renderLines: (width: number) => string[]): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];
	return {
		render(width: number) {
			if (width !== cachedWidth) {
				cachedLines = renderLines(width);
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
		},
	};
}

function capTodoRows<T>(rows: readonly T[]): {
	visible: T[];
	hiddenCount: number;
} {
	if (rows.length <= MAX_TODO_CONTENT_ROWS) {
		return { visible: [...rows], hiddenCount: 0 };
	}

	const visibleCount = Math.max(0, MAX_TODO_CONTENT_ROWS - 1);
	return {
		visible: rows.slice(0, visibleCount),
		hiddenCount: rows.length - visibleCount,
	};
}

export function renderTodowriteCall(
	args: { todos?: unknown },
	theme: Theme,
	context?: ToolRenderContext,
): Component {
	const todos =
		getCachedTodowriteToolCallTodos(context?.toolCallId) ??
		parseTodos(args.todos) ??
		[];
	const active = activeTitleCount(todos);
	const activeColor: Parameters<Theme["fg"]>[0] =
		active > 0 ? "warning" : "success";
	const line = `${theme.fg("toolTitle", theme.bold("Todos"))} ${theme.fg("muted", "—")} ${theme.fg(activeColor, `${active} active`)}`;
	return lineComponent((width) => [truncateToWidth(line, width, "…")]);
}

/** The first text part of a tool result, or `undefined` — what both renderers read. */
function firstResultText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	return content.find(
		(part): part is { type: "text"; text: string } =>
			part !== null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string",
	)?.text;
}

export function renderTodowriteResult(
	result: { details?: unknown; content?: unknown; isError?: unknown },
	theme: Theme,
	context?: ToolRenderContext,
): Component {
	// A rejected payload is not a list: rendering it as "No todos" would show the reader an empty list
	// where the call in fact changed nothing (see `incompatibleTodo` in `tools/todowrite.ts`).
	if (result.isError === true) {
		const text = firstResultText(result.content) ?? "the todo call failed";
		return lineComponent((width) => [
			truncateToWidth(theme.fg("error", text), width, "…"),
		]);
	}
	const detailsTodos = (result.details as { todos?: unknown } | undefined)
		?.todos;
	let todos = parseTodos(detailsTodos);
	if ((todos === null || todos.length === 0) && Array.isArray(result.content)) {
		const text = firstResultText(result.content);
		if (text) {
			try {
				const parsed = parseTodos(JSON.parse(text));
				if (parsed !== null) todos = parsed;
			} catch {
				// Leave the renderer empty if the tool result is not a todo list.
			}
		}
	}
	const renderedTodos =
		todos !== null && todos.length > 0
			? todos
			: (getCachedTodowriteToolCallTodos(context?.toolCallId) ?? todos ?? []);
	return lineComponent((width) => {
		if (renderedTodos.length === 0) return [theme.fg("dim", "No todos")];

		const { visible, hiddenCount } = capTodoRows(renderedTodos);
		const lines = visible.map((todo) =>
			truncateToWidth(
				formatTodoLine(todo, theme, { showId: true }),
				width,
				"…",
			),
		);
		if (hiddenCount > 0) {
			lines.push(
				truncateToWidth(theme.fg("dim", `+${hiddenCount} more`), width, "…"),
			);
		}
		return lines;
	});
}

export function registerTodosCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
): void {
	pi.registerCommand(TODOS_COMMAND_NAME, {
		description: "Show the current Magic Context todo list",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /todos command requires interactive UI.", "error");
				return;
			}
			const sessionId = getSessionId(ctx);
			const todos = getTodoSnapshot(sessionId).todos;
			if (todos.length === 0) {
				ctx.ui.notify("No todos yet.", "info");
				return;
			}

			const counts = countTodos(todos);
			const lines = [formatCounts(counts)];
			const groups: Array<[TodoStatus, string]> = [
				["pending", "── Pending ──"],
				["in_progress", "── In Progress ──"],
				["completed", "── Completed ──"],
				["cancelled", "── Cancelled ──"],
			];
			for (const [status, heading] of groups) {
				const group = todos.filter((todo) => todo.status === status);
				if (group.length === 0) continue;
				lines.push(heading);
				const { visible, hiddenCount } = capTodoRows(group);
				for (const todo of visible) lines.push(formatCommandLine(todo));
				if (hiddenCount > 0) lines.push(`  +${hiddenCount} more`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function todoKey(todo: TodoItem, index: number): string {
	return todo.id ? `id:${todo.id}` : `pos:${index}:${todo.content}`;
}

function isOverlayLive(todo: TodoItem): boolean {
	return todo.status === "pending" || todo.status === "in_progress";
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private sessionId: string | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<string>();
	private hiddenCompletedTaskIds = new Set<string>();
	private lastTodoKeys = new Set<string>();

	setUICtx(sessionId: string, ctx: ExtensionUIContext): void {
		// Pi invalidates widget instances on /reload and session replacement. The
		// factory-form widget below can recover only if we forget the old registration
		// when either the UI proxy or the foreground session identity changes.
		if (ctx !== this.uiCtx || sessionId !== this.sessionId) {
			this.uiCtx = ctx;
			this.sessionId = sessionId;
			this.widgetRegistered = false;
			this.tui = undefined;
			this.resetCompletedDisplayState();
		}
	}

	update(sessionId = this.sessionId): void {
		if (!this.uiCtx || !this.sessionId || sessionId !== this.sessionId) return;
		const todos = getTodoSnapshot(this.sessionId).todos;
		this.pruneCompletedDisplayState(todos);
		const visible = this.selectOverlayTodos(todos);

		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			// Use factory-form registration once and read module state at render time.
			// Re-registering on every todowrite fights Pi's widget lifecycle; refreshing
			// the existing factory via requestRender keeps /reload invalidation and TUI
			// resize handling reliable.
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastTodoKeys.clear();
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.update();
	}

	disposeSession(sessionId: string): void {
		if (this.sessionId !== sessionId) return;
		this.dispose();
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.sessionId = undefined;
		this.resetCompletedDisplayState();
	}

	private pruneCompletedDisplayState(todos: readonly TodoItem[]): void {
		const currentKeys = new Set(
			todos.map((todo, index) => todoKey(todo, index)),
		);
		const hasSharedKeys = [...currentKeys].some((key) =>
			this.lastTodoKeys.has(key),
		);
		if (this.lastTodoKeys.size > 0 && currentKeys.size > 0 && !hasSharedKeys) {
			this.resetCompletedDisplayState();
		}
		this.lastTodoKeys = currentKeys;
		const completedKeys = new Set(
			todos
				.map((todo, index) => ({ todo, key: todoKey(todo, index) }))
				.filter(({ todo }) => todo.status === "completed")
				.map(({ key }) => key),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedKeys.has(taskId))
				this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedKeys.has(taskId))
				this.hiddenCompletedTaskIds.delete(taskId);
		}
	}

	private selectOverlayTodos(
		todos: readonly TodoItem[],
	): Array<{ todo: TodoItem; key: string }> {
		return todos
			.map((todo, index) => ({ todo, key: todoKey(todo, index) }))
			.filter(({ todo, key }) => {
				if (isOverlayLive(todo)) return true;
				return (
					todo.status === "completed" && !this.hiddenCompletedTaskIds.has(key)
				);
			});
	}

	private renderWidget(theme: Theme, width: number): string[] {
		if (!this.sessionId) return [];
		const todos = getTodoSnapshot(this.sessionId).todos;
		this.pruneCompletedDisplayState(todos);
		const overlayTodos = this.selectOverlayTodos(todos);
		if (overlayTodos.length === 0) return [];

		const counts = countTodos(todos);
		const hasInProgress = counts.inProgress > 0;
		const headingColor: Parameters<Theme["fg"]>[0] = hasInProgress
			? "accent"
			: "dim";
		const headingIcon = hasInProgress ? "●" : "○";
		// A list that was restored rather than written says so: without this, a resumed session
		// presents a previous life's state under the same heading as live work (see `TodoSnapshot.restored`).
		const restoredNote = getTodoSnapshot(this.sessionId).restored
			? ` ${theme.fg("dim", "· restored")}`
			: "";
		const heading = `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Todos")} ${theme.fg("muted", "—")} ${theme.fg("dim", formatCounts(counts))}${restoredNote}`;
		const truncate = (line: string) => truncateToWidth(line, width, "…");
		const lines = [truncate(heading)];

		const { visible, hiddenCount } = capTodoRows(overlayTodos);

		for (const [index, { todo, key }] of visible.entries()) {
			const isLast = index === visible.length - 1 && hiddenCount === 0;
			const branch = theme.fg("dim", isLast ? "└─" : "├─");
			lines.push(
				truncate(`${branch} ${formatTodoLine(todo, theme, { showId: true })}`),
			);
			if (todo.status === "completed")
				this.completedTaskIdsPendingHide.add(key);
		}

		if (hiddenCount > 0) {
			lines.push(
				truncate(
					`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenCount} more`)}`,
				),
			);
		}

		return lines;
	}
}

export function registerTodoOverlay(
	pi: Pick<ExtensionAPI, "on">,
	deps: { readLastTodoState: (sessionId: string) => string | null | undefined },
): TodoOverlay {
	const overlay = new TodoOverlay();

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;
		seedTodoSnapshotFromStateJson(sessionId, deps.readLastTodoState(sessionId));
		if (!ctx.hasUI) return;
		overlay.setUICtx(sessionId, ctx.ui);
		overlay.update(sessionId);
	});

	pi.on("agent_start", async (_event, ctx) => {
		// "This run" starts here: a write from an earlier run must not excuse the list from being
		// reconciled at the end of this one (see `decideTodoSettle`).
		noteRunStart(getSessionId(ctx) ?? "");
		overlay.hideCompletedTasksFromPreviousTurn();
	});

	/**
	 * The run's final boundary, and the one thing the overlay can do about a list whose work ended
	 * without a last write: ask the owner to reconcile it, in this run, from the model's own side.
	 *
	 * pi's contract for the returned entries is worth stating, because getting it wrong silently drops
	 * another extension's work: a handler's `entries` **replace** what earlier handlers drafted
	 * (`core/extensions/runner.js` `emitBoundary`), so the event's own array is carried forward here.
	 * `continue: true` buys exactly one more provider request, and only after the entry is committed —
	 * pi checks `canContinue` *after* committing, so an appended `custom_message` is what makes the
	 * continuation legal rather than an invalid-boundary warning.
	 */
	(pi as unknown as SettleSurface).on(
		TODO_SETTLE_EVENT,
		(event: TodoSettleEvent, ctx: unknown) => {
			const sessionId = getSessionId(
				ctx as { sessionManager?: { getSessionId?: () => string | undefined } },
			);
			// A bound child has no todo surface (its `todowrite` is stripped and the discipline is not written
			// for it) and its run is somebody's tool call: an extra request there is cost with no reader.
			if (!sessionId || isBoundChild(ctx)) return undefined;
			const decision = decideTodoSettle({
				sessionId,
				outcome: event?.outcome,
				todos: getTodoSnapshot(sessionId).todos,
				liveWork: readLiveWork(ctx),
			});
			if (!decision.nudge) return undefined;
			return {
				entries: [
					...(Array.isArray(event?.entries) ? event.entries : []),
					{
						type: "custom_message" as const,
						customType: TODO_REFRESH_CUSTOM_TYPE,
						content: decision.text,
						display: true,
					},
				],
				continue: true,
			};
		},
	);

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTodowriteToolCallTodos();
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;
		forgetTodoSettleState(sessionId);
		clearTodoSnapshot(sessionId);
		overlay.disposeSession(sessionId);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		clearTodowriteToolCallTodos();
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;
		forgetTodoSettleState(sessionId);
		clearTodoSnapshot(sessionId);
		overlay.disposeSession(sessionId);
	});

	return overlay;
}

export function registerTodoStateLifecycle(
	pi: Pick<ExtensionAPI, "on">,
	deps: { readLastTodoState: (sessionId: string) => string | null | undefined },
): void {
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;
		seedTodoSnapshotFromStateJson(sessionId, deps.readLastTodoState(sessionId));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTodowriteToolCallTodos();
		const sessionId = getSessionId(ctx);
		if (sessionId) clearTodoSnapshot(sessionId);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		clearTodowriteToolCallTodos();
		const sessionId = getSessionId(ctx);
		if (sessionId) clearTodoSnapshot(sessionId);
	});
}
