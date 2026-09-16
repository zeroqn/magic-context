/**
 * Bound-child mode — the Magic Context half of wayfinder v2's child contract.
 *
 * A **bound child** is an RLM session served by its parent's Magic Context instance
 * through the registry (`pi-registry.ts`). V2 decided what such a session receives,
 * and the decisions that need code live here:
 *
 *   - `ticket 02`: the child is granted exactly `ctx_search`, `ctx_reduce` and
 *     `ctx_expand`, routed through the registry's `runTool`. Nothing else is reachable.
 *   - `ticket 02/03`: the **parent-oriented prompt surface is withheld** — no note
 *     nudges, no auto-search hint — while compaction and the tag sentence stay. The
 *     gate is `isReducedSession`, consulted at the two injection sites in the pass.
 *   - `ticket 05`: Magic Context owns the wording that explains its own surface, so
 *     the tag sentence is injected here rather than in RLM's child prompt.
 *
 * Membership is per session id, marked when the shim binds and cleared when the child's
 * session ends. It is process state on purpose: the whole point of the registry is that
 * one instance serves sessions it never initialised for.
 */

/** v2 ticket 02: the only tool names a bound child may reach. */
export const CHILD_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	"ctx_search",
	"ctx_reduce",
	"ctx_expand",
]);

/**
 * v2 ticket 05, verbatim. Kept in Magic Context because MC introduces the tags and the
 * tools; RLM's child prompt says nothing about them.
 */
export const CHILD_TAG_SENTENCE =
	"Messages and tool outputs are tagged with §N§ identifiers (e.g. §1§, §42§). " +
	"Use ctx_reduce to drop tool outputs you have already processed. " +
	"ctx_search queries this project's memory; ctx_expand opens a tagged item.";

/** Marker used for idempotence, so a child is told once however many passes run. */
const CHILD_TAG_MARKER = "tagged with §N§ identifiers";

const reducedSessions = new Set<string>();

export function markReducedSession(sessionId: string | undefined): void {
	if (typeof sessionId === "string" && sessionId.length > 0) reducedSessions.add(sessionId);
}

export function unmarkReducedSession(sessionId: string | undefined): void {
	if (typeof sessionId === "string" && sessionId.length > 0) reducedSessions.delete(sessionId);
}

/**
 * True for a bound child. Consulted at the note-nudge and auto-search injection sites,
 * which exist to prompt the *context owner*; a child is not that owner, and its prompt
 * must not carry content its task did not ask for.
 */
export function isReducedSession(sessionId: string | undefined): boolean {
	return typeof sessionId === "string" && reducedSessions.has(sessionId);
}

/** Test seam. */
export function __clearReducedSessionsForTests(): void {
	reducedSessions.clear();
	tagSentenceLogged.clear();
}

/**
 * The tag sentence is injected into the *outgoing* messages on every pass, because the
 * pass rebuilds them from storage each time and never sees the injected copy. That is
 * safe — exactly one copy per request, no accumulation — but it would log on every pass,
 * so the diagnostic is reported once per child.
 */
const tagSentenceLogged = new Set<string>();

export function shouldLogTagSentence(sessionId: string | undefined): boolean {
	if (typeof sessionId !== "string" || sessionId.length === 0) return false;
	if (tagSentenceLogged.has(sessionId)) return false;
	tagSentenceLogged.add(sessionId);
	return true;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		let out = "";
		for (const part of value) {
			if (typeof part === "string") out += part;
			else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
				out += (part as { text: string }).text;
			}
		}
		return out;
	}
	return "";
}

function alreadyTold(messages: unknown[]): boolean {
	for (const message of messages) {
		if (textOf((message as { content?: unknown })?.content).includes(CHILD_TAG_MARKER)) return true;
	}
	return false;
}

function withAppendedText<M extends { content?: unknown }>(message: M, text: string): M {
	const content = message.content;
	if (typeof content === "string") return { ...message, content: `${content}\n\n${text}` };
	if (Array.isArray(content)) {
		return { ...message, content: [...content, { type: "text", text }] };
	}
	return message;
}

/**
 * Adds the tag sentence to a bound child's context, once, on the last user message —
 * the message the child reads as its task. Returns the input untouched when the session
 * is not a bound child, there is nothing to attach to, or the sentence is already there.
 */
export function ensureChildTagSentence<M extends { role?: unknown; content?: unknown }>(
	result: { messages: M[] } | undefined,
	sessionId: string | undefined,
): { messages: M[] } | undefined {
	if (!result || !Array.isArray(result.messages)) return result;
	if (!isReducedSession(sessionId)) return result;
	if (alreadyTold(result.messages)) return result;
	for (let index = result.messages.length - 1; index >= 0; index -= 1) {
		const message = result.messages[index];
		if (message?.role !== "user") continue;
		const messages = result.messages.slice();
		messages[index] = withAppendedText(message, CHILD_TAG_SENTENCE);
		return { messages };
	}
	return result;
}
