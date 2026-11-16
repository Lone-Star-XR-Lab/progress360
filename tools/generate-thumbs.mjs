#!/usr/bin/env node
// For every project folder under assets/ (or the folders given as arguments):
//   • <first-stage>-thumb.jpg — card / filmstrip thumbnail from the first stage image
//     (000-<slug>.jpg, or the oldest dated image such as 20260216_C210.jpg)
//   • <stage>-4k.jpg — a 4096 px wide copy of every stage image wider than that, which the
//     viewer loads on phones and GPUs that can't handle 8K textures (skip with --no-4k)
// Existing files are never overwritten.

import fs from 'fs/promises';
import path from 'path';
import url from 'url';
import { sortStageFiles } from '../stages.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const assetsRoot = path.join(repoRoot, 'assets');

const WIDTH = parseInt(process.env.THUMB_WIDTH || '1200', 10);
const QUALITY = parseInt(process.env.THUMB_QUALITY || '74', 10);
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry');
const SMALL_WIDTH = parseInt(process.env.SMALL_WIDTH || '4096', 10);
const SMALL_QUALITY = parseInt(process.env.SMALL_QUALITY || '82', 10);
const NO_4K = process.argv.includes('--no-4k');

let sharp;
try{
  sharp = (await import('sharp')).default;
}catch(err){
  console.error('[generate-thumbs] Missing dependency: sharp');
  console.error('  Install with: npm i -D sharp');
  process.exit(1);
}

async function listDirs(root){
  const out = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for(const de of entries){
    if(de.isDirectory()) out.push(path.join(root, de.name));
  }
  return out;
}

async function findBaseImage(dir){
  // Same ordering the viewer uses (stages.js); *-thumb.jpg files are excluded there
  const first = sortStageFiles(await fs.readdir(dir)).find(f=> /\.jpe?g$/i.test(f));
  return first ? path.join(dir, first) : null;
}

// 000-kitchen.jpg → 000-kitchen-thumb.jpg, 20260216_C210.jpg → 20260216_C210-thumb.jpg
function computeThumbName(basePath){
  return basePath.replace(/\.jpe?g$/i, '-thumb.jpg');
}

async function ensureThumbFor(dir){
  const base = await findBaseImage(dir);
  if(!base) return { dir, skipped: true, reason: 'no jpg' };
  const out = computeThumbName(base);
  // Skip if already exists
  try{ await fs.access(out); return { dir, skipped: true, reason: 'exists' }; }
  catch{}
  if(DRY){ return { dir, created: false, dry: true, out }; }
  // Process with sharp
  await sharp(base)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
    .toFile(out);
  return { dir, created: true, out };
}

async function ensureSmallCopies(dir){
  const made = [];
  if(NO_4K) return made;
  const stages = sortStageFiles(await fs.readdir(dir)).filter(f=> /\.jpe?g$/i.test(f));
  for(const name of stages){
    const src = path.join(dir, name);
    const out = src.replace(/\.jpe?g$/i, '-4k.jpg');
    try{ await fs.access(out); continue; } catch{}
    const { width } = await sharp(src).metadata();
    if(!width || width <= SMALL_WIDTH) continue;
    if(!DRY){
      await sharp(src)
        .resize({ width: SMALL_WIDTH })
        .jpeg({ quality: SMALL_QUALITY, progressive: true, mozjpeg: true })
        .toFile(out);
    }
    made.push(out);
  }
  return made;
}

async function main(){
  const args = process.argv.slice(2).filter(a=> !a.startsWith('--'));
  const dirs = args.length ? args.map(d=> path.resolve(d)) : await listDirs(assetsRoot);
  let created = 0, skipped = 0, small = 0;
  for(const d of dirs){
    try{
      const st = await fs.stat(d);
      if(!st.isDirectory()) continue;
      const res = await ensureThumbFor(d);
      if(res?.created){
        created++;
        console.log('Created:', path.relative(repoRoot, res.out));
      } else {
        skipped++;
        const reason = res?.reason || (res?.dry ? 'dry-run' : 'unknown');
        console.log('Skip:', path.relative(repoRoot, d), `(${reason})`);
      }
      for(const out of await ensureSmallCopies(d)){
        small++;
        console.log(DRY ? 'Would create:' : 'Created:', path.relative(repoRoot, out));
      }
    }catch(err){
      console.warn('Error:', d, err?.message || err);
    }
  }
  console.log(`Done. Created ${created} thumbnails and ${small} 4K copies, skipped ${skipped}.`);
}

main().catch(err=>{ console.error(err); process.exit(1); });

