const fs = require('node:fs');
const crypto = require('node:crypto');
const history = JSON.parse(fs.readFileSync(__dirname + '/task-history.json', 'utf8')).rows;
function snapshot(id) {
  const reads = history.filter(r => r.journal.includes('\\' + id + '\\') && r.lines && r.totalLines === 1366);
  const lines = new Array(1366);
  for (const r of reads) for (const l of r.lines) {
    if (lines[l.number - 1] !== undefined && lines[l.number - 1] !== l.text) throw Error('Snapshot disagreement at ' + l.number);
    lines[l.number - 1] = l.text;
  }
  const missing = Array.from({length:1366}, (_,i) => i + 1).filter(n => lines[n-1] === undefined);
  if (missing.length) throw Error('Incomplete snapshot ' + id + ': ' + missing.slice(0,20));
  return lines.join('\n');
}
let text = snapshot('7b4ca167-797e-4919-a3cc-2260de80fcff');
const other = snapshot('93c3f53a-ec15-4a8d-9d15-bfc4014c000e');
if (text !== other) throw Error('Independent complete snapshots disagree');
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
if (fs.existsSync(__dirname + '/tasks-before-w1.js')) {
  if (fs.readFileSync(__dirname + '/tasks-before-w1.js','utf8') !== text) throw Error('Baseline evidence changed');
} else fs.writeFileSync(__dirname + '/tasks-before-w1.js', text, {encoding:'utf8',flag:'wx'});
const main = history.filter(r => r.journal.includes('\\session-d889c676-babd-479d-8dde-c4e2411112a2\\') && r.seq < 3500);
const events = [...main, {seq:1152, shell:1}, {seq:2958, shell:2}].sort((a,b)=>a.seq-b.seq);
const report = {baselineHash:hash(text), independentSnapshotsEqual:true, baselineLastLineEmpty:text.endsWith('\n'), checks:[], edits:[]};
for (const r of events) {
  if (r.error) continue;
  if (r.shell) {
    const lines = text.replace(/\n$/, '').split('\n');
    if (r.shell === 1) {
      if (!lines[452].includes('/**') || !lines[555].includes('/**')) throw Error('W1 shell boundaries differ');
      text = [...lines.slice(0,452), ...lines.slice(555)].join('\n') + '\n';
    } else {
      if (!lines[589].includes('W2 会审讨论段') || !lines[775].includes('/**')) throw Error('W4 shell boundaries differ');
      const tomb = [
        '  // ── v2（口述收敛 2026-10-18 条目18）：会审讨论段退出任务图 ──────────────────',
        '  // debateOpened/debateRounded/debateConverged 三个写路径已删——会审是与会话绑定的',
        '  // 独立功能（src/council.js，自己的 councils.jsonl 事件流）。旧事件（debate_*）',
        '  // 仍由下方 fold 分支折出（历史数据原地只读不迁移）；TRANSITIONS 里的 debate_*',
        '  // 条目同步失效：没有人再能追加它们，状态机自然封闭。', ''
      ];
      text = [...lines.slice(0,589), ...tomb, ...lines.slice(775)].join('\n') + '\n';
    }
    report.edits.push({seq:r.seq,shell:r.shell,hash:hash(text)});
  } else if (r.diffs) {
    for (const d of r.diffs) {
      const old = d.oldText.replaceAll('\r\n','\n');
      const next = d.newText.replaceAll('\r\n','\n');
      const count = text.split(old).length - 1;
      if (count !== 1) {
        fs.writeFileSync(__dirname + '/replay-stopped.js', text, 'utf8');
        throw Error('Patch anchor count ' + count + ' at event ' + r.seq + ': ' + old.slice(0,100));
      }
      text = text.replace(old,next);
    }
    report.edits.push({seq:r.seq,hash:hash(text)});
  } else if (r.lines) {
    const lines = text.split('\n');
    const failures = r.lines.filter(l => lines[l.number - 1] !== l.text);
    if (failures.length) {
      fs.writeFileSync(__dirname + '/replay-stopped.js', text, 'utf8');
      throw Error('Historical read mismatch at seq ' + r.seq + ' lines ' + failures.slice(0,10).map(l=>l.number));
    }
    report.checks.push({seq:r.seq,matchedLines:r.lines.length,total:r.totalLines});
  }
}
report.finalHash = hash(text);
report.finalLines = text.split('\n').length;
fs.writeFileSync(__dirname + '/tasks-after-w4.js', text, {encoding:'utf8',flag:'wx'});
fs.writeFileSync(__dirname + '/replay-report.json', JSON.stringify(report,null,2), {encoding:'utf8',flag:'wx'});
console.log(JSON.stringify(report,null,2));
