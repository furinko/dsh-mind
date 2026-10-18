const fs = require('node:fs');
const z = require('node:zlib');
const path = require('node:path');
const manifest = process.argv[2];
if (!manifest) throw new Error('Missing discovered journal manifest');
const journals = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).filter(Boolean);
const rows = [];
const errors = [];
for (const journal of journals) {
  try {
    const b = fs.readFileSync(journal);
    let offset = 0;
    while (offset < b.length) {
      const r = z.zstdDecompressSync(b.subarray(offset), { info: true });
      if (!r.engine.bytesWritten) throw new Error('Decoder made no progress');
      offset += r.engine.bytesWritten;
      for (const line of r.buffer.toString('utf8').split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        const meta = event.data?.meta;
        if (event.type !== 'tool/result' || !meta) continue;
        const file = String(meta.path ?? '').replaceAll('\\', '/');
        const diffs = (meta.diffs ?? []).filter(d => String(d.path ?? '').replaceAll('\\', '/').endsWith('/src/tasks.js'));
        if ((file.endsWith('/src/tasks.js') && meta.lines) || diffs.length) {
          rows.push({ journal, seq: event.seq, time: event.time, error: event.data.message?.isError === true,
            offset: meta.offset, totalLines: meta.totalLines,
            ...(file.endsWith('/src/tasks.js') && meta.lines ? { lines: meta.lines } : {}),
            ...(diffs.length ? { diffs } : {}) });
        }
      }
    }
  } catch (error) {
    errors.push({ journal, error: String(error.message) });
  }
}
rows.sort((a,b) => a.time - b.time || a.seq - b.seq);
fs.writeFileSync(path.join(__dirname, 'task-history.json'), JSON.stringify({ rows, errors }, null, 2), { encoding: 'utf8', flag: 'wx' });
const reads = rows.filter(r => r.lines);
console.log(JSON.stringify({ journals: journals.length, events: rows.length, reads: reads.length, errors,
  largestReads: reads.map(r => ({journal:r.journal, seq:r.seq,time:r.time,offset:r.offset,count:r.lines.length,total:r.totalLines})).sort((a,b)=>b.count-a.count).slice(0,20) }, null, 2));
