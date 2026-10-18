/**
 * dsh-mind —— **bundle 包本身**，不插行。
 *
 * 它提供的三样东西：
 *  1. `cordis.patch.yml` —— 装进 profile 的那张卡的补丁，里面插入三个组件行；
 *  2. `src/` —— 八件基础设施与对象存储的实现（组件包用相对路径引它）；
 *  3. `mind/` —— 出厂区（宪章 / 法律 / 编制 / 岗位卡 / 出厂能力库 / 默认值）。
 *
 * 插件列表里出现的是**这张卡**；卡下面「包含的组件」是那三行。
 * 本文件因此没有任何插件体行为——它只在一个地方会被读到：
 * 有人手工把 `dsh-mind` 当插件名插一行时，宿主会加载它，然后发现这里什么都没有。
 */
export const name = 'dsh-mind';

export function apply() {
  // 故意为空：本包不插自己的行。要装的是三个组件，见 ./cordis.patch.yml。
}

export default { name, apply };
