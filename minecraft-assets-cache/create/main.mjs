import * as core from "@actions/core";
import * as cache from "@actions/cache";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";

const maxConcurrency = 20;
const maxDownloadRetries = 5;

export async function run() {
  const cacheKeyPrefix = core.getInput("cache-key") + "-";
  let minecraftVersions = core.getMultilineInput("minecraft-versions");
  core.info(`Configured Minecraft versions: ${minecraftVersions}`);

  // Check if we should try to grab a Minecraft version from a local file
  const minecraftVersionFile = core.getInput("minecraft-version-file");
  const minecraftVersionRegexp = core.getInput("minecraft-version-regexp");
  if (minecraftVersionFile && minecraftVersionRegexp) {
    const currentMinecraftVersion = await guessCurrentMinecraftVersionFromFile(
      minecraftVersionFile,
      minecraftVersionRegexp,
    );
    core.info(
      `Detected Minecraft version from ${minecraftVersionFile}: ${currentMinecraftVersion}`,
    );
    if (currentMinecraftVersion) {
      minecraftVersions.push(currentMinecraftVersion);
    }
  }

  const cacheKey = cacheKeyPrefix + hashMinecraftVersions(minecraftVersions);

  if (!cache.isFeatureAvailable()) {
    core.error("Caching is not available");
    return;
  }

  const restoredCacheKey = await cache.restoreCache(["assets"], cacheKey, [
    cacheKeyPrefix,
  ]);
  if (restoredCacheKey === cacheKey) {
    core.info(
      `Cache ${restoredCacheKey} already exists and matches Minecraft versions. Nothing to do.`,
    );
    return;
  }

  await downloadAssets(minecraftVersions, "assets");

  await cache.saveCache(["assets"], cacheKey);
}

/**
 * Creates or updates an assets folder like the Minecraft Launcher would create
 * for the given Minecraft versions.
 * @param {string[]} minecraftVersions
 * @param {string} assetsFolder
 * @returns {Promise<void>}
 */
export async function downloadAssets(minecraftVersions, assetsFolder) {
  core.info(
    `Downloading assets for Minecraft versions ${minecraftVersions.join(", ")}`,
  );

  const assetIndices = await getAssetIndices(minecraftVersions);
  core.info(`Asset index ids found: ${Object.keys(assetIndices)}`);

  for (const assetIndex of Object.values(assetIndices)) {
    const assetIndexPath = path.join(
      assetsFolder,
      "indexes",
      assetIndex.id + ".json",
    );
    await downloadIfChanged(
      assetIndexPath,
      assetIndex.url,
      "sha1",
      assetIndex.sha1,
      assetIndex.size,
    );

    // Map from hash -> object to dedupe duplicate objects
    const objects = Object.values(
      Object.fromEntries(
        Object.values(
          JSON.parse(await readFile(assetIndexPath, { encoding: "utf-8" }))
            .objects,
        ).map((object) => [object.hash, object]),
      ),
    );
    // Download in chunks
    let downloadedFiles = 0;
    core.info(
      `Updating ${objects.length} objects for asset index ${assetIndex.id}`,
    );
    for (let i = 0; i < objects.length; i += maxConcurrency) {
      const objectChunk = objects.slice(i, i + maxConcurrency);
      const downloadResult = await Promise.all(
        objectChunk.map(({ hash, size }) => {
          const hashPrefix = hash.substring(0, 2);
          const url = `https://resources.download.minecraft.net/${hashPrefix}/${hash}`;
          const objectPath = path.join(
            assetsFolder,
            "objects",
            hashPrefix,
            hash,
          );
          return downloadIfChanged(objectPath, url, "sha1", hash, size);
        }),
      );
      for (let downloaded of downloadResult) {
        if (downloaded) downloadedFiles++;
      }
    }
    core.info(
      `Downloaded ${downloadedFiles}, reused ${objects.length - downloadedFiles}`,
    );
  }

  // Print total size of assets folder
  core.info(
    `Overall assets size: ${formatSize(await getFolderSize(assetsFolder))}`,
  );
}

/**
 * Calculate the overall size of a folder in bytes.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function getFolderSize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getFolderSize(fullPath);
    } else if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      total += fileStat.size;
    }
  }
  return total;
}

/**
 * Create an MD5 hash over the given list of Minecraft versions.
 *
 * @param {string[]} minecraftVersions
 * @returns {string}
 */
