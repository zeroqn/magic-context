import { afterEach, describe, expect, it } from "bun:test";
import {
    __resetMountTableReaderForTests,
    __setMountTableReaderForTests,
    detectWalUnsafeFilesystem,
    filesystemTypeFor,
    parseMountTable,
} from "./wal-filesystem";

afterEach(() => {
    __resetMountTableReaderForTests();
});

// Synthetic and deliberately non-existent, so no assertion depends on the
// machine running the tests and no real path resolution can rewrite the input
// out from under the lookup. The nested virtiofs mount over `/` is the shape
// that matters: the longest matching mount point wins, and the one that wins is
// the one actually holding the bytes.
const MOUNT_TABLE = [
    "/dev/sda1 / ext4 rw,relatime 0 0",
    "none /probe/store virtiofs rw,relatime 0 0",
    "tmpfs /probe/tmp tmpfs rw,nosuid 0 0",
    "server:/export /probe/share nfs4 rw,addr=10.0.0.1 0 0",
    "none /probe/with\\040space virtiofs rw 0 0",
].join("\n");

describe("wal-filesystem", () => {
    describe("#given a mount table", () => {
        it("#when parsed #then unescapes octal-encoded mount points", () => {
            expect(parseMountTable(MOUNT_TABLE)).toContainEqual({
                mountPoint: "/probe/with space",
                filesystemType: "virtiofs",
            });
        });

        it("#when a line is short #then it is skipped rather than throwing", () => {
            expect(parseMountTable("garbage\n\none two\n\n")).toEqual([]);
        });
    });

    describe("#given a path", () => {
        it("#when a nested mount contains it #then the longest mount point wins", () => {
            const mounts = parseMountTable(MOUNT_TABLE);
            expect(filesystemTypeFor("/probe/store/magic-context/context.db", mounts)).toBe(
                "virtiofs",
            );
            expect(filesystemTypeFor("/probe/notes.md", mounts)).toBe("ext4");
        });

        it("#when a mount point is only a string prefix #then it does not match", () => {
            const mounts = parseMountTable(MOUNT_TABLE);
            expect(filesystemTypeFor("/probe/storex/context.db", mounts)).toBe("ext4");
        });

        it("#when nothing contains it #then there is no answer", () => {
            expect(filesystemTypeFor("/elsewhere/context.db", [])).toBeNull();
        });
    });

    describe("#given the mount table reader", () => {
        it("#when the database is on virtiofs #then the filesystem is reported", () => {
            __setMountTableReaderForTests(() => MOUNT_TABLE);
            expect(detectWalUnsafeFilesystem("/probe/store/magic-context/context.db")).toBe(
                "virtiofs",
            );
        });

        it("#when the filesystem is one WAL has not been shown to fail on #then nothing is reported", () => {
            __setMountTableReaderForTests(() => MOUNT_TABLE);
            expect(detectWalUnsafeFilesystem("/probe/tmp/context.db")).toBeNull();
            expect(detectWalUnsafeFilesystem("/probe/notes.md")).toBeNull();
            expect(detectWalUnsafeFilesystem("/probe/share/context.db")).toBeNull();
        });

        it("#when the mount table cannot be read #then nothing is reported", () => {
            // An absent answer must never be read as an answer: an unreadable
            // mount table leaves WAL alone rather than switching modes on a guess.
            __setMountTableReaderForTests(() => null);
            expect(detectWalUnsafeFilesystem("/probe/store/magic-context/context.db")).toBeNull();
        });
    });
});
