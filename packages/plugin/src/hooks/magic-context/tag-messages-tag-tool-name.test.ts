/**
 * Which name a tool part is filed under (`zeroqn/pi` `.scratch/one-tool-surface/` ticket 03).
 *
 * `tagToolName` exists because a part's transcript name is not always the interesting one: a code-mode
 * cell that ran a `ctx_reduce` inside itself is a `python` result whose content *is* a reduction, and the
 * reduce-specific housekeeping (tail hygiene, reclaim protection, the tool tier) keys on the tag's name.
 * The part's own `tool` is left alone for the formatter and the historian.
 */
import { describe, expect, it } from "bun:test";

import { extractToolTagMetadata } from "./tag-messages";

describe("extractToolTagMetadata", () => {
    it("prefers an explicit filing name over the transcript's word for the part", () => {
        expect(
            extractToolTagMetadata({ type: "tool", tool: "python", tagToolName: "ctx_reduce" })
                .toolName,
        ).toBe("ctx_reduce");
    });

    it("falls back through the transcript's own names", () => {
        expect(extractToolTagMetadata({ type: "tool", tool: "read" }).toolName).toBe("read");
        expect(extractToolTagMetadata({ type: "tool", toolName: "read" }).toolName).toBe("read");
        expect(extractToolTagMetadata({ type: "tool", name: "read" }).toolName).toBe("read");
        expect(extractToolTagMetadata({ type: "tool" }).toolName).toBeNull();
        // A non-string filing name is not an override.
        expect(
            extractToolTagMetadata({ type: "tool", tool: "read", tagToolName: 7 }).toolName,
        ).toBe("read");
    });

    it("keeps the input accounting unchanged by the filing name", () => {
        const withOverride = extractToolTagMetadata({
            type: "tool",
            tool: "python",
            tagToolName: "ctx_reduce",
            args: { code: "x" },
        });
        const without = extractToolTagMetadata({
            type: "tool",
            tool: "python",
            args: { code: "x" },
        });
        expect(withOverride.inputByteSize).toBe(without.inputByteSize);
        expect(withOverride.inputTokenCount).toBe(without.inputTokenCount);
    });
});
