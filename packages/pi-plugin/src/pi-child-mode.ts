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
 *     gate is the *binding*, resolved by `isBoundChild` in `pi-registry.ts` and handed
 *     to this module as a boolean; nothing here keeps its own membership set.
 *   - `ticket 05`: Magic Context owns the wording that explains its own surface, so
 *     the tag sentence is injected here rather than in RLM's child prompt.
 *
 * **Membership is the binding** (`zeroqn/pi`'s `.scratch/child-surface/`, ticket 04). A
 * session is a bound child iff one of its own keys is in a registration's `bound` set,
 * which is exactly what `bindChild` writes — so a child that was bound without a session
 * id, or resumed on its own, is served in reduced mode like any other. This module used
 * to keep a second, id-keyed set (`markReducedSession`) beside that binding, and the two
 * could disagree; it no longer does.
 *
 * The tag sentence used to carry tool advice as well ("Use ctx_reduce …"). That half is
 * **deleted** (`.scratch/child-surface/`, ticket 06): a child reaches those tools through
 * the tool bridge, whose own generated line states how, so advice naming them here was
 * actionable only while the shim registered them as real Pi tools — and in a session with
 * no kernel it named tools the child had no way to call at all.
 */

/** v2 ticket 02: the only tool names a bound child may reach. */
export const CHILD_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	"ctx_search",
	"ctx_reduce",
	"ctx_expand",
]);

/**
 * v2 ticket 05 said Magic Context owns the wording that explains its own surface, so the
 * tag sentence lives here rather than in RLM's child prompt. **Amended by
 * `zeroqn/pi`'s `.scratch/child-surface/` ticket 06**: what v2 wrote verbatim also
 * advertised the three granted tools, which is the bridge's job now — see this file's
 * header. What remains is the half that is true in every state: what the tags are.
 */
export const CHILD_TAG_SENTENCE =
	"Messages and tool outputs are tagged with §N§ identifiers (e.g. §1§, §42§).";

/** Marker used for idempotence, so a child is told once however many passes run. */
const CHILD_TAG_MARKER = "tagged with §N§ identifiers";

/**
 * The catalogue a *bound child* may call: the names its parent may call, narrowed to the
 * granted allowlist (`zeroqn/pi`'s `.scratch/child-surface/` ticket 04).
 *
 * Written as an intersection, not as the allowlist alone, so "a child's catalogue is a subset
 * of its parent's" holds in **every** state — the unbound-parent row included, where the
 * intersection is over the full set and trivially a subset. The allowlist itself stays the one
 * constant both this and `runTool` read, so the catalogue can never advertise a name `runTool`
 * would refuse.
 */
export function narrowCatalogueForChild(
	parentNames: readonly string[],
	isChild: boolean,
): string[] {
	return isChild
		? parentNames.filter((name) => CHILD_TOOL_ALLOWLIST.has(name))
		: [...parentNames];
}

/** Test seam: the once-per-child tag diagnostic is the only process state left here. */
export function __clearChildModeForTests(): void {
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
			else if (
				part &&
				typeof part === "object" &&
				typeof (part as { text?: unknown }).text === "string"
			) {
				out += (part as { text: string }).text;
			}
		}
		return out;
	}
	return "";
}

function alreadyTold(messages: unknown[]): boolean {
	for (const message of messages) {
		if (
			textOf((message as { content?: unknown })?.content).includes(
				CHILD_TAG_MARKER,
			)
		)
			return true;
	}
	return false;
}

function withAppendedText<M extends { content?: unknown }>(
	message: M,
	text: string,
): M {
	const content = message.content;
	if (typeof content === "string")
		return { ...message, content: `${content}\n\n${text}` };
	if (Array.isArray(content)) {
		return { ...message, content: [...content, { type: "text", text }] };
	}
	return message;
}

/**
 * Adds the tag sentence to a bound child's context, once, on the last user message —
 * the message the child reads as its task. Returns the input untouched when the session
 * is not a bound child, there is nothing to attach to, or the sentence is already there.
 *
 * `reduced` is resolved by the caller from `isBoundChild(ctx)` and passed in, so this
 * module never consults the binding itself: one answer per pass, from one place.
 */
export function ensureChildTagSentence<
	M extends { role?: unknown; content?: unknown },
>(
	result: { messages: M[] } | undefined,
	reduced: boolean,
): { messages: M[] } | undefined {
	if (!result || !Array.isArray(result.messages)) return result;
	if (!reduced) return result;
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
