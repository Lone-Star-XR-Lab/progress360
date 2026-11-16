// Tiny static file server for local testing and the smoke tests.
// Supports HEAD and Range requests (the viewer uses both), and optionally directory listings
// (--list) to mimic hosts like `npx http-server` where the browser can read folder contents.
//
//   node tests/server.mjs [port] [--list]
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/plain; charset=utf-8',
};

export function startServer({ root = process.cwd(), port = 0, list = false } = {}){
  const rootAbs = path.resolve(root);
  const server = http.createServer((req, res)=>{
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end(); }
    let file = path.join(rootAbs, pathname);
    if(!file.startsWith(rootAbs)){ res.writeHead(403); return res.end(); }

    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('Not found'); }
    if(st.isDirectory()){
      const idx = path.join(file, 'index.html');
      if(fs.existsSync(idx)){ file = idx; st = fs.statSync(idx); }
      else if(list){
        const rel = pathname.replace(/\/?$/, '/');
        const items = fs.readdirSync(file, { withFileTypes: true })
          .map((d)=> `<li><a href="${rel}${encodeURIComponent(d.name)}${d.isDirectory() ? '/' : ''}">${d.name}</a></li>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><ul><li><a href="../">..</a></li>${items}</ul>`);
      } else { res.writeHead(404); return res.end('Not found'); }
    }

    const headers = {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'last-modified': st.mtime.toUTCString(),
      'cache-control': 'no-cache',
    };
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if(m){
      const start = +m[1];
      const end = Math.min(st.size - 1, m[2] ? +m[2] : st.size - 1);
      if(start >= st.size){ res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if(req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if(req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve)=> server.listen(port, '127.0.0.1', ()=> resolve(server)));
}

if(process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)){
  const port = +process.argv.find((a)=> /^\d+$/.test(a)) || 8080;
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const server = await startServer({ root, port, list: process.argv.includes('--list') });
  console.log(`Progress360 on http://localhost:${server.address().port}/  (Ctrl+C to stop)`);
}
