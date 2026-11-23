//! 反废话指令（Agent 输出纪律）—— 全仓唯一真源。
//!
//! 背景：多 agent 并行时，模型每多说一句寒暄 / 过程叙述，乘以成员数就是成倍的
//! token 浪费，而且这些内容对交付没有信息量。本模块给出唯一一段纪律文本，
//! 由 `pi_bridge` 注入环境变量 `PI_AGENT_TERSE`，`agent-teams` 扩展读取后
//! 拼进每个成员子进程的提示词。
//!
//! 单一真源的意义：这段文本在 Rust、TS 扩展、外部 CLI 派发三处都要用。
//! 如果各写一份，改一处就会漂移——所以只在这里定义，其余地方一律引用。
//!
//! `ponytail:` 标记：本指令只约束表达，不删信息。
//! 若后续发现某些任务确实需要展开推理，取消注入即可（把 `TERSE_ENABLED` 置 false），
//! 无需改动任何调用点。

/// 注入给所有 agent 子进程的输出纪律。
pub const TERSE_DIRECTIVE: &str = "\
# 输出纪律（强制）
结论先行。不寒暄，不复述任务，不叙述过程，不为已完成的动作写总结。
每条结论只附必要依据：文件:行、命令或数据。
禁止开场答应、进度预告、收尾致谢这类零信息表达。
不确定就直说不确定，不要用推测补全。
默认上限 200 字；超出部分改用要点列表。不要用 markdown 标题分节。";

/// 是否启用注入。全局开关，出问题可以一键关掉而不必改调用点。
pub const TERSE_ENABLED: bool = true;

/// 组装注入片段：空串表示不注入（调用点统一处理「空则不拼」的分支）。
pub fn terse_directive() -> &'static str {
    if TERSE_ENABLED {
        TERSE_DIRECTIVE
    } else {
        ""
    }
}

/// 环境变量名。Rust 侧写、TS 扩展读，两边必须一致。
pub const TERSE_ENV: &str = "PI_AGENT_TERSE";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directive_has_no_filler_words() {
        // 纪律文本自己不能带废话：出现过渡语就说明被误改了。
        for banned in ["好的", "让我们", "我明白了"] {
            assert!(
                !TERSE_DIRECTIVE.contains(banned),
                "纪律文本里出现了过渡语：{banned}"
            );
        }
    }

    #[test]
    fn enabled_returns_text() {
        assert!(!terse_directive().is_empty());
    }
}
