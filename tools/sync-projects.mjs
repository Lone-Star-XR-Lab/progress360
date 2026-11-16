#!/usr/bin/env node
// Sync assets/projects.json with what's actually in assets/<folder>/.
//
//   node tools/sync-projects.mjs          update projects.json
//   node tools/sync-projects.mjs --dry    show what would change, write nothing
//
// What it does:
//   • For every project whose folder contains files the browser can't guess on a static host
//     (dated names like 20261115_e251.jpg, or anything not named NNN-<slug>.jpg/.mp4), it writes a
//     `stages` list in viewing order and marks it "autoStages": true.
//   • Lists marked autoStages are regenerated on every run. Hand-written `stages` lists (no
//     autoStages flag) are never touched.
//   • Folders under assets/ with media but no project entry get a new entry (edit its title,
//     meta and campus afterwards).
//   • meta.updated is moved forward to the newest dated stage, if that's later.
//
// Naming rules live in stages.js (shared with the browser).

import fs from 'fs/promises';
import path from 'path';
import url from 'url';
import { sortStageFiles, parseStageName } from '../stages.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const assetsRoot = path.join(repoRoot, 'assets');
const manifestPath = path.join(assetsRoot, 'projects.json');
const DRY = process.argv.includes('--dry');

const toSlug = (s)=> String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const toTitle = (s)=> String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c)=> c.toUpperCase());
const norm = (f)=> String(f || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function slugOf(p){
  if(p.slug) return String(p.slug).toLowerCase();
  if(p.id) return toSlug(p.id);
  return toSlug(String(p.folder || '').split('/').pop());
}

// Could the browser find this file by probing NNN-<slug>.jpg / .mp4?
function probeable(name, slug){
  const m = /^(\d{3})-(.+)\.(jpg|mp4)$/i.exec(name);
  return !!m && m[2].toLowerCase() === slug && (+m[1] < 40 || +m[1] === 999);
}

async function main(){
  const raw = await fs.readFile(manifestPath, 'utf8');
  const json = JSON.parse(raw);
  const projects = Array.isArray(json) ? json : (json.projects ||= []);
  const changes = [];

  const dirs = (await fs.readdir(assetsRoot, { withFileTypes: true }))
    .filter((d)=> d.isDirectory() && !d.name.startsWith('.'))
    .map((d)=> d.name);

  for(const dir of dirs){
    const folder = `assets/${dir}`;
    const files = await fs.readdir(path.join(assetsRoot, dir));
    const ordered = sortStageFiles(files);
    if(!ordered.length) continue;

    let p = projects.find((x)=> norm(x.folder) === norm(folder));
    if(!p){
      const id = toSlug(dir);
      p = {
        id: projects.some((x)=> x.id === id) ? `${id}-${projects.length}` : id,
        title: toTitle(dir),
        folder,
        slug: id,
        meta: { location: '', phase: '', updated: '', description: '' },
        campus: { campus: '', building: '', room: '' },
        tags: [],
      };
      projects.push(p);
      changes.push(`+ new project "${p.id}" for ${folder} (edit its title/meta in projects.json)`);
    }

    const slug = slugOf(p);
    const handWritten = Array.isArray(p.stages) && p.stages.length && !p.autoStages;
    if(handWritten){
      changes.push(`  ${p.id}: has a hand-written stages list, left as-is`);
    } else if(ordered.every((f)=> probeable(f, slug))){
      if(p.autoStages){
        delete p.stages; delete p.autoStages;
        changes.push(`~ ${p.id}: all files are NNN-${slug}.*, removed generated stages (auto-discovery handles it)`);
      }
    } else {
      const next = ordered.map((f)=> ({ url: f }));
      const before = JSON.stringify(p.stages || null);
      p.stages = next;
      p.autoStages = true;
      if(before !== JSON.stringify(next)) changes.push(`~ ${p.id}: stages → ${ordered.join(', ')}`);
    }

    const newest = ordered.map((f)=> parseStageName(f)).filter((i)=> i?.kind === 'dated').map((i)=> i.date).sort().pop();
    p.meta ||= {};
    if(newest && (!p.meta.updated || newest > p.meta.updated)){
      changes.push(`~ ${p.id}: meta.updated ${p.meta.updated || '(empty)'} → ${newest}`);
      p.meta.updated = newest;
    }
  }

  for(const p of projects){
    if(!dirs.some((d)=> norm(`assets/${d}`) === norm(p.folder))) changes.push(`! ${p.id}: folder ${p.folder} not found`);
  }

  const real = changes.filter((c)=> !c.startsWith('  '));
  console.log(changes.length ? changes.join('\n') : 'Nothing to change.');
  if(!real.some((c)=> c[0] === '+' || c[0] === '~')){ return; }
  if(DRY){ console.log('\n(dry run, nothing written)'); return; }
  await fs.writeFile(manifestPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`\nUpdated ${path.relative(repoRoot, manifestPath)}`);
}

main().catch((err)=>{ console.error(err); process.exit(1); });
