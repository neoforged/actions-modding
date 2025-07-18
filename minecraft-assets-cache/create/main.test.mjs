import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guessCurrentMinecraftVersionFromFile } from "./main.mjs";

let tempDir;
beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assetstest"));
});
afterEach(async () => {
  await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5 });
});

describe("reading minecraft version from file", () => {
  test("is undefined if file is missing", async () => {
    expect(
      await guessCurrentMinecraftVersionFromFile("doesntexist", "/(.*)/"),
    ).toBeUndefined();
  });

  test("is undefined if nothing in the file matches the regexp", async () => {
    const p = path.join(tempDir, "gradle.properties");
    await fs.writeFile(p, "hello world", { encoding: "utf-8" });

    expect(
      await guessCurrentMinecraftVersionFromFile(
        p,
        "/minecraft_version=(\\w+)/",
      ),
    ).toBeUndefined();
  });

  test("returns the first match in the file", async () => {
    const p = path.join(tempDir, "gradle.properties");
    await fs.writeFile(
      p,
      "hello world\n#minecraft_version=1.10\nminecraft_version=1.21.1\n",
      { encoding: "utf-8" },
    );

    expect(
      await guessCurrentMinecraftVersionFromFile(
        p,
        "/^\\s*minecraft_version\\s*=\\s*(.+)\\s*$/m",
      ),
    ).toBe("1.21.1");
  });
});
