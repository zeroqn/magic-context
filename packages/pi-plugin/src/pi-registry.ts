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

import type {
	AgentToolResult,
	ContextEvent,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { log } from "@magic-context/core/shared/logger";
import { CHILD_TOOL_ALLOWLIST } from "./pi-child-mode";
import {
	BRIDGE_API_VERSION,
	BRIDGE_OWNER,
	bridgeToolEntries,
	isBridgePublishable,
	publishBridgeTools,
} from "./pi-tool-publication";

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

/**
 * A bound child's `todowrite` capability — the definition and the capture in one value.
 *
 * One value, not two members, on purpose (`zeroqn/pi`'s `.scratch/child-surface/`, ticket 05):
 * a child must never be given the tool without the capture, because a `todowrite` whose state
 * is never recorded is exactly the failure this package's publication rules exist to prevent.
 * The shim registers `definition` and forwards the child's `message_end` to `capture`.
 */
export interface PiChildTodoCapability {
	/** This instance's own `todowrite` definition, exactly as it registers it for a root. */
	definition: ToolDefinition;
	/**
	 * Capture one of the *child's* messages. The state lands under the child's own session
	 * id — never the parent's, whose list a whole-list replacement would clobber — and the
	 * human overlay is left alone, because a child has no UI and the overlay belongs to the
	 * parent's session.
	 */
	capture(message: unknown, ctx: ExtensionContext): void;
}

export interface PiMagicContextRegistry extends PiMagicContextWork {
	/**
	 * A bound child's todo capability, or `undefined` when this instance cannot serve one.
	 * Present only in bundles that know about children's `todowrite`; a shim must treat its
	 * absence as "not offered" rather than registering a tool with nothing behind it.
	 */
	childTodo(): PiChildTodoCapability | undefined;
	/**
	 * Release a child. The **session file is the releasing key**: the binding is keyed by it,
	 * so clearing only the id leaves the file bound forever and a later session reusing it would
	 * be served as a child. Optional so an older caller still cleans its own session state.
	 */
	clearSession(sessionId: string, sessionFile?: string): void;
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

/**
 * What a Magic Context instance offers the tool bridge (wayfinder ticket 04).
 *
 * Both members consult the *same* policy, so the catalogue can never advertise a tool that
 * `execute` would refuse: `publishableNames` is the single answer to "may this session call this?".
 * The bridge is additive — `runTool` above keeps its child allowlist untouched.
 */
export interface PiBridgeWork {
	/** The tool names this session may be offered. */
	publishableNames(ctx: ExtensionContext): string[];
	execute(
		name: string,
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

/**
 * Whether this session is a bound child — the single answer to what used to be two facts.
 *
 * A session is bound iff one of its **own** keys (its session id or its file) is in a
 * registration's `bound` set, which is exactly what `bindChild` writes. Deriving reduced mode
 * from the binding rather than from a parallel id-keyed mark means a child that was bound
 * without a session id — a resumed child, or a shim that could not read one — is served in
 * reduced mode like any other, and `clearSession` releasing the file releases the mode with it.
 *
 * Deliberately **not** `resolve(ctx) !== undefined`: `resolve` falls back to "the only
 * registration" for an unbound session, and that fallback must not make a root look like a child.
 */
export function isBoundChild(ctx: unknown): boolean {
	const keys = sessionKeys(ctx);
	if (keys.length === 0) return false;
	for (const entry of registrations) {
		for (const key of keys) if (entry.bound.has(key)) return true;
	}
	return false;
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
 * The one refusal the bridge can produce, and it should be unreachable: a reader advertises exactly
 * what this instance granted. It exists because a caller must get an answer rather than a throw if
 * the catalogue and the executor ever disagree.
 */
function bridgeRefusal(toolName: string, reason: string): PiToolResult {
	return {
		content: [
			{
				type: "text" as const,
				text: `Error: '${toolName}' is not available — ${reason}.`,
			},
		],
		details: undefined,
	};
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
	/** Offer this instance's tools to a code-mode kernel. Absent means "publish nothing". */
	bridge?: PiBridgeWork;
	/**
	 * A bound child's todo capability. Absent means this instance serves no child a
	 * `todowrite` at all, which is the honest answer when the tool is disabled or nothing
	 * registered it — better an absent name than one whose state is never recorded.
	 */
	childTodo?: () => PiChildTodoCapability | undefined;
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
		childTodo: () => options.childTodo?.(),
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
			// tag sentence, but none of the parent-oriented prompt surface. The binding *is*
			// the mark (`isBoundChild`), so there is nothing else to write here: the file key
			// added above is the whole fact. `.scratch/child-surface/` ticket 04.
			log(
				`[magic-context][pi] bound child session ${keys[0]} to parent ${input.parentSessionFile ?? "(unknown)"} on ${targets.length} instance(s) — a bound session is served in reduced mode`,
			);
			log(
				input.childSessionId
					? `[magic-context][pi] child ${input.childSessionId} is served in reduced mode`
					: "[magic-context][pi] child bound WITHOUT a session id; reduced mode derives from the binding, so it is still served as a child",
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
		// Releasing a child means releasing its **binding**, which is keyed by the child's
		// session file — the id alone used to be deleted here, which was a silent no-op and
		// only appeared to work because a second, id-keyed mark released the session.
		// `.scratch/child-surface/` ticket 04. The file is optional so an older caller still
		// cleans its own session state; pass it and the binding goes with it.
		clearSession: (sessionId, sessionFile) => {
			for (const entry of registrations) {
				entry.bound.delete(sessionId);
				if (sessionFile !== undefined) entry.bound.delete(sessionFile);
				entry.registry.clearSession(sessionId);
			}
		},
	};
	(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = facade;

	// Offer this instance's tools to a code-mode kernel (wayfinder ticket 04). Published from here
	// because resolution lives here: the publication answers only for the sessions *this* instance
	// owns, so two instances in one process coexist without either answering for the other. The key
	// identifies the instance, so a re-import replaces its own publication rather than adding one.
	const bridge = options.bridge;
	// One policy, filtered by the convention's own rule, feeding both halves of the offer: what the
	// catalogue lists and what `execute` accepts are then the same set by construction.
	const grantedNames = (ctx: ExtensionContext): string[] =>
		(bridge?.publishableNames(ctx) ?? []).filter(isBridgePublishable);
	const unpublishBridge = bridge
		? publishBridgeTools(
				`${BRIDGE_OWNER}\u0000${options.dbPath}\u0000${options.projectDir}`,
				{
					owner: BRIDGE_OWNER,
					apiVersion: BRIDGE_API_VERSION,
					catalogue: (ctx) =>
						resolve(ctx) === registration
							? bridgeToolEntries(
									registration.tools,
									grantedNames(ctx as ExtensionContext),
								)
							: [],
					execute: async (name, params, ctx) => {
						if (resolve(ctx) !== registration) {
							return bridgeRefusal(
								name,
								"Magic Context has no instance serving this session",
							);
						}
						if (!grantedNames(ctx as ExtensionContext).includes(name)) {
							return bridgeRefusal(name, "not available in this session");
						}
						return bridge.execute(name, params, ctx as ExtensionContext);
					},
				},
			)
		: () => {};

	return () => {
		unpublishBridge();
		registrations.delete(registration);
		if (registrations.size === 0)
			delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
	};
}

/** Test seam: the number of live registrations. */
export function __piRegistrySizeForTests(): number {
	return registrations.size;
}
