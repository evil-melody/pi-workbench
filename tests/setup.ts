/**
 * 测试统一锁定中文界面。
 *
 * jsdom / node 的 `navigator.language` 是 en-US，若不锁定，组件挂载类用例会
 * 按系统语言切到英文，把断言中文文案的用例全部打翻。这里在模块图建立前写入
 * 首屏缓存，`initLocale` 随后读到的就是 zh-CN。
 *
 * node 环境（vitest 默认）没有 localStorage，且 Node 22+ 自带 `navigator`
 * （language='en-US'）——不补垫片的话上面的锁定被静默跳过，systemLocale()
 * 读到 en-US，纯函数域的中文断言整片打翻。所以先给一个内存垫片再锁。
 */
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
    configurable: true,
  })
}
globalThis.localStorage.setItem('pi-workbench:lang', 'zh-CN')
