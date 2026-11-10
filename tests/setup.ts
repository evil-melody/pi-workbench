/**
 * 测试统一锁定中文界面。
 *
 * jsdom / node 的 `navigator.language` 是 en-US，若不锁定，组件挂载类用例会
 * 按系统语言切到英文，把断言中文文案的用例全部打翻。这里在模块图建立前写入
 * 首屏缓存，`initLocale` 随后读到的就是 zh-CN。
 */
if (typeof localStorage !== 'undefined') {
  localStorage.setItem('pi-workbench:lang', 'zh-CN')
}
