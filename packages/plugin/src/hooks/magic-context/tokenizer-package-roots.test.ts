import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizerPackageRoots } from "./read-session-formatting";

// A compiled host binary (bun build --compile, e.g. the Nix pi) resolves
// createRequire(import.meta.url) against its virtual /$bunfs module base, so the
// plugin falls back to walking the filesystem for ai-tokenizer. That walk must
// include the plugin's own install directory: a git install hoists the dependency
// to the checkout root above the plugin, and neither cwd nor the OpenCode cache
// contains it.
describe("tokenizerPackageRoots — plugin-local dependency search", () => {
    it("searches the module directory and every ancestor above it", () => {
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const argvEntry = process.argv[1];
        // bun test points argv[1] at this file, whose ancestors are the same paths
        // the module walk must produce — an unrelated entry point keeps the two apart.
        process.argv[1] = join(tmpdir(), "magic-context-host-probe", "host.js");
        try {
            const roots = tokenizerPackageRoots();

            expect(roots).toContain(join(moduleDir, "node_modules", "ai-tokenizer"));
            expect(roots).toContain(join(dirname(moduleDir), "node_modules", "ai-tokenizer"));
        } finally {
            process.argv[1] = argvEntry;
        }
    });
});
