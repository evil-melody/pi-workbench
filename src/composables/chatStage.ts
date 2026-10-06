/**
 * 对话页的两段式版式判据。
 *
 * 第一段：落地页（Hero）—— 选工作目录、写第一句话。
 * 第二段：会话流 —— 消息、轨迹、输入框。
 *
 * 判据只看「有没有消息」，**工作目录不进判据**。
 * 老实现把它也算进去（`!cwd && messages.length === 0 && !streaming`），
 * 于是选完项目的那一刻落地页就消失：用户被扔进一个还没有任何消息的空会话，
 * 左边文件树、右边浏览器/终端同时压上来 —— 看起来就是「坏了」。
 * 「选了项目应该还停留在原来的界面」，这条规则现在就写在这一个函数里。
 */
export function shouldShowHero(messageCount: number, streaming: boolean): boolean {
  return messageCount === 0 && !streaming
}
