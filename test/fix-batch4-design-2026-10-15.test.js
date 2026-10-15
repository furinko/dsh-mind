/**
 * F6 · readonlyCommand 危险形态闸（设计评审 · 2026-10-15）
 *
 * 缺陷：白名单是**命令名**级前缀判定，`find / -exec rm -rf x`、`git diff --output=<文件>`、
 * `git -c <注入> log`、`cat a > b` 都能靠前缀命中放行（复核员第 5 代反例面实测
 * `readonlyCommand('find / -exec rm -rf x')` ⇒ 允许=true）。
 * 修法：命令名匹配之前先过「危险形态」闸（重定向/管道/命令替换/控制符 + find 类执行写盘旗标
 * + 输出到文件旗标 + git 配置注入位），能写盘或起子进程的形态一律拒、理由指向沙箱区。
 *
 * 判据（three-态复核面）：①已知绕过面全拒；②普通只读形态不误伤（`-i`/`-c`/`-o` 歧义旗标
 * 刻意不在拒绝表内——`grep -i`、`wc -c`、`head -c` 都是合法只读）；③既有口径不变（node 系一律拒）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewProtocol } from '../src/review.js';

describe('F6 · readonlyCommand 危险形态闸（设计评审 · 2026-10-15）', () => {
  it('①已知绕过面被拒：find 执行旗标 / 输出到文件 / git 注入位 / shell 元字符', () => {
    const 必拒 = [
      'find / -exec rm -rf x',
      'find . -execdir sh -c "x" ;',
      'find . -delete',
      'find . -fprint /tmp/x',
      'git diff --output=/tmp/x',
      'git diff --out /tmp/x',
      'git -c core.pager=sh log',
      'git --exec-path=/tmp log',
      'cat a.txt > b.txt',
      'cat a.txt | head -3',
      'ls $(whoami)',
      'git log `whoami`',
      'git status; rm -rf x',
    ];
    for (const 命令 of 必拒) {
      const 判 = ReviewProtocol.readonlyCommand(命令);
      assert.equal(判.允许, false, `危险形态必须拒：${命令}`);
      assert.match(判.依据, /危险形态/, `拒绝理由要说清是危险形态：${命令}`);
      assert.match(判.howToChange ?? '', /沙箱/, `拒绝要给可执行理由（沙箱区）：${命令}`);
    }
  });

  it('②正对照：普通只读形态不受误伤（含歧义旗标 -i / -c / -o 的合法只读用法）', () => {
    const 必允 = [
      'git status',
      'git log --oneline -5',
      'git diff HEAD',
      'find . -name x',
      'grep -i -c foo file.txt',
      'grep -o bar file.txt',
      'wc -l file.txt',
      'wc -c file.txt',
      'head -c 100 file.txt',
      'cat file.txt',
      'tail -n 20 file.txt',
    ];
    for (const 命令 of 必允) {
      assert.equal(ReviewProtocol.readonlyCommand(命令).允许, true, `不许误伤只读形态：${命令}`);
    }
  });

  it('③既有口径不变：node 系一律拒（白名单式），拒绝理由仍指沙箱区', () => {
    for (const 命令 of ['node --test', 'node --test test/flow.test.js', 'node --version']) {
      const 判 = ReviewProtocol.readonlyCommand(命令);
      assert.equal(判.允许, false, `node 系不在白名单：${命令}`);
      assert.match(判.howToChange ?? '', /沙箱/);
    }
  });
});
