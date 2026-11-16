// Minimal EXIF reader for JPEGs: capture date and GPS. Used by the viewer's Details panel and
// the gallery map. Only the first 128 KB of each file is requested (via Range).

const cache = new Map();   // url -> Promise<{ exifTaken, httpTaken, gps, rawDate }>

/** @returns {Promise<{exifTaken?:string, httpTaken?:string, rawDate?:string, gps?:{lat:number,lon:number}}>} */
export function readExif(url){
  if(!/\.jpe?g(\?|#|$)/i.test(url || '')) return Promise.resolve({});
  if(!cache.has(url)){
    cache.set(url, (async ()=>{
      try{
        const r = await fetch(url, { headers: { Range: 'bytes=0-131071' } });
        if(!r.ok) return {};
        const lastModified = r.headers.get('last-modified');
        const buf = await r.arrayBuffer();
        let meta = {};
        try { meta = parseBasicExif(buf) || {}; } catch {}
        const raw = meta.dateTimeOriginal || meta.dateTimeDigitized || meta.dateTime;
        const gps = meta.gps && Number.isFinite(meta.gps.lat) && Number.isFinite(meta.gps.lon)
          && !(meta.gps.lat === 0 && meta.gps.lon === 0) ? meta.gps : undefined;
        return { exifTaken: formatExifDate(raw), httpTaken: formatHttpDate(lastModified), rawDate: raw, gps };
      }catch{ return {}; }
    })());
  }
  return cache.get(url);
}

function parseBasicExif(arrayBuffer){
  const data = new DataView(arrayBuffer);
  if(data.byteLength < 4 || data.getUint16(0) !== 0xFFD8) return {};
  let offset = 2;
  while(offset + 4 <= data.byteLength){
    const marker = data.getUint16(offset);
    const size = data.getUint16(offset + 2);
    if((marker & 0xFF00) !== 0xFF00 || size < 2 || marker === 0xFFDA) break;   // not a marker / start of scan
    if(marker === 0xFFE1 && getString(data, offset + 4, 4) === 'Exif'){
      return readTIFF(data, offset + 10);
    }
    offset += 2 + size;
  }
  return {};
}

function readTIFF(view, base){
  const little = view.getUint16(base) === 0x4949;
  const u16 = (o)=> view.getUint16(o, little);
  const u32 = (o)=> view.getUint32(o, little);
  const rational = (o)=> { const d = u32(o + 4); return d ? u32(o) / d : 0; };
  function readIFD(at){
    const count = u16(at);
    const tags = new Map();
    let p = at + 2;
    for(let i = 0; i < count; i++, p += 12){
      const tag = u16(p), type = u16(p + 2), num = u32(p + 4);
      const inline = p + 8;
      const off = ()=> u32(inline) + base;
      let value = null;
      if(type === 2) value = getString(view, num > 4 ? off() : inline, Math.max(0, num - 1));
      else if(type === 3) value = num > 1 ? Array.from({ length: num }, (_, k)=> u16(off() + 2 * k)) : u16(inline);
      else if(type === 4) value = num > 1 ? Array.from({ length: num }, (_, k)=> u32(off() + 4 * k)) : u32(inline);
      else if(type === 5) value = num > 1 ? Array.from({ length: num }, (_, k)=> rational(off() + 8 * k)) : rational(off());
      tags.set(tag, value);
    }
    return tags;
  }
  const ifd0 = readIFD(u32(base + 4) + base);
  const meta = {};
  const exifPtr = ifd0.get(0x8769);
  if(exifPtr){
    const exif = readIFD(exifPtr + base);
    if(exif.get(0x9003)) meta.dateTimeOriginal = String(exif.get(0x9003)).trim();
    if(exif.get(0x9004)) meta.dateTimeDigitized = String(exif.get(0x9004)).trim();
  }
  if(ifd0.get(0x0132)) meta.dateTime = String(ifd0.get(0x0132)).trim();
  const gpsPtr = ifd0.get(0x8825);
  if(gpsPtr){
    const gps = readIFD(gpsPtr + base);
    const lat = gps.get(0x0002), lon = gps.get(0x0004);
    if(lat && lon){
      const deg = (a)=> Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : a || 0;
      meta.gps = { lat: deg(lat) * (gps.get(0x0001) === 'S' ? -1 : 1), lon: deg(lon) * (gps.get(0x0003) === 'W' ? -1 : 1) };
    }
  }
  return meta;
}

function getString(view, offset, len){
  let s = '';
  for(let i = 0; i < len && offset + i < view.byteLength; i++){
    const c = view.getUint8(offset + i);
    if(c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function formatExifDate(s){
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if(!m) return s || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) ? s : dateFmt.format(d);
}
function formatHttpDate(h){
  const d = h ? new Date(h) : null;
  return d && !isNaN(d) ? dateFmt.format(d) : '';
}
