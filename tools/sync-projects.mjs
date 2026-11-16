#!/usr/bin/env node
// Sync assets/projects.json with what's actually in assets/<folder>/, then validate it.
//
//   node tools/sync-projects.mjs          update projects.json
//   node tools/sync-projects.mjs --dry    show what would change, write nothing
//   node tools/sync-projects.mjs --check  CI mode: write nothing; exit 1 if projects.json is out
//                                         of date or has errors (warnings never fail)
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
//   • Then it validates every entry.
//       Errors:   duplicate ids, missing folders, stage files that don't exist, `align` keys or
//                 hotspot `stage`s that match no stage file, hotspot links to unknown project
//                 ids, malformed `view` / `align` / `hotspots` / `meta.gps`.
//       Warnings: empty title/phase/description/updated, dates not in YYYY-MM-DD, descriptions
//                 copied between projects, no -thumb.jpg.
//   • Editor fields (`view`, `align`, `hotspots`) and anything else you add are kept as-is.
//
// Naming rules live in stages.js (shared with the browser).

import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import url from 'url';
import { sortStageFiles, parseStageName } from '../stages.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const assetsRoot = path.join(repoRoot, 'assets');
const manifestPath = path.join(assetsRoot, 'projects.json');
const CHECK = process.argv.includes('--check');
const DRY = CHECK || process.argv.includes('--dry');

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
  let json;
  try { json = JSON.parse(raw); }
  catch(err){ console.error(`✖ assets/projects.json is not valid JSON: ${err.message}`); process.exit(1); }
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

  const real = changes.filter((c)=> !c.startsWith('  '));
  const needsWrite = real.some((c)=> c[0] === '+' || c[0] === '~');
  console.log(changes.length ? changes.join('\n') : 'Nothing to change.');

  const { errors, warnings } = validate(projects, dirs);
  if(warnings.length) console.log(`\nWarnings (${warnings.length}):\n` + warnings.map((w)=> `  ⚠ ${w}`).join('\n'));
  if(errors.length) console.log(`\nErrors (${errors.length}):\n` + errors.map((e)=> `  ✖ ${e}`).join('\n'));

  if(CHECK){
    if(needsWrite) console.log('\nprojects.json is out of date: run `npm run sync` and commit the result.');
    if(needsWrite || errors.length) process.exitCode = 1;
    else console.log('\nprojects.json is up to date' + (warnings.length ? ' (see warnings above).' : '.'));
    return;
  }
  if(!needsWrite) return;
  if(DRY){ console.log('\n(dry run, nothing written)'); return; }
  await fs.writeFile(manifestPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`\nUpdated ${path.relative(repoRoot, manifestPath)}`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRemote = (u)=> /^(https?:)?\/\//i.test(u);
const decode = (s)=> { try { return decodeURIComponent(s); } catch { return s; } };
const fileName = (u)=> decode(String(u).split(/[?#]/)[0].split('/').pop());
const listDir = (dir)=> { try { return readdirSync(dir); } catch { return []; } };

// Stage URLs are relative to the project folder unless they start with "/" (site root).
function localPath(p, u){
  const clean = decode(String(u).split(/[?#]/)[0]);
  return path.join(repoRoot, clean.startsWith('/') ? clean.slice(1) : `${p.folder}/${clean}`);
}

function validate(projects, dirs){
  const errors = [], warnings = [];
  const ids = new Map();
  const descriptions = new Map();

  for(const p of projects){
    if(!p.id) errors.push(`${p.title || '(untitled)'}: missing "id"`);
    else if(ids.has(p.id)) errors.push(`${p.id}: duplicate id (also used by "${ids.get(p.id)}")`);
    else ids.set(p.id, p.title || p.id);
  }

  for(const p of projects){
    const name = p.id || p.title || '(no id)';
    const meta = p.meta || {};

    if(!String(p.title || '').trim()) warnings.push(`${name}: title is empty`);
    if(!String(meta.phase || '').trim()) warnings.push(`${name}: meta.phase is empty`);
    if(!String(meta.description || '').trim()) warnings.push(`${name}: meta.description is empty`);
    if(!meta.updated) warnings.push(`${name}: meta.updated is empty`);
    else if(!DATE_RE.test(meta.updated)) warnings.push(`${name}: meta.updated "${meta.updated}" should be YYYY-MM-DD`);
    const desc = String(meta.description || '').trim().toLowerCase();
    if(desc){
      if(descriptions.has(desc)) warnings.push(`${name}: same description as "${descriptions.get(desc)}" (copied?)`);
      else descriptions.set(desc, name);
    }
    if(meta.gps != null && meta.gps !== false){
      const g = Array.isArray(meta.gps) ? { lat: meta.gps[0], lon: meta.gps[1] } : { lat: meta.gps.lat, lon: meta.gps.lon ?? meta.gps.lng };
      const ok = g.lat != null && g.lon != null && Math.abs(+g.lat) <= 90 && Math.abs(+g.lon) <= 180;
      if(!ok) errors.push(`${name}: meta.gps should be [lat, lon] or {"lat": …, "lon": …}`);
    }

    if(!p.folder){ errors.push(`${name}: missing "folder"`); continue; }
    if(!dirs.some((d)=> norm(`assets/${d}`) === norm(p.folder))){ errors.push(`${name}: folder ${p.folder} not found`); continue; }

    // Stage files in viewing order, as the site will see them
    let stageFiles;
    if(Array.isArray(p.stages) && p.stages.length){
      stageFiles = [];
      p.stages.forEach((s, i)=>{
        if(!s?.url){ errors.push(`${name}: stages[${i}] has no "url"`); return; }
        stageFiles.push(fileName(s.url));
        if(!isRemote(s.url) && !existsSync(localPath(p, s.url))) errors.push(`${name}: stage file ${s.url} not found in ${p.folder}`);
      });
    } else {
      stageFiles = sortStageFiles(listDir(path.join(repoRoot, p.folder)));
      if(!stageFiles.length) errors.push(`${name}: no stage images or videos in ${p.folder}`);
    }
    const stageSet = new Set(stageFiles);

    // Thumbnail: the gallery wants a small -thumb.jpg, otherwise it downloads the whole panorama
    if(p.thumb && !isRemote(p.thumb) && !existsSync(path.join(repoRoot, p.thumb))) errors.push(`${name}: thumb ${p.thumb} not found`);
    const thumbCandidates = [
      `${p.folder}/000-${slugOf(p)}-thumb.jpg`,
      ...stageFiles.slice(0, 1).map((f)=> `${p.folder}/${f.replace(/(\.[^.]+)$/, '-thumb.jpg')}`),
      ...(p.thumb && /-thumb\.jpe?g$/i.test(p.thumb) ? [p.thumb] : []),
    ];
    if(!thumbCandidates.some((t)=> existsSync(path.join(repoRoot, t)))){
      warnings.push(`${name}: no -thumb.jpg (run tools/generate-thumbs); the gallery will load the full panorama`);
    }

    // Editor fields (see docs/viewer.md → Editor)
    if(p.view != null){
      const v = p.view;
      const ok = typeof v === 'object' && !Array.isArray(v)
        && ['yaw', 'pitch', 'fov'].every((k)=> v[k] == null || Number.isFinite(+v[k]));
      if(!ok) errors.push(`${name}: "view" should be {"yaw": degrees, "pitch": degrees, "fov": degrees}`);
    }
    if(p.align != null){
      if(typeof p.align !== 'object' || Array.isArray(p.align)) errors.push(`${name}: "align" should be {"<stage file>": degrees, …}`);
      else for(const [k, v] of Object.entries(p.align)){
        if(!stageSet.has(k)) errors.push(`${name}: align key "${k}" matches no stage file`);
        if(!Number.isFinite(+v)) errors.push(`${name}: align["${k}"] should be a number of degrees`);
      }
    }
    if(p.hotspots != null){
      if(!Array.isArray(p.hotspots)) errors.push(`${name}: "hotspots" should be a list`);
      else p.hotspots.forEach((h, i)=>{
        const label = `${name}: hotspots[${i}]${h?.title ? ` "${h.title}"` : ''}`;
        if(!h || !Number.isFinite(+h.yaw)) errors.push(`${label} needs a numeric "yaw"`);
        if(h?.pitch != null && !Number.isFinite(+h.pitch)) errors.push(`${label} "pitch" should be a number`);
        if(h?.link && !ids.has(h.link)) errors.push(`${label} links to unknown project "${h.link}"`);
        if(h?.link && h.link === p.id) warnings.push(`${label} links to its own project`);
        if(h?.stage && !stageSet.has(h.stage)) errors.push(`${label} stage "${h.stage}" matches no stage file`);
        if(h && !h.title && !h.text && !h.link) warnings.push(`${label} has no title, text or link`);
      });
    }
  }
  return { errors, warnings };
}

main().catch((err)=>{ console.error(err); process.exit(1); });
