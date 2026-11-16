// Stage file naming rules, shared by the browser (main.js) and tools/sync-projects.mjs.
// No DOM APIs here so it can be imported by Node.
//
// Recognised names (case-insensitive, any folder):
//   000-slug.jpg … 998-slug.mp4    numbered stage   → "Start", "Stage 1", "Stage 2", …
//   20261115_anything.jpg          dated stage      → "Nov 15, 2026"
//   2026-11-15_anything.jpg        dated stage (dashes allowed)
//   IMG_20261115_143022.jpg        dated stage with a short prefix and optional HHMMSS time
//   999-slug.jpg                   always last      → "Current"
//   anything-else.jpg              kept, after dated stages, labelled from the file name
//   *-thumb.jpg, *-4k.jpg          ignored (card thumbnails / phone-sized copies)
//
// Order: numbered (by number) → dated (oldest first) → other (by name) → 999.

export const IMAGE_RE = /\.(jpe?g|png|webp|avif)$/i;
export const VIDEO_RE = /\.(mp4|webm|ogv|mov)$/i;
export const MEDIA_RE = /\.(jpe?g|png|webp|avif|mp4|webm|ogv|mov)$/i;

const NUMBERED_RE = /^(\d{3})-/;
const DATED_RE = /^(?:[a-z]{2,6}[_-])?(\d{4})-?(\d{2})-?(\d{2})(?:[_T-](\d{2})(\d{2})(\d{2}))?(?!\d)/i;

const baseName = (path)=> String(path).split(/[?#]/)[0].split('/').pop();
const stem = (name)=> name.replace(/\.[^.]+$/, '');

/** Classify a file name. Returns null for files that aren't stages. */
export function parseStageName(path){
  const name = baseName(path);
  if(!MEDIA_RE.test(name) || /-(thumb|4k)\.[a-z0-9]+$/i.test(name)) return null;
  let m = NUMBERED_RE.exec(name);
  if(m) return { kind: 'numbered', order: parseInt(m[1], 10), name };
  m = DATED_RE.exec(name);
  if(m){
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31){
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      const time = m[4] && +m[4] < 24 && +m[5] < 60 && +m[6] < 60 ? `${m[4]}:${m[5]}:${m[6]}` : null;
      return { kind: 'dated', date, time, name };
    }
  }
  return { kind: 'other', name };
}

function rank(info){
  if(info.kind === 'numbered') return info.order === 999 ? 3 : 0;
  return info.kind === 'dated' ? 1 : 2;
}

const byName = (a, b)=> a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Filter a folder's file names down to stages and sort them into viewing order.
 * When the same stem exists as both image and video (000-x.jpg + 000-x.mp4), the image wins.
 */
export function sortStageFiles(names){
  const byStem = new Map();
  for(const raw of names){
    const info = parseStageName(raw);
    if(!info) continue;
    const key = stem(info.name).toLowerCase();
    const prev = byStem.get(key);
    if(prev && !(IMAGE_RE.test(info.name) && !IMAGE_RE.test(prev.info.name))) continue;
    byStem.set(key, { raw, info });
  }
  return [...byStem.values()]
    .sort((a, b)=> rank(a.info) - rank(b.info)
      || (a.info.kind === 'numbered' ? a.info.order - b.info.order : 0)
      || (a.info.kind === 'dated' ? `${a.info.date}${a.info.time || ''}`.localeCompare(`${b.info.date}${b.info.time || ''}`) : 0)
      || byName(a.info, b.info))
    .map((x)=> x.raw);
}

/**
 * Give every stage a label (unless it already has one) and a `date` when the name contains one.
 * @param {{url:string,label?:string}[]} list  stages in viewing order
 * @returns {{url:string,label:string,date?:string,time?:string}[]}
 */
export function describeStages(list){
  const infos = list.map((s)=> parseStageName(s.url) || { kind: 'other', name: baseName(s.url) });
  const dateCounts = new Map();
  infos.forEach((i)=> { if(i.kind === 'dated') dateCounts.set(i.date, (dateCounts.get(i.date) || 0) + 1); });
  const dateSeen = new Map();
  let numbered = 0;
  return list.map((s, idx)=>{
    const info = infos[idx];
    let label = s.label;
    if(!label){
      if(info.kind === 'numbered'){
        label = info.order === 999 ? 'Current' : (numbered === 0 ? 'Start' : `Stage ${numbered}`);
      } else if(info.kind === 'dated'){
        label = formatStageDate(info.date);
        if(dateCounts.get(info.date) > 1){
          const n = (dateSeen.get(info.date) || 0) + 1;
          dateSeen.set(info.date, n);
          label += info.time ? ` · ${formatStageTime(info.time)}` : ` (${n})`;
        }
      } else {
        label = stem(info.name).replace(/[_-]+/g, ' ').trim();
      }
    }
    if(info.kind === 'numbered' && info.order !== 999) numbered++;
    const out = { ...s, label };
    if(info.kind === 'dated'){ out.date = info.date; if(info.time) out.time = info.time; }
    return out;
  });
}

/** "2026-11-15" → "Nov 15, 2026" (local date, no UTC shift). */
export function formatStageDate(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if(!m) return iso || '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(+m[1], +m[2] - 1, +m[3]));
}

function formatStageTime(t){
  const [h, mi] = t.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(2000, 0, 1, h, mi));
}
