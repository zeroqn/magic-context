/**
 * The registry that lets one Magic Context instance serve a **bound child session**.
 *
 * RLM spawns in-process children that load no ambient extensions, so MC's factory never
 * runs inside them; RLM injects a thin shim that forwards the child's `context`,
 * `session_before_compact` and `message_end` events to its *parent's* MC instance
 * through this registry (wayfinder ticket 16, seam B).
 *
 * Published at a `Symbol.for` key on `globalThis` for the same reason the existing child
 * marker is: Pi's jiti loader re-imports modules per session (`moduleCache: false`), so
 * module-level state does not survive across sessions within one process.
 *
 * Recognition is **explicit binding**, never the session header. `SessionManager.forkFrom`
 * also writes `parentSession`, so a `/fork` is indistinguishable from a child by header
 * alone — treating one as a child would hand a user's fork to another session's pipeline.
 */
import { log } from "@magic-context/core/shared/logger";
import type {
	AgentToolResult,
	ContextEvent,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	CHILD_TOOL_ALLOWLIST,
	markReducedSession,
	unmarkReducedSession,
} from "./pi-child-mode";

export type PiToolResult = AgentToolResult<unknown>;

/** The work an instance supplies. The facade adds the dispatch on top. */
export interface PiMagicContextWork {
	transformContext(
		event: ContextEvent,
		ctx: ExtensionContext,
	): Promise<{ messages: ContextEvent["messages"] } | undefined>;
	compact(ctx: ExtensionContext): Promise<{ cancel: true } | undefined>;
	/** Idempotent prefix scrub, safe to run for every instance. */
	scrubMessage(message: unknown): void;
	bindChild(input: {
		childSessionFile?: string;
		childSessionId?: string;
		parentSessionFile?: string;
		cwd?: string;
	}): void;
	clearSession(sessionId: string): void;
}

export interface PiMagicContextRegistry extends PiMagicContextWork {
	/**
	 * Runs one allowlisted Magic Context tool on behalf of a bound child. The child's own
	 * ctx travels with the call, so session-scoped tools resolve to the child's session
	 * and its search sees the child's own messages plus the project's memories — which is
	 * exactly what v2 ticket 02 grants, without a second implementation of the scoping.
	 */
	runTool(
		toolName: string,
		params: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<PiToolResult>;
}

const REGISTRY_KEY = Symbol.for("@cortexkit/magic-context:pi-registry");

interface Registration {
	dbPath: string;
	projectDir: string;
	registry: PiMagicContextWork;
	/** Sessions this instance was explicitly told it owns. */
	bound: Set<string>;
	/** The instance's registered tool definitions, keyed by name (v2 ticket 02). */
	tools: Map<string, ToolDefinition>;
}

const registrations = new Set<Registration>();

function sessionKeys(ctx: unknown): string[] {
	const sessionManager = (ctx as { sessionManager?: unknown } | undefined)
		?.sessionManager as
		| {
				getSessionId?: () => string | undefined;
				getSessionFile?: () => string | undefined;
		  }
		| undefined;
	const keys: string[] = [];
	try {
		const id = sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) keys.push(id);
	} catch {
		/* a probe must never throw into a transform */
	}
	try {
		const file = sessionManager?.getSessionFile?.();
		if (typeof file === "string" && file.length > 0) keys.push(file);
	} catch {
		/* see above */
	}
	return keys;
}

/** The instance that owns this session, if any. */
function resolve(ctx: unknown): Registration | undefined {
	const keys = sessionKeys(ctx);
	for (const registration of registrations) {
		if (keys.some((key) => registration.bound.has(key))) return registration;
	}
	// One instance can serve whatever it is handed. With several, only an explicit
	// binding can disambiguate, so an unbound session is left alone.
	return registrations.size === 1 ? [...registrations][0] : undefined;
}

/**
 * Publishes this instance and returns the function that withdraws it. Idempotent, because
 * shutdown paths can run more than once.
 */
export function registerPiRegistry(options: {
	dbPath: string;
	projectDir: string;
	registry: PiMagicContextWork;
	/** The instance's registered tools, so a bound child can be served them. */
	tools?: Map<string, ToolDefinition>;
}): () => void {
	const registration: Registration = {
		dbPath: options.dbPath,
		projectDir: options.projectDir,
		registry: options.registry,
		bound: new Set(),
		tools: options.tools ?? new Map(),
	};
	registrations.add(registration);

	const facade: PiMagicContextRegistry = {
		transformContext: async (event, ctx) =>
			resolve(ctx)?.registry.transformContext(event, ctx),
		compact: async (ctx) => resolve(ctx)?.registry.compact(ctx),
		// Scrubbing is idempotent, so every instance may run it.
		scrubMessage: (message) => {
			for (const entry of registrations) entry.registry.scrubMessage(message);
		},
		bindChild: (input) => {
			const keys = [input.childSessionFile].filter(
				(value): value is string =>
					typeof value === "string" && value.length > 0,
			);
			if (keys.length === 0) return;
			// The child shares its parent's working directory, which is enough to pick the
			// right project when several are open in one process.
			const matches = [...registrations].filter(
				(entry) => input.cwd === undefined || entry.projectDir === input.cwd,
			);
			const targets =
				matches.length > 0
					? matches
					: registrations.size === 1
						? [...registrations]
						: [];
			for (const entry of targets) for (const key of keys) entry.bound.add(key);
			// v2 ticket 02/03: a bound child is served in reduced mode — compaction and the
			// tag sentence, but none of the parent-oriented prompt surface. The pass decides
			// by session id, so mark that too when the shim supplied it.
			markReducedSession(input.childSessionId);
			log(
				`[magic-context][pi] bound child session ${keys[0]} to parent ${input.parentSessionFile ?? "(unknown)"} on ${targets.length} instance(s)`,
			);
			// Reduced mode is marked by session id, which only the shim can supply. Say so
			// rather than failing silently: a child without it would quietly receive the
			// parent-oriented prompt surface (v2 ticket 02/03).
			log(
				input.childSessionId
					? `[magic-context][pi] child ${input.childSessionId} is served in reduced mode`
					: "[magic-context][pi] child bound WITHOUT a session id — reduced mode not marked, the pass will treat it as a parent session",
			);
		},
		runTool: async (toolName, params, ctx) => {
			if (!CHILD_TOOL_ALLOWLIST.has(toolName)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: '${toolName}' is not available in this session.`,
						},
					],
					details: undefined,
				};
			}
			const definition = resolve(ctx)?.tools.get(toolName);
			if (!definition) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: '${toolName}' is not available — Magic Context has no instance serving this session.`,
						},
					],
					details: undefined,
				};
			}
			return definition.execute(
				`child-${toolName}-${Date.now()}`,
				params,
				undefined,
				undefined,
				ctx,
			);
		},
		clearSession: (sessionId) => {
			for (const entry of registrations) {
				entry.bound.delete(sessionId);
				entry.registry.clearSession(sessionId);
			}
			unmarkReducedSession(sessionId);
		},
	};
	(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = facade;

	return () => {
		registrations.delete(registration);
		if (registrations.size === 0)
			delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
	};
}

/** Test seam: the number of live registrations. */
export function __piRegistrySizeForTests(): number {
	return registrations.size;
}