function hashMinecraftVersions(minecraftVersions) {
  const hash = createHash("md5");
  hash.update(minecraftVersions.join("\n"));
  return hash.digest("hex");
}

/**
 * Calculates a checksum of the given file using the given hash algorithm.
 *
 * @param {string} path Path to the file to hash.
 * @param {string} method The NodeJS hashing method to use.
 * @returns {Promise<string>}
 */
async function calculateChecksum(path, method) {
  const hash = createHash(method);
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Downloads a file to a local path, but only if its missing or the content doesn't match the expected checksum and size.
 *
 * The download will be retried if it fails.
 *
 * @param {string} localPath The local path to the file.
 * @param {string} url The URL to download the file from if missing or corrupted.
 * @param {string} checksumMethod The checksum method for {@code checksum}.
 * @param {string} checksum The expected checksum of the file.
 * @param {number} size The expected size of the file in byte.
 * @returns {Promise<boolean>} True if the file was downloaded, false if it was already present.
 */
export async function downloadIfChanged(
  localPath,
  url,
  checksumMethod,
  checksum,
  size,
) {
  let stats;
  try {
    stats = await stat(localPath);
  } catch (e) {
    if (e?.code === "ENOENT") {
      stats = undefined;
    } else {
      throw e;
    }
  }
  if (stats && stats.size === size) {
    const localChecksum = await calculateChecksum(localPath, checksumMethod);
    if (localChecksum === checksum) return false;
  }

  let retries = 0;
  let lastError;
  let buffer;
  while (retries++ < maxDownloadRetries) {
    const res = await fetch(url);
    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      if (buffer.length !== size) {
        lastError = "Size of downloaded file didn't match expected size";
      } else {
        const hash = createHash(checksumMethod).update(buffer).digest("hex");
        if (hash !== checksum) {
          lastError = "Checksum mismatch for downloaded file";
        } else {
          lastError = undefined;
          break;
        }
      }
    } else {
      lastError = "HTTP Error " + res.status;
    }
    await sleep(2000);
  }
  if (lastError) {
    throw new Error(`Failed to download ${url}: ${lastError}`);
  }

  const parentDir = path.dirname(localPath);
  await mkdir(parentDir, { recursive: true });
  await writeFile(localPath, buffer);
  return true;
}

export async function getAssetIndices(minecraftVersions) {
  const indexManifest = await downloadJson(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );

  const assetIndices = {};
  for (const version of minecraftVersions) {
    const versionMetaUrl = indexManifest.versions.find(
      (v) => v.id === version,
    )?.url;
    if (!versionMetaUrl) {
      throw new Error(`Minecraft version ${version} not found`);
    }

    // Fetch the version-specific meta
    const { assetIndex } = await downloadJson(versionMetaUrl);
    assetIndices[assetIndex.id] = assetIndex;
  }
  return assetIndices;
}

export async function downloadJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to JSON file ${url}: ` + response.status);
  }

  try {
    return await response.json();
  } catch (e) {
    throw new Error(`Response from ${url} was not valid JSON: ${e}`);
  }
}

export async function sleep(milliseconds) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, milliseconds);
  return promise;
}

function formatSize(size) {
  if (size < 1024) {
    return size + " byte";
  } else if (size < 1024 * 1024) {
    return (size / 1024).toFixed(2) + " kb";
  } else {
    return (size / 1024 / 1024).toFixed(2) + " mb";
  }
}

/**
 * Tries to match the given regular expression against the content of the given file and returns the first match.
 * @param {string} minecraftVersionFile
 * @param {string} minecraftVersionRegexp
 * @returns {Promise<string|undefined>}
 */
export async function guessCurrentMinecraftVersionFromFile(
  minecraftVersionFile,
  minecraftVersionRegexp,
) {
  /** @type {string} */
  let fileContent;
  try {
    fileContent = await readFile(minecraftVersionFile, { encoding: "utf8" });
  } catch (e) {
    if (e.code === "ENOENT") {
      return undefined;
    }
    throw e;
  }

  const patternMatch = minecraftVersionRegexp.match(/\/(.*)\/([a-z]*)/);
  if (!patternMatch) {
    throw new Error(
      "minecraft-version-regexp doesnt match format /regexp/flags",
    );
  }
  const [, pattern, flags] = patternMatch;

  const matches = new RegExp(pattern, flags).exec(fileContent);
  if (!matches) {
    return undefined;
  }
  return matches[1];
}
