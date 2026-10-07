/**
 * 组件 · 看板（宿主侧）。
 *
 * 它是**空的一行**：看板的呈现全在浏览器半区（`lib/client.js`，由本包的 `dsh.client` 段声明）。
 * 宿主侧这个入口存在的理由，与「组件」这个概念本身有关——
 * 插件列表里的每个组件都是一行，而只有**被某一行引用**的包才会进 roster；
 * 反过来说，把这一行关掉，整个包（连同它的浏览器半区）就都不会被加载。
 * 这正是「看板可单独启停」在实现上唯一干净的落点。
 */

export const name = 'dsh-mind-board';

export function apply() {
  // 故意为空 —— 见 ./client.js。
}

export default { name, apply };
