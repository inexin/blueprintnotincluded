// Generate the pre-scaled flat-icon tiers the preview render worker reads.
//
//   npm run icon-variants            # write assets/ui_image_preview/<tier>/
//   npm run icon-variants:dry-run    # report what would change
//
// Run automatically at the end of `npm run import:2024`, and in the deploy
// image build (see deploy.Dockerfile) — the output is a build derivative, not
// a committed asset, so it is gitignored and regenerated wherever it is
// needed. Rationale for the tiers themselves is in render-memory.ts.
//
// Idempotent: a tier file is written only when it is missing or older than the
// icon it comes from, and tiers for icons the export no longer has are pruned.
// Re-running after an import that changed nothing is a no-op.
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { ICON_VARIANT_TIERS, ICON_VARIANT_DIRNAME } from '../services/render-memory';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Where the native icons live. Same two candidates (and same order) as the
 * render worker's resolveAssetBaseDir: the built frontend in the deploy image,
 * the frontend source in a checkout. The backend `assets/` root has no
 * `ui_image/` of its own.
 */
function resolveIconSourceDir(): string {
  const candidates = [
    path.join(REPO_ROOT, 'app/public/assets/ui_image'),
    path.join(REPO_ROOT, 'frontend/src/assets/ui_image'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `generate-icon-variants: no ui_image directory found (looked in ${candidates.join(', ')})`
  );
}

/** PNG dimensions straight from the IHDR, so nothing is decoded to measure it. */
function pngSize(file: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(24);
    fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);
    if (header.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch {
    return null;
  }
}

interface TierStats {
  tier: number;
  written: number;
  skippedFresh: number;
  skippedSmaller: number;
  pruned: number;
  bytes: number;
}

async function generateTier(
  sourceDir: string,
  outRoot: string,
  tier: number,
  icons: string[],
  dryRun: boolean
): Promise<TierStats> {
  const outDir = path.join(outRoot, String(tier));
  const stats: TierStats = {
    tier,
    written: 0,
    skippedFresh: 0,
    skippedSmaller: 0,
    pruned: 0,
    bytes: 0,
  };
  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  // Icons this tier should hold: only the ones it actually shrinks. An icon
  // already smaller than the tier is left out entirely and the worker falls
  // back to the native file, which has the same pixels for less disk.
  const wanted = new Set<string>();

  for (const icon of icons) {
    const src = path.join(sourceDir, icon);
    const size = pngSize(src);
    if (size == null) continue;
    if (Math.max(size.width, size.height) <= tier) {
      stats.skippedSmaller++;
      continue;
    }
    wanted.add(icon);

    const dest = path.join(outDir, icon);
    try {
      if (fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) {
        stats.skippedFresh++;
        stats.bytes += fs.statSync(dest).size;
        continue;
      }
    } catch {
      // Missing destination — fall through and write it.
    }

    if (dryRun) {
      stats.written++;
      continue;
    }
    const buffer = await sharp(src)
      .resize({ width: tier, height: tier, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(dest, buffer);
    stats.written++;
    stats.bytes += buffer.length;
  }

  // Prune: icons the export dropped, and icons that no longer need this tier.
  if (fs.existsSync(outDir)) {
    for (const existing of fs.readdirSync(outDir)) {
      if (wanted.has(existing)) continue;
      stats.pruned++;
      if (!dryRun) fs.rmSync(path.join(outDir, existing), { force: true });
    }
  }

  return stats;
}

export async function generateIconVariants(opts?: { dryRun?: boolean }): Promise<void> {
  const dryRun = opts?.dryRun ?? false;
  const sourceDir = resolveIconSourceDir();
  const outRoot = path.join(REPO_ROOT, 'assets', ICON_VARIANT_DIRNAME);
  const icons = fs.readdirSync(sourceDir).filter(f => f.toLowerCase().endsWith('.png'));

  console.log(`\nicon variants${dryRun ? ' (dry run)' : ''}`);
  console.log(`  source : ${sourceDir} (${icons.length} icons)`);
  console.log(`  output : ${outRoot}`);

  let totalBytes = 0;
  for (const tier of ICON_VARIANT_TIERS) {
    const stats = await generateTier(sourceDir, outRoot, tier, icons, dryRun);
    totalBytes += stats.bytes;
    console.log(
      `  tier ${String(stats.tier).padStart(4)}: ${String(stats.written).padStart(5)} written, ` +
        `${String(stats.skippedFresh).padStart(5)} fresh, ` +
        `${String(stats.skippedSmaller).padStart(5)} already smaller, ` +
        `${String(stats.pruned).padStart(4)} pruned` +
        (dryRun ? '' : `, ${(stats.bytes / (1024 * 1024)).toFixed(1)}MB`)
    );
  }
  if (!dryRun) console.log(`  total on disk: ${(totalBytes / (1024 * 1024)).toFixed(1)}MB`);
}

if (require.main === module) {
  generateIconVariants({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('generate-icon-variants failed:', err);
      process.exit(1);
    });
}
