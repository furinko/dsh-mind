/**
 * 项目清单（2026-10-11，主权者指令「修」）：`org.projectList` + 工作台投影 + 免审计口径。
 *
 * 为什么盯它：面板默认只看一个项目（客户端的 fetch 不带 `?project=`），而组织的活账
 * 常常在别的项目键下。没有这份清单，界面上「组织是空的」这句话就没有任何东西能证伪 ——
 * 主人真机看到的就是「任务图/消息总线全空」，而账本里明明有 13 张卡。
 *
 * 三条判据（对应任务卡的验收）：
 *  ① 项目键来自**目录枚举**（目录名即项目键），计数现算，不虚报；
 *  ② 有活动的项目排在前面（界面据此自动选「最近活动的那个」）；
 *  ③ 取这份读数**不写审计**（投影取数与 `讨论消息` / `线程汇总` 同一条免审计口径）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { projectWorkbench } from '../src/workbench.js';
import { ensureDirPath } from '../src/kernel/fsx.js';
import { DIR } from '../src/paths.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {Org} */ let org;

describe('项目清单（面板项目解析）', () => {
  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'default' });
  });
  after(async () => {
    await f.cleanup();
  });

  it('枚举磁盘上出现过的项目键：计数现算，有活动的排前面', async () => {
    // 造两个项目：`alpha` 有 2 张卡 + 1 条未投递消息，`beta` 只有空账位。
    const a1 = await org.tasks.create({ subject: LEAD, 项目: 'alpha', 描述: '甲一', 负责人: 'lead', 判据: ['x'] });
    await org.tasks.create({ subject: LEAD, 项目: 'alpha', 描述: '甲二', 负责人: 'lead', 判据: ['x'] });
    await org.tasks.dispatch(a1.id, { subject: LEAD, 项目: 'alpha' });
    await org.bus.send({ subject: LEAD, 项目: 'alpha', 线程: '通报', 发件: LEAD.id, 收件: ['lead'], 类型: '广播', 内容: '一句话正文' });
    await org.bus.send({ subject: LEAD, 项目: 'alpha', 线程: '通报', 发件: LEAD.id, 收件: ['lead'], 类型: '广播', 内容: '暂不投递的一条', 暂不投递: true });
    // `beta`：只建**空账位目录**（不落任何账）——验「目录在、账没有」这一态。
    await ensureDirPath(f.layout.private(DIR.基础设施, DIR.任务图, 'beta'));
    const 清单 = await org.projectList('default');
    const 键 = 清单.项.map((p) => p.项目);
    assert.ok(键.includes('alpha') && 键.includes('beta') && 键.includes('default'),
      `三个项目键都要在（目录名即项目键），实际 ${JSON.stringify(键)}`);

    const alpha = 清单.项.find((p) => p.项目 === 'alpha');
    assert.equal(alpha.任务, 2, 'alpha 有两张卡');
    assert.equal(alpha.线程, 1, 'alpha 有一条线程');
    assert.equal(alpha.未投递, 1, '未投递数如实（暂不投递那条）');
    assert.ok(typeof alpha.最近于 === 'string' && alpha.最近于.length > 0, '有活动的项目带最近活动时刻');

    // 排序：有活动（alpha）在前；空账项目沉底且不许伪造最近时刻。
    assert.equal(清单.项[0].项目, 'alpha', `有活动的项目排最前，实际 ${清单.项[0].项目}`);
    for (const 空 of 清单.项.filter((p) => p.项目 !== 'alpha')) {
      assert.equal(空.任务, 0, `${空.项目} 没有卡就该报 0`);
      assert.equal(空.最近于, null, `${空.项目} 没有活动就不许编一个时刻出来`);
    }
  });

  it('工作台投影带项目清单；宿主没给就是 null（不装懂）', async () => {
    const 视图 = await org.workbench({ 项目: 'default' });
    assert.ok(视图.项目清单 && Array.isArray(视图.项目清单.项), '投影必须带项目清单');
    assert.equal(视图.项目清单.当前, 'default', '当前项目如实标出（界面据此判断"是不是空账"）');
    assert.ok(视图.项目清单.项.some((p) => p.项目 === 'alpha' && p.任务 === 2), '清单里的计数与账本一致');

    const 基础 = { 项目: 'default', 节点: [], 审计尾: [], 探针: { 状态: '正常', 结果: [] }, 策略: { healthy: true, 错误: null }, 生成于: '2026-10-11T00:00:00Z' };
    assert.equal(projectWorkbench(基础).项目清单, null, '宿主没给清单时不得伪造一份空的');
  });

  it('取项目清单与投影都不写审计（投影取数免审计，设计债③同款）', async () => {
    const 前 = (await org.audit.read({})).length;
    await org.projectList('default');
    await org.workbench({ 项目: 'default' });
    const 后 = (await org.audit.read({})).length;
    assert.equal(后, 前, `读投影不该产生审计行（前 ${前} / 后 ${后}）`);
  });
});
