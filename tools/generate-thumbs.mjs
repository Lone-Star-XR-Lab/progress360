#!/usr/bin/env node
// Generate small JPEG thumbnails for project folders under assets/
// Looks for 000-<slug>.jpg and writes 000-<slug>-thumb.jpg if missing.

import fs from 'fs/promises';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const assetsRoot = path.join(repoRoot, 'assets');

const WIDTH = parseInt(process.env.THUMB_WIDTH || '1200', 10);
const QUALITY = parseInt(process.env.THUMB_QUALITY || '74', 10);
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry');

let sharp;
try{
  sharp = (await import('sharp')).default;
}catch(err){
  console.error('[generate-thumbs] Missing dependency: sharp');
  console.error('  Install with: npm i -D sharp');
  process.exit(1);
}

function isDirEntProjectFolder(de){
  return de.isDirectory() && !de.name.startsWith('.') && de.name !== 'deck' ? true : de.isDirectory();
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
  const files = await fs.readdir(dir);
  // Prefer 000-*.jpg
  const primary = files.find(f=> /^000-.*\.jpg$/i.test(f));
  if(primary) return path.join(dir, primary);
  // fallback: any jpg
  const any = files.find(f=> /\.jpg$/i.test(f));
  if(any) return path.join(dir, any);
  return null;
}

function computeThumbName(basePath){
  const bn = path.basename(basePath);
  const m = bn.match(/^000-([^.]+)\.jpg$/i);
  const slug = m ? m[1] : bn.replace(/\.jpg$/i, '').replace(/^000-/, '');
  return path.join(path.dirname(basePath), `000-${slug}-thumb.jpg`);
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

async function main(){
  const args = process.argv.slice(2).filter(a=> !a.startsWith('--'));
  const dirs = args.length ? args.map(d=> path.resolve(d)) : await listDirs(assetsRoot);
  let created = 0, skipped = 0;
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
    }catch(err){
      console.warn('Error:', d, err?.message || err);
    }
  }
  console.log(`Done. Created ${created}, skipped ${skipped}.`);
}

main().catch(err=>{ console.error(err); process.exit(1); });

