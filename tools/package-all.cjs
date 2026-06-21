#!/usr/bin/env node

const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APPS = ['client', 'screen-share', 'viewer', 'server-gui'];
const PACKAGE_STEPS = {
  mac: 'package:mac',
  win: 'package:win',
};
const INSTALLER_RELEASE_DIR = 'installers';
const LEGACY_PLATFORM_RELEASE_DIRS = ['macOS', 'Windows'];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function emptyDir(dir) {
  await removeDir(dir);
  await ensureDir(dir);
}

async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

function isPrimaryInstallerFile(platform, fileName) {
  if (platform === 'mac') return fileName.endsWith('.dmg');
  if (platform === 'win') return /Setup .*\.exe$/.test(fileName);
  return false;
}

async function copyInstallerArtifacts(srcDir, destDir, platform) {
  await ensureDir(destDir);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  const primaryInstallers = entries
    .filter((entry) => entry.isFile() && isPrimaryInstallerFile(platform, entry.name))
    .map((entry) => entry.name);

  const allowedArtifacts = new Set(primaryInstallers);
  for (const installer of primaryInstallers) {
    allowedArtifacts.add(`${installer}.blockmap`);
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!allowedArtifacts.has(entry.name)) continue;
    const destName = await uniqueDestName(destDir, entry.name);
    await fs.copyFile(path.join(srcDir, entry.name), path.join(destDir, destName));
  }
}

async function collectForPlatform(platform) {
  const targetRoot = path.join(ROOT, 'release', INSTALLER_RELEASE_DIR);
  await ensureDir(targetRoot);

  const copied = [];
  for (const app of APPS) {
    const src = path.join(ROOT, app, 'release');
    const exists = await fs
      .stat(src)
      .then((stat) => stat.isDirectory())
      .catch(() => false);

    if (!exists) {
      console.warn(`[skip] ${app}: missing ${src}`);
      continue;
    }

    await copyInstallerArtifacts(src, targetRoot, platform);
    copied.push(`${app} -> release/${INSTALLER_RELEASE_DIR}`);
  }

  console.log(`[done] ${platform}: ${copied.length} app installers copied`);
  for (const entry of copied) console.log(`  ${entry}`);
}

async function uniqueDestName(destDir, fileName) {
  const dest = path.join(destDir, fileName);
  const exists = await fs
    .stat(dest)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!exists) return fileName;

  const parsed = path.parse(fileName);
  let index = 2;
  while (true) {
    const candidate = `${parsed.name}-${index}${parsed.ext}`;
    const candidatePath = path.join(destDir, candidate);
    const candidateExists = await fs
      .stat(candidatePath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!candidateExists) return candidate;
    index += 1;
  }
}

function runPackageStep(app, script) {
  const appRelease = path.join(ROOT, app, 'release');
  // Clear stale artifacts so the copied folder contains only the current platform's outputs.
  fsSync.rmSync(appRelease, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

  const result = spawnSync('npm', ['run', script], {
    cwd: path.join(ROOT, app),
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`${app}: ${script} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const platforms = arg === 'all' ? ['mac', 'win'] : [arg];

  if (!platforms[0] || !PACKAGE_STEPS[platforms[0]]) {
    console.error('Usage: node tools/package-all.cjs <mac|win|all>');
    process.exit(2);
  }

  for (const dirName of LEGACY_PLATFORM_RELEASE_DIRS) {
    await removeDir(path.join(ROOT, 'release', dirName));
  }
  await emptyDir(path.join(ROOT, 'release', INSTALLER_RELEASE_DIR));

  for (const platform of platforms) {
    for (const app of APPS) {
      runPackageStep(app, PACKAGE_STEPS[platform]);
    }
    await collectForPlatform(platform);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
