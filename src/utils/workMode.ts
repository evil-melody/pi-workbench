/**
 * 工作模式（1:1 对齐 WorkBuddy 的 模式 菜单：默认/计划/仅问答）。
 *
 * 与思考档（ModeSwitcher：快速/标准/深度）是两回事——一个管「先审后做」，
 * 一个管「想多深」，两者正交。三态互斥，状态只有一份（ComposerPlusMenu 选，
 * ChatView 消费拼前缀），不再在顶栏放第二个开关。
 */
export type WorkMode = 'agent' | 'plan' | 'ask'
