use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// 专家定义字段上限（字段上限）。
/// 字符串上限按 Unicode 码点计，发布时另查总 UTF-8 字节。
const NAME_MAX: usize = 80;
const DESCRIPTION_MAX: usize = 300;
const PROSE_MAX: usize = 16_000;
const TAGS_MAX: usize = 8;
const EXAMPLES_MAX: usize = 6;
const SKILL_REQUIREMENTS_MAX: usize = 32;
const ALLOWED_TOOLS_MAX: usize = 64;
const DENIED_PATTERNS_MAX: usize = 32;
const MAX_ITERATIONS_CAP: u32 = 50;
/// 硬规则文本上限（LoopForge Role.Rules）。
const RULES_MAX: usize = 8_000;
/// 角色可绑定的 MCP 服务数上限。
const MCP_SERVERS_MAX: usize = 16;
/// 执行器名 / 模型名长度上限。
const EXECUTOR_MAX: usize = 40;
const MODEL_MAX: usize = 120;
/// 发布定义的总字节上限（32 KiB）。
const PUBLISHED_MAX_BYTES: usize = 32 * 1024;
/// 头像文件大小上限。缓存里的头像普遍几十 KB，2 MB 已经宽松；
/// 超限不复制、退回首字头像——头像不该把配置目录撑爆。
const AVATAR_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 发布确认Token 有效期：5 分钟。过期必须重新确认，绝不自动发布。
const CONFIRMATION_TTL_MS: u64 = 5 * 60 * 1000;

// ── 领域模型 ──────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExpertExample {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub prompt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SkillRequirement {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
}

/// 专家定义。字段与 `ExpertDefinition` 对齐：
/// 人格由 role / methodology / boundaries / deliverables 四段拼装，
/// 而不是一整段自由文本——这样哪一段写坏了能定位到具体字段。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExpertDefinition {
    pub name: String,
    pub description: String,
    pub role: String,
    pub methodology: String,
    pub boundaries: String,
    pub deliverables: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub examples: Vec<ExpertExample>,
    #[serde(default)]
    pub skill_requirements: Vec<SkillRequirement>,
    /// 允许工具集（内核工具名）。空 = 不限制，沿用全局策略。
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// 拒绝模式：bash 命令命中任一子串即拦截（大小写不敏感）。
    #[serde(default)]
    pub denied_patterns: Vec<String>,
    /// 停止条件：写进 persona，告诉模型何时收手。
    #[serde(default)]
    pub stop_condition: String,
    /// 运行参数：单轮最大迭代次数（None = 内核默认）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    /// 导入时对未映射工具的决策记录：`to = None` 表示主动忽略。
    /// 只做追溯，不参与工具门判断（工具门只看 `allowed_tools`）。
    #[serde(default)]
    pub tool_mapping: Vec<ToolMappingEntry>,
    /// 执行器：真正跑这个角色的 agent CLI（pi / claude / codex / 自定义命令名）。
    /// None = 跟随内核默认。写死之后调度端只会照它执行，不会悄悄换成别的。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    /// 该角色专用模型标识。None = 跟随执行器 / 内核默认。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 硬规则：以约束形式追加到 persona 尾部，比「工作方法」更强。
    /// LoopForge 把 Role 拆成 Prompt / Executor / Model / Rules / Skills / MCP，
    /// 这里对齐同样的分层，让「谁在什么模型上受什么约束」一眼可查。
    #[serde(default)]
    pub rules: String,
    /// 该角色可用的 MCP 服务名。空 = 不限制（沿用全局）。
    #[serde(default)]
    pub mcp_servers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolMappingEntry {
    /// 外部定义里的原始工具名。
    pub from: String,
    /// 映射到的内核工具名；None = 主动忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// mapped / ignored，冗余存一份便于人读。
    pub decision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DomainIssue {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

/// 会进入 persona 前缀的文本字段：字面量 `{{}}` 会被模板引擎当变量插值，必须拒绝。
const TEMPLATE_TEXT_FIELDS: &[&str] = &[
    "name",
    "description",
    "role",
    "methodology",
    "boundaries",
    "deliverables",
    "stopCondition",
];

fn has_template_braces(value: &str) -> bool {
    value.contains("{{") || value.contains("}}")
}

fn code_point_len(value: &str) -> usize {
    value.chars().count()
}

/// 导入专用：按字符上限截断超长文本字段，返回被截断的字段说明。
/// WorkBuddy 专家正文常超发布上限；导入阶段直接截断并如实告知，
/// 比让用户去外部文件里手工精简更可用（发布前仍可在专家中心补全）。
fn truncate_for_import(def: &mut ExpertDefinition) -> Vec<String> {
    fn cut(label: &str, field: &mut String, max: usize, notes: &mut Vec<String>) {
        if code_point_len(field) > max {
            *field = field.chars().take(max).collect();
            notes.push(format!("{label}已截到 {max} 字"));
        }
    }
    let mut notes = Vec::new();
    cut("名称", &mut def.name, NAME_MAX, &mut notes);
    cut("描述", &mut def.description, DESCRIPTION_MAX, &mut notes);
    cut("角色定位", &mut def.role, PROSE_MAX, &mut notes);
    cut("工作方法", &mut def.methodology, PROSE_MAX, &mut notes);
    cut("行为边界", &mut def.boundaries, PROSE_MAX, &mut notes);
    cut("交付物", &mut def.deliverables, PROSE_MAX, &mut notes);
    cut("停止条件", &mut def.stop_condition, 2_000, &mut notes);
    cut("硬规则", &mut def.rules, RULES_MAX, &mut notes);
    def.tags.truncate(TAGS_MAX);
    def.examples.truncate(EXAMPLES_MAX);
    def.skill_requirements.truncate(SKILL_REQUIREMENTS_MAX);
    def.allowed_tools.truncate(ALLOWED_TOOLS_MAX);
    def.denied_patterns.truncate(DENIED_PATTERNS_MAX);
    def.mcp_servers.truncate(MCP_SERVERS_MAX);
    notes
}

fn push_required(issues: &mut Vec<DomainIssue>, path: &str, label: &str, value: &str) {
    if value.trim().is_empty() {
        issues.push(DomainIssue {
            code: "definition/required".into(),
            path: Some(path.into()),
            message: format!("{label}不能为空。"),
        });
    }
}

/// 非阻塞提示：缺了不影响发布，但看得见、值得补。
fn push_notice(issues: &mut Vec<DomainIssue>, path: &str, label: &str, value: &str) {
    if value.trim().is_empty() {
        issues.push(DomainIssue {
            code: "definition/notice".into(),
            path: Some(path.into()),
            message: format!("{label}为空：可以发布，但补上后这个角色更稳定。"),
        });
    }
}

fn push_limit(issues: &mut Vec<DomainIssue>, path: &str, label: &str, value: &str, max: usize) {
    if code_point_len(value) > max {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some(path.into()),
            message: format!("{label}超过 {max} 个字符上限。"),
        });
    }
}

/// 校验候选定义，返回全部问题（无副作用）。空列表表示可以发布。
pub fn validate_definition(candidate: &ExpertDefinition) -> Vec<DomainIssue> {
    let mut issues = Vec::new();

    // 抽成带 issues 入参的普通函数而不是闭包：两个闭包同时存活会各自独占 issues 的可变借用，编译器直接拒绝。
    push_required(&mut issues, "name", "名称", &candidate.name);
    push_required(&mut issues, "description", "描述", &candidate.description);
    // 角色定位 / 行为边界 / 工作方法 / 交付物全部降为**非阻塞提示**：
    // 外部角色文件的结构千奇百怪（英文包常把自我定位写在标题夹空行后，
    // 解析出来 persona 有肉但 role 字段是空的），强制必填让大批导入草稿
    // 卡在发布检查上——用户看到的「发布」按钮形同虚设。缺了照样能发布
    // （persona 预览有内容就烧得进去），但发布检查里看得见，补上更好。
    push_notice(&mut issues, "role", "角色定位", &candidate.role);
    push_notice(&mut issues, "boundaries", "行为边界", &candidate.boundaries);
    push_notice(&mut issues, "methodology", "工作方法", &candidate.methodology);
    push_notice(&mut issues, "deliverables", "交付物", &candidate.deliverables);

    push_limit(&mut issues, "name", "名称", &candidate.name, NAME_MAX);
    push_limit(
        &mut issues,
        "description",
        "描述",
        &candidate.description,
        DESCRIPTION_MAX,
    );
    push_limit(&mut issues, "role", "角色定位", &candidate.role, PROSE_MAX);
    push_limit(
        &mut issues,
        "methodology",
        "工作方法",
        &candidate.methodology,
        PROSE_MAX,
    );
    push_limit(
        &mut issues,
        "boundaries",
        "行为边界",
        &candidate.boundaries,
        PROSE_MAX,
    );
    push_limit(
        &mut issues,
        "deliverables",
        "交付物",
        &candidate.deliverables,
        PROSE_MAX,
    );

    for (i, tag) in candidate.tags.iter().enumerate() {
        push_limit(&mut issues, &format!("tags.{i}"), "标签", tag, 40);
    }
    for (i, example) in candidate.examples.iter().enumerate() {
        push_required(
            &mut issues,
            &format!("examples.{i}.id"),
            "示例 id",
            &example.id,
        );
        push_required(
            &mut issues,
            &format!("examples.{i}.prompt"),
            "示例内容",
            &example.prompt,
        );
        push_limit(
            &mut issues,
            &format!("examples.{i}.id"),
            "示例 id",
            &example.id,
            64,
        );
        push_limit(
            &mut issues,
            &format!("examples.{i}.prompt"),
            "示例内容",
            &example.prompt,
            4000,
        );
        if let Some(title) = example.title.as_deref() {
            push_limit(
                &mut issues,
                &format!("examples.{i}.title"),
                "示例标题",
                title,
                120,
            );
        }
    }
    for (i, r) in candidate.skill_requirements.iter().enumerate() {
        push_required(
            &mut issues,
            &format!("skillRequirements.{i}.name"),
            "Skill 名称",
            &r.name,
        );
    }

    if candidate.tags.len() > TAGS_MAX {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some("tags".into()),
            message: format!("标签数量超过 {TAGS_MAX} 个上限。"),
        });
    }
    if candidate.examples.len() > EXAMPLES_MAX {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some("examples".into()),
            message: format!("示例数量超过 {EXAMPLES_MAX} 个上限。"),
        });
    }
    if candidate.skill_requirements.len() > SKILL_REQUIREMENTS_MAX {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some("skillRequirements".into()),
            message: format!("Skill 依赖数量超过 {SKILL_REQUIREMENTS_MAX} 个上限。"),
        });
    }
    if candidate.allowed_tools.len() > ALLOWED_TOOLS_MAX {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some("allowedTools".into()),
            message: format!("允许工具数量超过 {ALLOWED_TOOLS_MAX} 个上限。"),
        });
    }
    if candidate.denied_patterns.len() > DENIED_PATTERNS_MAX {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some("deniedPatterns".into()),
            message: format!("拒绝模式数量超过 {DENIED_PATTERNS_MAX} 个上限。"),
        });
    }
    for (i, tool) in candidate.allowed_tools.iter().enumerate() {
        push_required(&mut issues, &format!("allowedTools.{i}"), "工具名", tool);
        push_limit(
            &mut issues,
            &format!("allowedTools.{i}"),
            "工具名",
            tool,
            64,
        );
    }
    for (i, pattern) in candidate.denied_patterns.iter().enumerate() {
        push_limit(
            &mut issues,
            &format!("deniedPatterns.{i}"),
            "拒绝模式",
            pattern,
            200,
        );
    }
    push_limit(
        &mut issues,
        "stopCondition",
        "停止条件",
        &candidate.stop_condition,
        2_000,
    );
    if let Some(n) = candidate.max_iterations {
        if n == 0 || n > MAX_ITERATIONS_CAP {
            issues.push(DomainIssue {
                code: "definition/limit".into(),
                path: Some("maxIterations".into()),
                message: format!("最大迭代次数需在 1–{MAX_ITERATIONS_CAP} 之间。"),
            });
        }
    }

    // LoopForge 角色分层的新增字段：执行器 / 模型 / 硬规则 / MCP。
    if let Some(exec) = candidate.executor.as_deref() {
        push_limit(&mut issues, "executor", "执行器", exec, EXECUTOR_MAX);
        if has_template_braces(exec) {
            issues.push(DomainIssue {
                code: "definition/template-braces".into(),
                path: Some("executor".into()),
                message: "执行器名不能包含字面量 {{ 或 }}。".into(),
            });
        }
    }
    if let Some(model) = candidate.model.as_deref() {
        push_limit(&mut issues, "model", "模型", model, MODEL_MAX);
    }
    push_limit(&mut issues, "rules", "硬规则", &candidate.rules, RULES_MAX);
    if candidate.mcp_servers.len() > MCP_SERVERS_MAX {
        issues.push(DomainIssue {
            code: "definition/limit".into(),
            path: Some("mcpServers".into()),
            message: format!("MCP 服务数量超过 {MCP_SERVERS_MAX} 个上限。"),
        });
    }
    for (i, server) in candidate.mcp_servers.iter().enumerate() {
        push_required(&mut issues, &format!("mcpServers.{i}"), "MCP 服务名", server);
        push_limit(
            &mut issues,
            &format!("mcpServers.{i}"),
            "MCP 服务名",
            server,
            120,
        );
    }

    for field in TEMPLATE_TEXT_FIELDS {
        let value = match *field {
            "name" => &candidate.name,
            "description" => &candidate.description,
            "role" => &candidate.role,
            "methodology" => &candidate.methodology,
            "boundaries" => &candidate.boundaries,
            "stopCondition" => &candidate.stop_condition,
            _ => &candidate.deliverables,
        };
        if has_template_braces(value) {
            issues.push(DomainIssue {
                code: "definition/template-braces".into(),
                path: Some((*field).into()),
                message: "文本不能包含字面量 {{ 或 }}，persona 模板会将其当作变量插值。".into(),
            });
        }
    }
    for (i, example) in candidate.examples.iter().enumerate() {
        if has_template_braces(&example.prompt)
            || example.title.as_deref().is_some_and(has_template_braces)
        {
            issues.push(DomainIssue {
                code: "definition/template-braces".into(),
                path: Some(format!("examples.{i}.prompt")),
                message: "示例文本不能包含字面量 {{ 或 }}。".into(),
            });
        }
    }

    let mut seen_examples = std::collections::HashSet::new();
    for (i, example) in candidate.examples.iter().enumerate() {
        if !seen_examples.insert(example.id.clone()) {
            issues.push(DomainIssue {
                code: "definition/duplicate-example-id".into(),
                path: Some(format!("examples.{i}.id")),
                message: "示例 id 重复。".into(),
            });
        }
    }
    let mut seen_tags = std::collections::HashSet::new();
    for (i, tag) in candidate.tags.iter().enumerate() {
        if !seen_tags.insert(tag.trim().to_string()) {
            issues.push(DomainIssue {
                code: "definition/duplicate-tag".into(),
                path: Some(format!("tags.{i}")),
                message: "标签重复。".into(),
            });
        }
    }

    // 序列化字节数 ≈ 落盘体积，超 32 KiB 说明这不是一份「轻量人格」，拒绝发布。
    let bytes = serde_json::to_string(candidate)
        .map(|s| s.len())
        .unwrap_or(candidate.name.len() * 3);
    if bytes > PUBLISHED_MAX_BYTES {
        issues.push(DomainIssue {
            code: "definition/too-large".into(),
            path: None,
            message: format!("定义总大小 {bytes} 字节，超过上限 {PUBLISHED_MAX_BYTES} 字节。"),
        });
    }

    issues
}

/// 去空白、丢空标签：两遍「只差空格」的编辑必须得到同一个摘要。
pub fn normalize_definition(input: &ExpertDefinition) -> ExpertDefinition {
    let trim = |v: &str| v.trim().to_string();
    ExpertDefinition {
        name: trim(&input.name),
        description: trim(&input.description),
        role: trim(&input.role),
        methodology: trim(&input.methodology),
        boundaries: trim(&input.boundaries),
        deliverables: trim(&input.deliverables),
        tags: input
            .tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect(),
        examples: input
            .examples
            .iter()
            .map(|e| ExpertExample {
                id: e.id.clone(),
                title: e.title.as_deref().map(trim).filter(|t| !t.is_empty()),
                prompt: trim(&e.prompt),
            })
            .collect(),
        skill_requirements: input
            .skill_requirements
            .iter()
            .map(|r| SkillRequirement {
                name: trim(&r.name),
                skill_id: r.skill_id.as_deref().map(trim).filter(|s| !s.is_empty()),
            })
            .collect(),
        // 工具名去空白去重：勾选顺序不影响摘要，重复勾选只算一次。
        allowed_tools: dedupe_strings(input.allowed_tools.iter().map(|s| trim(s))),
        denied_patterns: dedupe_strings(input.denied_patterns.iter().map(|s| trim(s))),
        stop_condition: trim(&input.stop_condition),
        max_iterations: input.max_iterations,
        // 执行器 / 模型：空串按「未指定」处理，避免 "" 与 None 产出不同摘要。
        executor: input.executor.as_deref().map(trim).filter(|s| !s.is_empty()),
        model: input.model.as_deref().map(trim).filter(|s| !s.is_empty()),
        rules: trim(&input.rules),
        mcp_servers: dedupe_strings(input.mcp_servers.iter().map(|s| trim(s))),
        // 决策以 `to` 为准，避免外部文件把 decision 写成与目标矛盾的值。
        tool_mapping: input
            .tool_mapping
            .iter()
            .filter(|m| !m.from.trim().is_empty())
            .map(|m| {
                let to = m.to.as_deref().map(trim).filter(|s| !s.is_empty());
                ToolMappingEntry {
                    from: trim(&m.from),
                    decision: if to.is_some() { "mapped".into() } else { "ignored".into() },
                    to,
                }
            })
            .collect(),
    }
}

fn dedupe_strings(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if item.is_empty() || out.iter().any(|existing| existing == &item) {
            continue;
        }
        out.push(item);
    }
    out
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 内容摘要：规范化后的定义序列化后取 SHA-256。
/// 摘要绑定的是「规范化之后的内容」，所以空格差异不会产生新摘要。
pub fn definition_digest(definition: &ExpertDefinition) -> String {
    sha256_hex(&serde_json::to_string(&normalize_definition(definition)).unwrap_or_default())
}

/// 专家 persona 的完整落盘形态：`<!-- role: expert:<id> | <name> -->` 头 +
/// 前缀/后缀合成。**头是 role-inject 扩展的硬要求**——缺头 = 整份 persona 被
/// 扩展跳过，人格从未进系统提示（曾经真 bug：只有工具门生效）。
pub fn render_expert_persona(id: &str, definition: &ExpertDefinition) -> String {
    format!(
        "<!-- role: expert:{} | {} -->\n\n{}\n\n---\n\n{}\n",
        id,
        definition.name,
        compile_persona_prefix(definition),
        compile_persona_suffix(definition)
    )
}

/// persona 前缀：进入系统提示的人格本体。
pub fn compile_persona_prefix(definition: &ExpertDefinition) -> String {
    // role 是空草稿时退化用 description：导入检查已把 role 降为非阻塞，
    // 人格本体不能再带一节光杆标题——那等于告诉模型「这个角色没有定位」。
    let role = if definition.role.trim().is_empty() {
        definition.description.trim().to_string()
    } else {
        definition.role.clone()
    };
    let mut sections = vec![
        format!("你是「{}」。", definition.name),
        String::new(),
        "## 角色定位".into(),
        role,
    ];
    if !definition.methodology.trim().is_empty() {
        sections.push("## 工作方法".into());
        sections.push(definition.methodology.trim().into());
    }
    if !definition.boundaries.trim().is_empty() {
        sections.push("## 行为边界".into());
        sections.push(definition.boundaries.trim().into());
    }
    if !definition.deliverables.trim().is_empty() {
        sections.push("## 交付物".into());
        sections.push(definition.deliverables.trim().into());
    }
    if !definition.stop_condition.trim().is_empty() {
        sections.push("## 停止条件".into());
        sections.push(definition.stop_condition.trim().into());
    }
    // 硬规则（LoopForge Role.Rules）：与「工作方法」分开，因为它是硬约束不是建议。
    if !definition.rules.trim().is_empty() {
        sections.push("## 硬规则".into());
        sections.push(definition.rules.trim().into());
    }
    if !definition.tags.is_empty() {
        sections.push("## 适用标签".into());
        sections.push(definition.tags.join("、"));
    }
    sections.join("\n")
}

/// persona 后缀：保留内核自带的行为约束，再补一条身份提醒与启动示例。
pub fn compile_persona_suffix(definition: &ExpertDefinition) -> String {
    let mut lines =
        vec!["请始终以以上专家身份回应，并在超出能力边界时明确说明，不要臆造。".to_string()];
    if !definition.examples.is_empty() {
        lines.push("可参考的启动示例：".into());
        for example in &definition.examples {
            lines.push(format!(
                "- {}：{}",
                example.title.as_deref().unwrap_or(&example.id),
                example.prompt.lines().next().unwrap_or("")
            ));
        }
    }
    lines.join("\n")
}

// ── 发布确认 ──────────────────────────────────────────────────

/// 模型自己给的 `confirmed: true`、复述的意图、prompt 文本都不是授权依据。
/// 只有「受信任的 UI 用户动作」能把 challenge 换成一次性 proof；
/// publish 消费 proof 时会重新比对内容摘要，内容一变就作废。
#[derive(Clone, Debug, Serialize)]
pub struct ConfirmationRequest {
    pub confirmation_token: String,
    pub expert_id: String,
    pub action: String,
    pub draft_revision: String,
    pub definition_digest: String,
    pub dependency_lock_digest: String,
    pub expires_at: u64,
    pub nonce: String,
}

/// proof 由命令层反序列化传入（形如 `{ "token": "…" }`），derive Deserialize 才能满足 Tauri 的 CommandArg 约束。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfirmationProof {
    pub token: String,
}

#[derive(Clone)]
struct ConfirmationRecord {
    request: ConfirmationRequest,
    definition_digest: String,
    dependency_lock_digest: String,
    confirmed: bool,
    consumed: bool,
}

/// 本地 xorshift：桌面端没有 CSPRNG 依赖，生成的是「不可预测而非密码学安全」的值。
/// 真正的防线是 TTL + 一次性消费 + 摘要重校验，token 本身只做关联用。
fn random_hex(len: usize) -> String {
    let mut state = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64 ^ 0x9e3779b97f4a7c15)
        .unwrap_or(0x2545f4914f6cdd1d);
    let mut out = String::with_capacity(len);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.push_str(&format!("{:02x}", (state >> 24) & 0xff));
    }
    out
}

pub struct ConfirmationStore {
    records: Mutex<HashMap<String, ConfirmationRecord>>,
}

impl Default for ConfirmationStore {
    fn default() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }
}

impl ConfirmationStore {
    /// 铸造一个绑定当前内容的 challenge。它本身**不授予**发布权限。
    pub fn request(
        &self,
        expert_id: &str,
        action: &str,
        draft_revision: &str,
        definition_digest: &str,
        dependency_lock_digest: &str,
    ) -> ConfirmationRequest {
        self.sweep();
        let nonce = random_hex(32);
        let request = ConfirmationRequest {
            confirmation_token: random_hex(32),
            expert_id: expert_id.to_string(),
            action: action.to_string(),
            draft_revision: draft_revision.to_string(),
            definition_digest: definition_digest.to_string(),
            dependency_lock_digest: dependency_lock_digest.to_string(),
            expires_at: now_ms() + CONFIRMATION_TTL_MS,
            nonce: nonce.clone(),
        };
        self.records.lock().unwrap().insert(
            request.confirmation_token.clone(),
            ConfirmationRecord {
                request: request.clone(),
                definition_digest: definition_digest.to_string(),
                dependency_lock_digest: dependency_lock_digest.to_string(),
                confirmed: false,
                consumed: false,
            },
        );
        request
    }

    /// 受信任的 UI 动作：把待确认的 challenge 换成一次性 proof。
    /// 先把 record 克隆出来再写回，避免「持有可变借用时又要删表项」的借用冲突。
    pub fn confirm(&self, token: &str) -> Result<ConfirmationProof, String> {
        let mut records = self.records.lock().unwrap();
        let mut record = records
            .get(token)
            .cloned()
            .ok_or_else(|| "experts/confirmation-stale".to_string())?;
        if record.request.expires_at < now_ms() {
            records.remove(token);
            return Err("experts/confirmation-stale".to_string());
        }
        record.confirmed = true;
        records.insert(token.to_string(), record);
        Ok(ConfirmationProof {
            token: token.to_string(),
        })
    }

    /// 在发布这个提交点上消费 proof：重新校验 principal / 有效期 / 内容摘要。
    pub fn consume(
        &self,
        proof: &ConfirmationProof,
        definition_digest: &str,
        dependency_lock_digest: &str,
    ) -> Result<(), String> {
        let mut records = self.records.lock().unwrap();
        let mut record = records
            .get(proof.token.as_str())
            .cloned()
            .ok_or_else(|| "experts/confirmation-required".to_string())?;
        if !record.confirmed {
            return Err("experts/confirmation-required".to_string());
        }
        if record.consumed {
            return Err("experts/confirmation-stale".to_string());
        }
        if record.request.expires_at < now_ms() {
            records.remove(proof.token.as_str());
            return Err("experts/confirmation-stale".to_string());
        }
        if record.definition_digest != definition_digest
            || record.dependency_lock_digest != dependency_lock_digest
        {
            return Err("experts/confirmation-stale".to_string());
        }
        // 先打 consumed 再删表项：两者任一路径失败都不会留下可重放的 proof。
        record.consumed = true;
        records.insert(proof.token.clone(), record);
        Ok(())
    }

    fn sweep(&self) {
        let now = now_ms();
        let mut records = self.records.lock().unwrap();
        records.retain(|_, r| r.request.expires_at >= now);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub fn confirmations() -> &'static ConfirmationStore {
    static STORE: OnceLock<ConfirmationStore> = OnceLock::new();
    STORE.get_or_init(ConfirmationStore::default)
}

// ── 存储 ──────────────────────────────────────────────────────

fn experts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("experts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn draft_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(experts_dir(app)?.join(format!("{id}.draft.json")))
}

fn published_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(experts_dir(app)?.join(format!("{id}.published.json")))
}

#[derive(Clone, Debug, Serialize)]
pub struct ExpertDraft {
    pub definition: ExpertDefinition,
    /// 草稿修订号：每次保存自增，用于前端判断内容是否被别人改过。
    pub revision: u32,
    pub digest: String,
    pub updated_at: u64,
    /// `local` / `imported`：编辑器要能看出这份定义的来路。
    pub source: String,
    /// 导入来源路径（仅 imported 有值）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<String>,
}

/// 最近一次带该专家身份的运行（journal 里 `expert_start` → `agent_settled`）。
#[derive(Clone, Debug, Serialize)]
pub struct ExpertLastRun {
    pub run_id: String,
    pub status: String,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExpertSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub role: String,
    pub tags: Vec<String>,
    pub published: bool,
    pub draft_revision: u32,
    pub digest: String,
    /// 允许工具数（0 = 不限制）。
    pub tool_count: usize,
    pub last_run: Option<ExpertLastRun>,
    /// `local`（本应用创建）或 `imported`（外部导入）。老草稿没有该键时按 local。
    pub source: String,
    /// 是否带真头像（`avatars/<id>.*` 存在）。前端据此决定拉 expert_avatar 还是首字。
    pub has_avatar: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExpertPublication {
    pub id: String,
    pub name: String,
    pub digest: String,
    pub revision: u32,
    /// persona 前缀与后缀合成后的文件路径。
    pub persona_path: String,
    /// 项目级策略文件路径（工具门读它）；未指定项目根时为 None。
    pub policy_path: Option<String>,
}

// ── 命令 ──────────────────────────────────────────────────────

/// 目录里一个 id 有草稿 + 发布两份文件；列表只按 id 出一条。
fn unique_expert_stems(files: Vec<PathBuf>) -> Vec<(PathBuf, String)> {
    let mut seen = HashSet::new();
    files
        .into_iter()
        .filter_map(|file| {
            let stem = file.file_stem().and_then(|s| s.to_str()).map(|s| {
                s.trim_end_matches(".draft")
                    .trim_end_matches(".published")
                    .to_string()
            })?;
            if !seen.insert(stem.clone()) {
                return None;
            }
            Some((file, stem))
        })
        .collect()
}

#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn experts_list(app: AppHandle) -> Vec<ExpertSummary> {
    let dir = match experts_dir(&app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let files: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    let last_runs = last_runs_by_expert(&app);
    let mut out = Vec::new();
    for (file, stem) in unique_expert_stems(files) {
        let draft = Some(file.with_file_name(format!("{stem}.draft.json")))
            .and_then(|p| read_definition(&p));
        let published = Some(file.with_file_name(format!("{stem}.published.json")))
            .and_then(|p| read_definition(&p));

        let definition = draft
            .as_ref()
            .map(|(d, _)| d.clone())
            .or_else(|| published.as_ref().map(|(d, _)| d.clone()));
        let Some(definition) = definition else {
            continue;
        };
        let digest = definition_digest(&definition);
        out.push(ExpertSummary {
            source: draft_source(&app, &stem),
            last_run: last_runs.get(&stem).cloned(),
            tool_count: definition.allowed_tools.len(),
            role: definition.role.clone(),
            has_avatar: avatar_file_for(&dir, &stem).is_some(),
            id: stem,
            name: definition.name.clone(),
            description: definition.description.clone(),
            tags: definition.tags.clone(),
            published: published.is_some(),
            draft_revision: draft.as_ref().map(|(_, r)| *r).unwrap_or(0),
            digest,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 专家策略文件：由内核扩展 `agent-tool-gate` 每次工具调用前读取。
pub(crate) fn expert_policy_path(root: &str) -> PathBuf {
    PathBuf::from(root)
        .join(".pi")
        .join("policy")
        .join("expert.json")
}

/// 落一份当前专家的运行策略。工具门只读这一份文件，不碰数据库。
pub(crate) fn write_expert_policy(
    root: &str,
    id: &str,
    definition: &ExpertDefinition,
) -> Result<String, String> {
    let path = expert_policy_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::json!({
        "expertId": id,
        "name": &definition.name,
        "allowedTools": &definition.allowed_tools,
        "deniedPatterns": &definition.denied_patterns,
        "stopCondition": &definition.stop_condition,
        "maxIterations": definition.max_iterations,
        // MCP 命名空间前缀（mcp__<server>__<tool>）：工具门按前缀放行/拦截。
        "mcpServers": &definition.mcp_servers,
        "updatedAt": now_ms(),
    });
    fs::write(
        &path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 发送时切换人格：与 `expert_publish` 同一条通道（`<root>/.pi/roles/current.md`）。
/// 发布只决定「谁可用」，**发送才决定「谁上场」**——只切工具门不切 persona，
/// 「发布 A 后选 B」会让 B 带着 A 的人格上场（十期运行链路核查抓出的真缺口）。
/// 必须走 `render_expert_persona`：缺 `<!-- role: -->` 头 = role-inject 直接跳过。
pub(crate) fn apply_expert_persona(
    root: &str,
    id: &str,
    definition: &ExpertDefinition,
) -> Result<(), String> {
    let file = PathBuf::from(root)
        .join(".pi")
        .join("roles")
        .join("current.md");
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, render_expert_persona(id, definition)).map_err(|e| e.to_string())
}

/// 不带专家的发送：收回人格控制权。`current.md` 是「本轮谁上场」的暂存位，
/// 上一轮专家覆写了它；这里把它还原成用户手选的全局角色（`global.md` sidecar，
/// 由 role_set 常驻维护）。没有 sidecar 才删除文件——删除必须只针对专家写下的内容，
/// 用户手动切的全局角色（`<!-- role: general -->` 等）不归专家链路管。
pub(crate) fn clear_expert_persona(root: &str) {
    let dir = PathBuf::from(root).join(".pi").join("roles");
    let current = dir.join("current.md");
    let Ok(text) = fs::read_to_string(&current) else {
        return;
    };
    let owned_by_expert = text
        .lines()
        .next()
        .unwrap_or_default()
        .starts_with("<!-- role: expert:");
    if !owned_by_expert {
        return; // 不是专家写的 = 用户的全局角色，不动。
    }
    match fs::read_to_string(dir.join("global.md")) {
        Ok(global) => {
            let _ = fs::write(&current, global);
        }
        Err(_) => {
            let _ = fs::remove_file(&current);
        }
    }
}

/// 运行期取专家定义：**只认已发布版本**。草稿是编辑态，不能上场——
/// 否则「发布」就没有意义（用户实证：发布跟没发布没区别）。
pub(crate) fn load_expert(app: &AppHandle, id: &str) -> Option<ExpertDefinition> {
    let dir = experts_dir(app).ok()?;
    published_definition(&dir, id)
}

/// 纯路径版发布门禁，便于回归测试：草稿存在也不兜底。
fn published_definition(dir: &Path, id: &str) -> Option<ExpertDefinition> {
    read_definition(&dir.join(format!("{id}.published.json"))).map(|(d, _)| d)
}

/// journal 里每个专家的最近一次运行：`expert_start` 绑定 runId，
/// 后续 `agent_settled` 给出结论。只读既有 journal，不新增存储。
fn last_runs_by_expert(app: &AppHandle) -> HashMap<String, ExpertLastRun> {
    let Some(path) = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(".pi").join("journal").join("events.jsonl"))
    else {
        return HashMap::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut owner: HashMap<String, String> = HashMap::new();
    let mut out: HashMap<String, ExpertLastRun> = HashMap::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let ty = value
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        let run_id = value
            .get("runId")
            .and_then(|r| r.as_str())
            .unwrap_or_default();
        if ty == "expert_start" && !run_id.is_empty() {
            if let Some(expert_id) = value.get("expertId").and_then(|i| i.as_str()) {
                owner.insert(run_id.to_string(), expert_id.to_string());
            }
        } else if ty == "agent_settled" && !run_id.is_empty() {
            let Some(expert_id) = owner.get(run_id) else {
                continue;
            };
            let status = value
                .get("runStatus")
                .and_then(|s| s.as_str())
                .unwrap_or("ok")
                .to_string();
            let at = value
                .get("pi_ts")
                .and_then(|t| t.as_u64())
                .or_else(|| value.get("runEndedAt").and_then(|t| t.as_u64()))
                .unwrap_or(0);
            out.insert(
                expert_id.clone(),
                ExpertLastRun {
                    run_id: run_id.to_string(),
                    status,
                    at,
                },
            );
        }
    }
    out
}

fn read_definition(path: &Path) -> Option<(ExpertDefinition, u32)> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let definition: ExpertDefinition =
        serde_json::from_value(value.get("definition")?.clone()).ok()?;
    let revision = value.get("revision").and_then(|r| r.as_u64()).unwrap_or(1) as u32;
    Some((definition, revision))
}

// ── 外部专家导入（WorkBuddy 插件格式） ─────────────────────────────
//
// 外部格式：`.codebuddy-plugin/plugin.json`（清单）+ `agents/*.md`（角色）。
// 角色 md = YAML frontmatter（name / displayName / profession）+ 二级标题章节
// （职责边界 / 工作方式 / 产出格式 / 停止条件）。这里只做一层最小映射，
// 映射不上的字段一律进 `unmapped_fields`，不静默丢弃。

#[derive(Clone, Debug, Serialize)]
pub struct ImportUnmappedField {
    pub field: String,
    pub reason: String,
}

/// 外部工具名与内核清单对不上时的一条待决策项。
#[derive(Clone, Debug, Serialize)]
pub struct ImportToolIssue {
    pub name: String,
    /// 能唯一落到内核清单里的候选（没有则为 null，由用户自己选）。
    pub suggestion: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportExpertPreview {
    /// 建议 id；冲突时前端仍可改成新 id。
    pub id: String,
    pub name: String,
    pub role: String,
    /// 已映射好的定义，前端只需处理工具映射与冲突。
    pub definition: ExpertDefinition,
    pub source_path: String,
    /// 成员清单里的头像源文件（绝对路径）；无图 / 超限时 None。
    /// apply 时复制到 `<experts>/avatars/<id>.<ext>`，展示走 expert_avatar。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_from: Option<String>,
    pub conflict: bool,
    pub unmapped_tools: Vec<ImportToolIssue>,
    pub unmapped_fields: Vec<ImportUnmappedField>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportPreview {
    pub source: String,
    pub plugin: Option<String>,
    /// 插件级未映射字段（技能引用、团队拓扑、头像等）。
    pub unmapped_fields: Vec<ImportUnmappedField>,
    pub experts: Vec<ImportExpertPreview>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportApplyItem {
    /// 最终落盘 id（改名由前端算好）。
    pub id: String,
    pub definition: ExpertDefinition,
    /// skip / overwrite / rename。缺省按 skip，避免误覆盖。
    #[serde(default)]
    pub conflict: String,
    #[serde(default)]
    pub source_path: String,
    /// 头像源文件（预览阶段的 avatar_from 原样带回）；落盘时复制进 avatars/。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_from: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportApplyResult {
    pub id: String,
    /// created / overwritten / skipped。
    pub action: String,
    pub source_path: String,
}

/// 前端声明的工具别名 → 内核工具名候选。只收实际出现过的写法。
fn tool_alias(raw: &str) -> Option<&'static str> {
    let key = raw
        .trim()
        .to_lowercase()
        .replace(['_', '-', ' ', '.'], "");
    Some(match key.as_str() {
        "read" | "readfile" | "view" | "viewfile" => "read",
        "write" | "writefile" | "createfile" => "write",
        "edit" | "editfile" | "strreplace" | "multistrreplace" | "applypatch" => "edit",
        "bash" | "shell" | "run" | "runcommand" | "terminal" | "exec" => "bash",
        "grep" | "rg" | "search" | "codebasesearch" | "codebasequery" => "grep",
        "glob" | "find" | "findfiles" | "listdir" => "glob",
        "ls" | "list" => "ls",
        "webfetch" | "fetch" | "fetchurl" => "webfetch",
        "websearch" | "searchweb" => "websearch",
        "todowrite" | "todo" => "todowrite",
        "task" | "agent" => "task",
        _ => return None,
    })
}

/// 只在候选确实存在于内核清单时才给建议。
fn suggest_tool(raw: &str, available: &[String]) -> Option<String> {
    let canonical = tool_alias(raw)?;
    let hit = available.iter().find(|t| {
        t.eq_ignore_ascii_case(canonical) || tool_alias(t) == Some(canonical)
    })?;
    Some(hit.clone())
}

fn sanitize_id(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// 极简 frontmatter 读取：只处理 `key: value`、`key: >-` 多行与一层缩进映射。
/// WorkBuddy 角色文件只需要 name / description / displayName / profession。
fn parse_frontmatter(text: &str) -> (HashMap<String, String>, String) {
    let mut out = HashMap::new();
    let Some(rest) = text.strip_prefix("---") else {
        return (out, text.to_string());
    };
    let mut lines = rest.lines();
    let mut body_start = None;
    let mut current_key = String::new();
    let mut current_indent = 0usize;
    let mut block: Vec<String> = Vec::new();
    let flush = |out: &mut HashMap<String, String>, key: &str, block: &mut Vec<String>| {
        if !key.is_empty() && !block.is_empty() {
            out.entry(key.to_string())
                .or_insert_with(|| block.join(" ").trim().to_string());
            block.clear();
        }
    };
    for (idx, line) in lines.by_ref().enumerate() {
        if line.trim() == "---" {
            body_start = Some(idx + 1);
            break;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if indent == 0 {
            flush(&mut out, &current_key, &mut block);
            if let Some((k, v)) = trimmed.split_once(':') {
                current_key = k.trim().to_lowercase();
                current_indent = 0;
                let value = v.trim();
                if !value.is_empty() && value != ">-" && value != "|" && value != ">" {
                    out.insert(current_key.clone(), value.trim_matches('"').trim_matches('\'').to_string());
                    current_key.clear();
                }
            }
        } else if !current_key.is_empty() {
            // 一层嵌套：displayName: / profession: 下面取 zh 优先，否则取第一个值。
            if indent == 2 || current_indent == 0 {
                current_indent = indent;
            }
            if let Some((k, v)) = trimmed.split_once(':') {
                let key = format!("{}.{}", current_key, k.trim().to_lowercase());
                let value = v.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    out.entry(key).or_insert_with(|| value.to_string());
                }
            } else {
                block.push(trimmed.trim_matches('"').to_string());
            }
        }
    }
    flush(&mut out, &current_key, &mut block);
    let consumed = body_start.unwrap_or(0);
    let body = rest
        .lines()
        .skip(consumed)
        .collect::<Vec<_>>()
        .join("\n");
    (out, body)
}

fn section_map(body: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some((h, lines)) = current.take() {
                out.push((h, lines.join("\n").trim().to_string()));
            }
            current = Some((rest.trim().to_string(), Vec::new()));
        } else if let Some((_, lines)) = current.as_mut() {
            lines.push(line.to_string());
        }
    }
    if let Some((h, lines)) = current {
        out.push((h, lines.join("\n").trim().to_string()));
    }
    out
}

/// 标题匹配**大小写不敏感**：WorkBuddy 缓存里大量英文角色文件
/// （## Workflow / ## Output Format / ## Boundaries），只认中文标题
/// 会让整段方法论漏映射，导入后字段全空、发布被必填项卡死。
fn find_section(sections: &[(String, String)], needles: &[&str]) -> Option<String> {
    sections
        .iter()
        .find(|(h, _)| {
            let lower = h.to_lowercase();
            needles.iter().any(|n| lower.contains(&n.to_lowercase()))
        })
        .map(|(_, body)| body.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 正文第一段非标题文本。intro 为空时的兜底：英文角色文件常把
/// 自我介绍写在第一个二级标题之后，只取 intro 会整段漏掉。
fn first_paragraph_text(body: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !lines.is_empty() {
                break;
            }
            continue;
        }
        if trimmed.starts_with('#') || trimmed == "---" {
            if !lines.is_empty() {
                break;
            }
            continue;
        }
        lines.push(trimmed);
    }
    lines.join(" ").trim().to_string()
}

/// 第一个二级标题之前的正文就是角色自我介绍。
fn intro_text(body: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            break;
        }
        if trimmed.starts_with("# ") || trimmed == "---" {
            continue;
        }
        lines.push(trimmed);
    }
    lines.join("\n").trim().to_string()
}

/// 正文里第一个一级标题的纯文本（去掉 `#` 与加粗标记）。
/// 角色文件没有 displayName/profession 时，这是成员自己的头衔——比包名准。
fn first_heading_text(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let text = rest
                .replace("**", "")
                .replace('《', "")
                .replace('》', "")
                .trim()
                .to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
        if trimmed.starts_with("## ") {
            break;
        }
    }
    None
}

fn parse_tool_list(value: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let inner = value.trim().trim_start_matches('[').trim_end_matches(']');
    for part in inner.split([',', '，', '、']) {
        let item = part.trim().trim_matches('"').trim_matches('\'').trim();
        if !item.is_empty() {
            out.push(item.to_string());
        }
    }
    out
}

/// 只从明确的「工具」章节里取工具名：反引号优先，其次是纯词项。
fn tools_from_sections(sections: &[(String, String)]) -> Vec<String> {
    let Some(body) = find_section(
        sections,
        &["可用工具", "允许工具", "工具策略", "工具清单", "tools"],
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in body.lines() {
        let mut rest = line.trim().trim_start_matches(['-', '*', '+']).trim();
        if let Some((_, after)) = rest.split_once('：') {
            rest = after.trim();
        }
        if rest.is_empty() || rest.starts_with('❌') {
            continue;
        }
        let mut found = false;
        for (idx, chunk) in rest.split('`').enumerate() {
            if idx % 2 == 1 {
                let token = chunk.trim();
                if !token.is_empty() {
                    out.push(token.to_string());
                    found = true;
                }
            }
        }
        if !found {
            for token in rest.split(['、', ',', '，', ' ']) {
                let token = token.trim().trim_start_matches('✅').trim();
                if !token.is_empty() && token.len() <= 40 {
                    out.push(token.to_string());
                }
            }
        }
    }
    out
}

fn localized_zh(value: &serde_json::Value) -> Option<String> {
    value
        .get("zh")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("en").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn plugin_file(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    for rel in [".codebuddy-plugin/plugin.json", "plugin.json"] {
        let candidate = path.join(rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn parse_agent_md(
    path: &Path,
    plugin: &serde_json::Value,
    available: &[String],
    pkg_root: &Path,
) -> Result<ImportExpertPreview, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("experts/import-unreadable: {e}"))?;
    let (fm, body) = parse_frontmatter(&text);
    let sections = section_map(&body);

    let raw_name = fm.get("name").cloned().unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("imported-expert")
            .to_string()
    });
    let id = sanitize_id(&raw_name);
    // 团队包的 plugin.json.members 是按 agent id 索引的成员元数据（真名 / 职能 / 头像）。
    // 角色文件本身往往只有机器 id，成员的可读身份全在这份清单里——不查它，
    // 一支团队导入后要么全员塌成包名，要么全是 sentiment-analyst 这种英文 slug。
    let member = plugin.get("members").and_then(|v| v.as_array()).and_then(|arr| {
        arr.iter().find(|m| {
            m.get("id").and_then(|v| v.as_str()) == Some(raw_name.as_str())
                || m.get("id").and_then(|v| v.as_str())
                    == Some(path.file_stem().and_then(|s| s.to_str()).unwrap_or(""))
        })
    });
    let member_name = member
        .and_then(|m| localized_zh(m.get("name").unwrap_or(&serde_json::Value::Null)))
        .unwrap_or_default();
    let member_profession = member
        .and_then(|m| localized_zh(m.get("profession").unwrap_or(&serde_json::Value::Null)))
        .unwrap_or_default();
    let display = fm
        .get("displayname.zh")
        .or_else(|| fm.get("displayname.en"))
        .cloned()
        .unwrap_or_default();
    // 厂商把品牌名塞进每个 agent 的 displayName（「鹏城信息AI专家」×3 包 =
    // 三张同名卡）。agent 的 displayName 与包级 displayName 一字不差时，
    // 它没提供任何身份信息——剔除，让回退链落到职能名。
    let pkg_display = localized_zh(plugin.get("displayName").unwrap_or(&serde_json::Value::Null))
        .unwrap_or_default();
    let display = if !pkg_display.is_empty() && display.trim() == pkg_display.trim() {
        String::new()
    } else {
        display
    };
    let profession = fm
        .get("profession.zh")
        .or_else(|| fm.get("profession.en"))
        .cloned()
        .unwrap_or_default();
    // 回退链：成员清单职能（「情绪分析师」，团队内天然唯一且是人话）
    // → 自身 displayName（与包品牌名相同的已剔除）→ 成员清单真名（「何执舟」）
    // → 自身 profession → 正文首个一级标题 → 自身 name 标识。
    // **永不回退到插件包 displayName**——那是团队/品牌名，
    // 一批包会塌成同一个（第一轮「交易分析团队」/第二轮「鹏城信息AI专家」真因）。
    let name = if !member_profession.trim().is_empty() {
        member_profession.clone()
    } else if !display.trim().is_empty() {
        display
    } else if !member_name.trim().is_empty() {
        member_name.clone()
    } else if !profession.trim().is_empty() {
        profession.clone()
    } else if let Some(h1) = first_heading_text(&body) {
        h1
    } else {
        raw_name.clone()
    };

    let description = fm
        .get("description")
        .cloned()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| localized_zh(plugin.get("displayDescription").unwrap_or(&serde_json::Value::Null)))
        .or_else(|| plugin.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    // 成员清单里的人格真名（何执舟）不与职能重复时，并进描述开头——
    // 卡片标题显示职能，描述保留人格名，两个信息都不丢。
    let description = if !member_name.trim().is_empty()
        && member_name.trim() != name.trim()
        && !description.is_empty()
    {
        format!("{}：{}", member_name.trim(), description)
    } else {
        description
    };
    // 头像：成员清单 avatar 是相对包根的路径（avatars/x.png）。文件缺失 / 超限
    // 不算错误——退回首字头像，导入不该因为一张图失败。
    let avatar_from = member
        .and_then(|m| m.get("avatar").and_then(|v| v.as_str()))
        .map(|rel| pkg_root.join(rel.trim_start_matches("./")))
        .filter(|p| {
            p.is_file()
                && fs::metadata(p).map(|m| m.len() <= AVATAR_MAX_BYTES).unwrap_or(false)
        })
        .map(|p| p.to_string_lossy().into_owned());

    let mut unmapped_fields: Vec<ImportUnmappedField> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let role = intro_text(&body);
    // intro 为空时兜底取第一段正文：英文角色文件常把自我介绍写在
    // 一级标题之后、第一个二级标题之前夹一空行，或直接开在首个 ## 段里。
    let role = if role.trim().is_empty() {
        first_paragraph_text(&body)
    } else {
        role
    };
    if role.trim().is_empty() {
        unmapped_fields.push(ImportUnmappedField {
            field: "role".into(),
            reason: "角色正文为空，已留空；不阻塞发布，但补一段角色定位会让这个人设更稳。".into(),
        });
    }
    let boundaries = find_section(
        &sections,
        &[
            "职责边界", "行为边界", "禁止", "不应做", "注意事项", "约束", "规则",
            "boundaries", "rules", "never", "constraints", "guardrails", "guideline",
        ],
    )
    .unwrap_or_default();
    if boundaries.trim().is_empty() {
        // 没有专门章节时，从正文里捞 ❌ / 禁止 条目，仍算映射成功。
        let picked: Vec<&str> = body
            .lines()
            .filter(|l| l.contains('❌') || l.contains("禁止") || l.contains("不得"))
            .collect();
        if picked.is_empty() {
            unmapped_fields.push(ImportUnmappedField {
                field: "boundaries".into(),
                reason: "未识别职责边界章节，已留空。".into(),
            });
        }
    }
    // 真实语料（WorkBuddy 市场包）的标题远比设想杂：「标准工作流」「工作流」
    // 「验证流程」「审查维度」「核心职责」「辩论指令」「Coding Process」……
    // 任何一支漏掉，导入后「工作方法」就是空的——发布被必填项卡死。
    // 两段式：强 needle 先扫；identity/mission 这类「人设段」只作兜底，
    // 否则 `## Core Identity` 会抢在 `## System Design Rules` 之前命中，
    // 把角色定位当方法论灌进来。
    let methodology = find_section(
        &sections,
        &[
            "工作方式", "工作方法", "工作流程", "工作流", "流程", "核心职责", "核心能力",
            "核心原则", "维度", "设计", "指令", "阶段门", "指标", "分析",
            "workflow", "method", "process", "approach", "principles", "how i work",
        ],
    )
    .or_else(|| find_section(&sections, &["identity", "mission"]))
    .unwrap_or_default();
    let deliverables = find_section(
        &sections,
        &[
            "产出", "交付", "产物", "报告", "报告结构", "输出",
            "output", "deliverable", "artifact", "format", "you produce",
        ],
    )
    .unwrap_or_default();
    let stop_condition = find_section(
        &sections,
        &[
            "停止条件", "状态块", "返回队长", "回传", "合格要求",
            "stop", "halt", "completion", "when to stop",
        ],
    )
    .unwrap_or_default();

    let mut allowed_tools = Vec::new();
    for key in ["tools", "allowedtools", "allowed_tools"] {
        if let Some(value) = fm.get(key) {
            allowed_tools.extend(parse_tool_list(value));
        }
    }
    allowed_tools.extend(tools_from_sections(&sections));
    allowed_tools = dedupe_strings(allowed_tools.into_iter());

    let mut unmapped_tools = Vec::new();
    for tool in &allowed_tools {
        if available.iter().any(|t| t == tool) {
            continue;
        }
        unmapped_tools.push(ImportToolIssue {
            name: tool.clone(),
            suggestion: suggest_tool(tool, available),
        });
    }
    if allowed_tools.is_empty() {
        warnings.push("角色未声明工具白名单，导入后不限制工具。".into());
    }

    let tags = plugin
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(localized_zh)
                .take(TAGS_MAX)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut imported = ExpertDefinition {
        name,
        description,
        role,
        methodology,
        boundaries: if boundaries.is_empty() {
            body.lines()
                .filter(|l| l.contains('❌') || l.contains("禁止") || l.contains("不得"))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            boundaries
        },
        deliverables,
        tags,
        examples: Vec::new(),
        skill_requirements: Vec::new(),
        allowed_tools,
        denied_patterns: Vec::new(),
        stop_condition,
        max_iterations: plugin
            .get("maxIterations")
            .or_else(|| plugin.get("max_iterations"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        // 导入阶段还没做工具决策，记录由前端在落盘前补进定义。
        tool_mapping: Vec::new(),
        // 外部格式没有执行器 / 模型 / 硬规则 / MCP 字段：导入后由用户在专家中心补。
        executor: None,
        model: None,
        rules: String::new(),
        mcp_servers: Vec::new(),
    };
    // 超长字段直接截到发布上限，并把截了哪些字段如实写进 warning——
    // 导入不该因为正文长就整体失败，也不该静默丢内容。
    for note in truncate_for_import(&mut imported) {
        warnings.push(note);
    }
    let definition = normalize_definition(&imported);

    Ok(ImportExpertPreview {
        id,
        name: definition.name.clone(),
        role: definition.role.clone(),
        definition,
        source_path: path.to_string_lossy().into_owned(),
        avatar_from: avatar_from.clone(),
        conflict: false,
        unmapped_tools,
        unmapped_fields,
        warnings,
    })
}

fn plugin_unmapped_fields(plugin: &serde_json::Value) -> Vec<ImportUnmappedField> {
    let mut out = Vec::new();
    let mut push = |key: &str, reason: &str| {
        if plugin.get(key).is_some() {
            out.push(ImportUnmappedField {
                field: key.to_string(),
                reason: reason.to_string(),
            });
        }
    };
    push("skills", "技能引用未映射：本应用没有专家级技能依赖字段。");
    push("teamInfo", "团队拓扑未映射：导入后每个角色是独立专家。");
    push("quickPrompts", "开箱提示词未映射：导入不写入对话预设。");
    push("defaultInitPrompt", "默认开场白未映射：导入不写入对话预设。");
    push("categoryId", "分类未映射：分类信息未进入专家定义。");
    push("version", "版本号未映射：草稿不记录外部版本。");
    push("author", "作者信息未映射：草稿不记录外部作者。");
    out
}

fn plugin_level_preview(path: &Path, available: &[String], app: Option<&AppHandle>) -> Result<ImportPreview, String> {
    let md_only = path.extension().and_then(|s| s.to_str()) == Some("md");
    let (plugin, plugin_path) = if md_only {
        (serde_json::Value::Null, None)
    } else {
        let file = plugin_file(path).ok_or_else(|| "experts/import-not-found".to_string())?;
        let text =
            fs::read_to_string(&file).map_err(|e| format!("experts/import-unreadable: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("experts/import-unreadable: {e}"))?;
        (value, Some(file))
    };
    let plugin_fields = plugin_unmapped_fields(&plugin);
    let base = plugin_path
        .as_deref()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .or_else(|| path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    // 包根：plugin.json 在 `.codebuddy-plugin/` 下时取上一层（avatars/ 在包根），
    // 手写导出目录（plugin.json 与 agents/ 同级）时 base 就是包根。
    let pkg_root = if plugin_path
        .as_deref()
        .and_then(|p| p.parent())
        .map(|p| p.file_name().map(|n| n == ".codebuddy-plugin").unwrap_or(false))
        .unwrap_or(false)
    {
        base.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| base.clone())
    } else {
        base.clone()
    };

    let agent_paths: Vec<PathBuf> = if md_only {
        vec![path.to_path_buf()]
    } else {
        plugin
            .get("agents")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|rel| {
                        let rel = rel.trim_start_matches("./");
                        // 实际插件把 agents 放在 `.codebuddy-plugin/agents` 下；
                        // 也兼容 agents 与 plugin.json 同级的手写导出目录。
                        let nested = base.join(rel);
                        if nested.exists() {
                            nested
                        } else {
                            base.parent().map(|p| p.join(rel)).unwrap_or(nested)
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    if agent_paths.is_empty() {
        return Err("experts/import-no-agents".to_string());
    }

    let mut experts = Vec::new();
    for agent in agent_paths {
        let mut preview = parse_agent_md(&agent, &plugin, available, &pkg_root)?;
        if let Some(app) = app {
            preview.conflict = experts_dir(app)
                .map(|dir| {
                    dir.join(format!("{}.draft.json", preview.id)).exists()
                        || dir.join(format!("{}.published.json", preview.id)).exists()
                })
                .unwrap_or(false);
        }
        experts.push(preview);
    }

    Ok(ImportPreview {
        source: path.to_string_lossy().into_owned(),
        plugin: plugin_path.map(|p| p.to_string_lossy().into_owned()),
        unmapped_fields: plugin_fields,
        experts,
    })
}

/// 事务化落草稿：先整体校验，再快照原文件，任何一步失败都恢复现场。
fn write_import_items(dir: &Path, items: &[ImportApplyItem]) -> Result<Vec<ImportApplyResult>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if sanitize_id(&item.id) != item.id || item.id.is_empty() {
            return Err(format!("experts/import-invalid-id: {}", item.id));
        }
        if !seen.insert(item.id.clone()) {
            return Err(format!("experts/import-duplicate-id: {}", item.id));
        }
        // 草稿允许不完整（与编辑器保存一致），但名称与字段上限必须成立；
        // 缺章节的情况已经在预览里逐条列出，不在这里静默补内容。
        if item.definition.name.trim().is_empty() {
            return Err(format!("experts/import-invalid: {} 名称不能为空。", item.id));
        }
        let issues = validate_definition(&item.definition);
        if let Some(issue) = issues.iter().find(|i| i.code == "definition/limit") {
            return Err(format!("experts/import-invalid: {} {}", item.id, issue.message));
        }
    }

    let mut results = Vec::new();
    let mut plan: Vec<(PathBuf, Option<String>, String)> = Vec::new();
    let mut planned_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in items {
        let path = dir.join(format!("{}.draft.json", item.id));
        let existing = fs::read_to_string(&path).ok();
        let published = dir.join(format!("{}.published.json", item.id)).exists();
        let exists = existing.is_some() || published;
        let action = if exists {
            match item.conflict.as_str() {
                "overwrite" | "rename" => "overwritten",
                _ => "skipped",
            }
        } else {
            "created"
        };
        if action == "skipped" {
            results.push(ImportApplyResult {
                id: item.id.clone(),
                action: action.into(),
                source_path: item.source_path.clone(),
            });
            continue;
        }
        let revision = existing
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|v| v.get("revision").and_then(|r| r.as_u64()))
            .unwrap_or(0)
            + 1;
        let body = serde_json::to_string_pretty(&serde_json::json!({
            "definition": normalize_definition(&item.definition),
            "revision": revision,
            "updated_at": now_ms(),
            "source": "imported",
            "imported_from": item.source_path,
            "imported_at": now_ms(),
        }))
        .map_err(|e| e.to_string())?;
        plan.push((path, existing, body));
        if item.avatar_from.is_some() {
            planned_ids.insert(item.id.clone());
        }
        results.push(ImportApplyResult {
            id: item.id.clone(),
            action: action.into(),
            source_path: item.source_path.clone(),
        });
    }

    // 头像先复制、草稿后写：任一草稿失败，把已复制的头像一并清掉，
    // 不留「有图无草稿」的孤儿文件。源文件缺失 / 读取失败只放弃头像——
    // 图没了退回首字头像，草稿没了才是真事故。
    let av_dir = dir.join("avatars");
    let mut copied_avatars: Vec<PathBuf> = Vec::new();
    for item in items.iter().filter(|i| planned_ids.contains(&i.id)) {
        let Some(src) = item.avatar_from.as_deref().map(Path::new) else { continue };
        let Some(ext) = src.extension().and_then(|e| e.to_str()) else { continue };
        if ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        if fs::create_dir_all(&av_dir).is_err() {
            break;
        }
        let dst = av_dir.join(format!("{}.{}", item.id, ext));
        if fs::copy(src, &dst).is_ok() {
            copied_avatars.push(dst);
        }
    }

    // 快照已经拍好；写失败时按快照回滚，避免出现「导入一半」的脏状态。
    let mut written: Vec<(PathBuf, Option<String>)> = Vec::new();
    for (path, previous, body) in &plan {
        if let Err(e) = fs::write(path, body) {
            for av in &copied_avatars {
                let _ = fs::remove_file(av);
            }
            for (done, old) in written.iter().rev() {
                match old {
                    Some(text) => {
                        let _ = fs::write(done, text);
                    }
                    None => {
                        let _ = fs::remove_file(done);
                    }
                }
            }
            return Err(format!("experts/import-write-failed: {e}"));
        }
        written.push((path.clone(), previous.clone()));
    }
    Ok(results)
}

fn source_of_dir(dir: &Path, id: &str) -> String {
    for name in [format!("{id}.draft.json"), format!("{id}.published.json")] {
        if let Ok(text) = fs::read_to_string(dir.join(name)) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if value.get("source").and_then(|s| s.as_str()) == Some("imported") {
                    return "imported".into();
                }
            }
        }
    }
    "local".into()
}

fn draft_source(app: &AppHandle, id: &str) -> String {
    match experts_dir(app) {
        Ok(dir) => source_of_dir(&dir, id),
        Err(_) => "local".into(),
    }
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn expert_import_preview(
    app: AppHandle,
    path: String,
    available_tools: Vec<String>,
) -> Result<ImportPreview, String> {
    let raw = path.trim();
    // 前端占位符是 `~/...`，这里展开 HOME；不展开会稳定报「找不到 plugin.json」。
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        std::env::var("HOME")
            .map(|home| Path::new(&home).join(rest))
            .unwrap_or_else(|_| Path::new(raw).to_path_buf())
    } else {
        Path::new(raw).to_path_buf()
    };
    plugin_level_preview(&expanded, &available_tools, Some(&app))
}

#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn expert_import_apply(
    app: AppHandle,
    items: Vec<ImportApplyItem>,
) -> Result<Vec<ImportApplyResult>, String> {
    let dir = experts_dir(&app)?;
    write_import_items(&dir, &items)
}

// ── WorkBuddy 专家缓存扫描 ────────────────────────────────────
//
// 手填路径导入一次只能带一个包，而且没人记得 `~/.workbuddy/plugins/cache/...`
// 的层级。扫描命令把整个缓存摊开：每个专家包一条，含团队拓扑（teamInfo），
// 前端逐包预览、勾选后批量落草稿，团队包再顺手建一支同名专家团。

/// 一个可导入的 WorkBuddy 专家包（缓存里的一个目录）。
#[derive(Clone, Debug, Serialize)]
pub struct ScanPackage {
    /// 包目录名（如 code-crew）。
    pub slug: String,
    /// 展示名（displayName.zh 优先）。
    pub name: String,
    /// 版本目录名（如 1.0.0）。
    pub version: String,
    /// 包根目录绝对路径（展开 ~ 后，可直接喂给 expert_import_preview）。
    pub path: String,
    /// 是否专家团（plugin.json 的 expertType == "team"）。
    pub is_team: bool,
    /// 团队牵头人 agent id（sanitize 后）；非团队为空。
    pub lead: Option<String>,
    /// 全部成员 agent id（含牵头人，顺序 = plugin.json agents 清单）。
    pub member_ids: Vec<String>,
    /// 逐 agent 的导入预览（与 expert_import_preview 同一形状）。
    pub experts: Vec<ImportExpertPreview>,
    /// 任一成员与现有专家重名。
    pub conflict: bool,
    /// 解析失败时的人话原因（成功为空；前端置灰该包但不清零清单）。
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanResult {
    /// 扫描根目录（展开后），前端展示用——「路径也没有」的答案就在这。
    pub root: String,
    pub packages: Vec<ScanPackage>,
}

/// WorkBuddy 专家缓存根目录。不存在返回 None（用户没装过 WorkBuddy）。
pub(crate) fn workbuddy_experts_root() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = Path::new(&home).join(".workbuddy/plugins/cache/experts");
    dir.is_dir().then_some(dir)
}

fn localized_field(v: &serde_json::Value, fallback: &str) -> String {
    localized_zh(v).unwrap_or_else(|| fallback.to_string())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn expert_import_scan(
    app: AppHandle,
    available_tools: Vec<String>,
) -> Result<ScanResult, String> {
    let Some(root) = workbuddy_experts_root() else {
        return Ok(ScanResult { root: String::new(), packages: Vec::new() });
    };
    let entries = fs::read_dir(&root).map_err(|e| format!("experts/scan-read: {e}"))?;

    let mut packages: Vec<ScanPackage> = Vec::new();
    for entry in entries.flatten() {
        let slug = entry.file_name().to_string_lossy().into_owned();
        // 每个包下可能有多个版本目录，取最新（字典序最大通常即最新，
        // 语义化版本在单 digit 段等价；多段版本按字符串比较已够扫描场景）。
        let Ok(versions) = fs::read_dir(entry.path()) else { continue };
        let mut version_dirs: Vec<PathBuf> = versions
            .flatten()
            .map(|v| v.path())
            .filter(|p| p.is_dir())
            .collect();
        version_dirs.sort();
        let Some(pkg_dir) = version_dirs.pop() else { continue };
        let version = pkg_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let mut pack = ScanPackage {
            slug: slug.clone(),
            name: slug.clone(),
            version,
            path: pkg_dir.to_string_lossy().into_owned(),
            is_team: false,
            lead: None,
            member_ids: Vec::new(),
            experts: Vec::new(),
            conflict: false,
            error: None,
        };

        match plugin_level_preview(&pkg_dir, &available_tools, Some(&app)) {
            Ok(preview) => {
                pack.experts = preview.experts;
                // 团队拓扑从 plugin.json 读（preview 不吞结构，但只映射 agent 级）。
                if let Some(file) = plugin_file(&pkg_dir) {
                    if let Ok(plugin) = fs::read_to_string(&file)
                        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t)
                            .map_err(Into::into))
                    {
                        pack.name = localized_field(
                            plugin.get("displayName").unwrap_or(&serde_json::Value::Null),
                            &slug,
                        );
                        pack.is_team = plugin
                            .get("expertType")
                            .and_then(|v| v.as_str())
                            == Some("team");
                        let lead_raw = plugin
                            .get("teamInfo")
                            .and_then(|t| t.get("leadAgent"))
                            .and_then(|v| v.as_str())
                            .or_else(|| plugin.get("agentName").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        pack.lead = (!lead_raw.is_empty()).then(|| sanitize_id(lead_raw));
                        pack.member_ids = pack.experts.iter().map(|e| e.id.clone()).collect();
                    }
                }
                pack.conflict = pack.experts.iter().any(|e| e.conflict);
                if !pack.is_team {
                    pack.lead = None;
                } else {
                    let lead_ok = pack
                        .lead
                        .as_ref()
                        .is_some_and(|l| pack.member_ids.contains(l));
                    if !lead_ok {
                        // 牵头人对不上成员：退回第一个成员，团队仍可导入。
                        pack.lead = pack.member_ids.first().cloned();
                    }
                }
            }
            Err(e) => pack.error = Some(e),
        }
        // 兜底：没读到任何 agent 时给出人话原因。
        if pack.experts.is_empty() && pack.error.is_none() {
            pack.error = Some("experts/import-no-agents".into());
        }
        packages.push(pack);
    }
    packages.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(ScanResult { root: root.to_string_lossy().into_owned(), packages })
}

#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn expert_draft_load(app: AppHandle, id: String) -> Result<Option<ExpertDraft>, String> {
    let path = draft_path(&app, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    let (definition, revision) =
        read_definition(&path).ok_or_else(|| "experts/draft-unreadable".to_string())?;
    let (_, imported_from, _) = read_draft_meta(&path);
    Ok(Some(ExpertDraft {
        digest: definition_digest(&definition),
        updated_at: fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(stamp_ms)
            .unwrap_or_default(),
        source: draft_source(&app, &id),
        imported_from,
        definition,
        revision,
    }))
}

/// 已知头像扩展名：与导入复制白名单一致。
const AVATAR_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];

fn avatar_file_for(dir: &Path, id: &str) -> Option<PathBuf> {
    let av = dir.join("avatars");
    AVATAR_EXTS
        .iter()
        .map(|ext| av.join(format!("{id}.{ext}")))
        .find(|p| p.is_file())
}

/// 专家头像：返回 `data:<mime>;base64,…`。没有图返回 None，前端退回首字头像。
/// 走 IPC 而不是 convertFileSrc：app_config_dir 不在内核允许的协议范围内。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn expert_avatar(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let dir = experts_dir(&app)?;
    let Some(path) = avatar_file_for(&dir, &id) else {
        return Ok(None);
    };
    let bytes = fs::read(&path).map_err(|e| format!("experts/avatar-read: {e}"))?;
    if bytes.len() > AVATAR_MAX_BYTES as usize {
        return Ok(None);
    }
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("png") {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Ok(Some(format!("data:{mime};base64,{}", crate::artifacts::base64_of(&bytes))))
}

/// 草稿外层元信息（与定义分开存）：保存时原样带回，避免编辑一次就丢掉导入来路。
fn read_draft_meta(path: &Path) -> (Option<String>, Option<String>, Option<u64>) {
    let Ok(text) = fs::read_to_string(path) else {
        return (None, None, None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (None, None, None);
    };
    (
        value
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        value
            .get("imported_from")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        value.get("imported_at").and_then(|v| v.as_u64()),
    )
}

fn stamp_ms(time: std::time::SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn expert_draft_save(
    app: AppHandle,
    id: String,
    definition: ExpertDefinition,
    expected_revision: Option<u32>,
) -> Result<ExpertDraft, String> {
    let path = draft_path(&app, &id)?;
    let previous = if path.exists() {
        read_definition(&path)
            .map(|(_, r): (ExpertDefinition, u32)| r)
            .unwrap_or(0)
    } else {
        0
    };
    if let Some(expected) = expected_revision {
        if previous != expected {
            return Err("experts/revision-conflict".to_string());
        }
    }
    let revision = previous + 1;
    let normalized = normalize_definition(&definition);
    let digest = definition_digest(&normalized);
    // 导入来路是外层元信息，不属于定义本身：这里显式带回，否则编辑一次就退化成「本地创建」。
    let (source, imported_from, imported_at) = read_draft_meta(&path);
    let body = draft_body(
        &normalized,
        revision,
        source.unwrap_or_else(|| "local".into()),
        imported_from.clone(),
        imported_at,
    );
    fs::write(
        &path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(ExpertDraft {
        definition: normalized,
        revision,
        digest,
        updated_at: now_ms(),
        source: draft_source(&app, &id),
        imported_from,
    })
}

fn draft_body(
    definition: &ExpertDefinition,
    revision: u32,
    source: String,
    imported_from: Option<String>,
    imported_at: Option<u64>,
) -> serde_json::Value {
    serde_json::json!({
        "definition": definition,
        "revision": revision,
        "updated_at": now_ms(),
        "source": source,
        "imported_from": imported_from,
        "imported_at": imported_at,
    })
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_validate(definition: ExpertDefinition) -> Vec<DomainIssue> {
    validate_definition(&definition)
}

/// 专家中心详情：一次给全「定义 + 编译后 persona + 执行配置」。
///
/// LoopForge 的做法是让用户能看见角色实际会以什么形态被调用，而不是只给一段
/// 提示词。这里照抄这个思路：prompt 前缀 / 后缀 / 全文、以及执行器 / 模型 / MCP
/// 全部返回，前端只读展示；只有提示词类字段可编辑。
#[derive(Clone, Debug, Serialize)]
pub struct ExpertPersonaPreview {
    pub prefix: String,
    pub suffix: String,
    pub full: String,
    /// 执行器：None = 跟随内核默认。
    pub executor: Option<String>,
    pub model: Option<String>,
    pub mcp_servers: Vec<String>,
    pub skill_names: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub denied_patterns: Vec<String>,
    pub max_iterations: Option<u32>,
    /// 是否已启用反废话纪律（当前全局开关状态）。
    pub terse_enforced: bool,
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_persona_preview(definition: ExpertDefinition) -> ExpertPersonaPreview {
    let prefix = compile_persona_prefix(&definition);
    let suffix = compile_persona_suffix(&definition);
    ExpertPersonaPreview {
        full: format!("{prefix}\n\n---\n\n{suffix}\n"),
        prefix,
        suffix,
        executor: definition.executor.clone(),
        model: definition.model.clone(),
        mcp_servers: definition.mcp_servers.clone(),
        skill_names: definition
            .skill_requirements
            .iter()
            .map(|s| s.name.clone())
            .collect(),
        allowed_tools: definition.allowed_tools.clone(),
        denied_patterns: definition.denied_patterns.clone(),
        max_iterations: definition.max_iterations,
        terse_enforced: crate::agent_style::TERSE_ENABLED,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn expert_request_confirmation(
    id: String,
    draft_revision: u32,
    definition_digest: String,
) -> Result<ConfirmationRequest, String> {
    // 依赖锁摘要：本应用暂无外部依赖锁，用空串占位；
    // 将来接了 skill 依赖清单，这里换成对应摘要即可，发布链路无需改动。
    let dependency_lock_digest = String::new();
    Ok(confirmations().request(
        &id,
        "publish",
        &draft_revision.to_string(),
        &definition_digest,
        &dependency_lock_digest,
    ))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_confirm(token: String) -> Result<ConfirmationProof, String> {
    confirmations().confirm(&token)
}

#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn expert_publish(
    app: AppHandle,
    id: String,
    proof: ConfirmationProof,
    root: Option<String>,
) -> Result<ExpertPublication, String> {
    let (definition, revision) = read_definition(&draft_path(&app, &id)?)
        .ok_or_else(|| "experts/draft-not-found".to_string())?;
    let digest = definition_digest(&definition);
    confirmations().consume(&proof, &digest, "")?;
    // 只有阻塞项（空名称/描述、超限、模板花括号）拦发布；definition/notice
    // （空角色定位/边界/方法论/交付物）放行——强制必填让大批导入草稿发不出去，
    // 不如让它可见地缺着。
    let blocking = validate_definition(&definition)
        .into_iter()
        .filter(|i| i.code != "definition/notice")
        .count();
    if blocking > 0 {
        return Err("experts/invalid-definition".to_string());
    }

    // 落盘到项目级 .pi/roles/current.md，与 role_set 同一条通道。
    // ⚠️ 必须带 `<!-- role: ... -->` 头（render_expert_persona 保证）：
    // role-inject 扩展缺头直接跳过，人格就不会进系统提示。
    let persona = render_expert_persona(&id, &definition);
    let persona_path = match root.as_deref() {
        Some(root) if !root.trim().is_empty() => {
            let file = PathBuf::from(root)
                .join(".pi")
                .join("roles")
                .join("current.md");
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&file, &persona).map_err(|e| e.to_string())?;
            file.to_string_lossy().into_owned()
        }
        _ => {
            let file = experts_dir(&app)?.join(format!("{id}.persona.md"));
            fs::write(&file, &persona).map_err(|e| e.to_string())?;
            file.to_string_lossy().into_owned()
        }
    };

    // 项目级策略：工具门每次调用前读，发布会后立即按新白名单执行。
    let policy_path = match root.as_deref().filter(|r| !r.trim().is_empty()) {
        Some(root) => Some(write_expert_policy(root, &id, &definition)?),
        None => None,
    };

    fs::write(
        published_path(&app, &id)?,
        serde_json::to_string_pretty(&serde_json::json!({
            "definition": definition,
            "revision": revision,
            "digest": digest,
            "published_at": now_ms(),
        }))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(ExpertPublication {
        id,
        name: definition.name,
        digest,
        revision,
        persona_path,
        policy_path,
    })
}

/// 删除专家：只清草稿 / 已发布 / persona 与指向它的策略文件。
/// journal 是历史记录，不属于专家实体，一律不碰。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn expert_delete(app: AppHandle, id: String, root: Option<String>) -> Result<(), String> {
    let dir = experts_dir(&app)?;
    for file in [
        dir.join(format!("{id}.draft.json")),
        dir.join(format!("{id}.published.json")),
        dir.join(format!("{id}.persona.md")),
    ] {
        if file.exists() {
            fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
    }
    let Some(root) = root.filter(|r| !r.trim().is_empty()) else {
        return Ok(());
    };
    let policy = expert_policy_path(&root);
    let owned = fs::read_to_string(&policy)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value
                .get("expertId")
                .and_then(|v| v.as_str())
                .map(|v| v == id)
        })
        .unwrap_or(false);
    if owned {
        let _ = fs::remove_file(&policy);
    }
    // persona 只在确实是这位专家发布的时候清掉，避免误删别人的角色文件。
    // 首行是 `<!-- role: expert:<id> | <name> -->` 头，按 id 前缀判定归属。
    let persona = PathBuf::from(&root)
        .join(".pi")
        .join("roles")
        .join("current.md");
    if let Ok(text) = fs::read_to_string(&persona) {
        let first = text.lines().next().unwrap_or_default();
        if first.starts_with(&format!("<!-- role: expert:{id} |")) {
            let _ = fs::remove_file(&persona);
        }
    }
    // 头像跟着专家走：删定义不删图 = 目录里堆一堆无主的 png。
    if let Ok(dir) = experts_dir(&app) {
        let av = dir.join("avatars");
        for ext in ["png", "jpg", "jpeg", "webp", "gif", "svg"] {
            let _ = fs::remove_file(av.join(format!("{id}.{ext}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ExpertDefinition {
        ExpertDefinition {
            name: "代码评审专家".into(),
            description: "按团队规范做代码评审".into(),
            role: "你是资深评审者".into(),
            methodology: "先看 diff 再看上下文，结论先行".into(),
            boundaries: "不改文件，只给结论".into(),
            deliverables: "评审意见清单".into(),
            tags: vec!["review".into()],
            examples: vec![ExpertExample {
                id: "e1".into(),
                title: Some("审一个 PR".into()),
                prompt: "帮我评审这个 PR".into(),
            }],
            skill_requirements: vec![],
            allowed_tools: vec!["read".into(), "grep".into()],
            denied_patterns: vec!["git push".into()],
            stop_condition: "给出结论后停止".into(),
            max_iterations: Some(8),
            tool_mapping: vec![],
            executor: None,
            model: None,
            rules: String::new(),
            mcp_servers: vec![],
        }
    }

    fn issue_codes(issues: &[DomainIssue]) -> Vec<&str> {
        issues.iter().map(|i| i.code.as_str()).collect()
    }

    #[test]
    fn runtime_expert_requires_published_definition() {
        let dir = std::env::temp_dir().join(format!("pi-expert-gate-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut definition = sample();
        definition.name = "Gated Expert".into();
        let body = serde_json::json!({
            "definition": definition,
            "revision": 1,
            "digest": "d".repeat(16),
        })
        .to_string();
        // 只有草稿：运行期必须拒绝。
        std::fs::write(dir.join("gated.draft.json"), &body).unwrap();
        assert!(published_definition(&dir, "gated").is_none());
        // 发布后：同一 id 立即变为可上场。
        std::fs::write(dir.join("gated.published.json"), &body).unwrap();
        let def = published_definition(&dir, "gated").expect("published expert must load");
        assert_eq!(def.name, "Gated Expert");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn expert_list_dedupes_draft_and_published_files() {
        let files = vec![
            PathBuf::from("a.draft.json"),
            PathBuf::from("a.published.json"),
            PathBuf::from("b.draft.json"),
        ];
        let stems: Vec<String> = unique_expert_stems(files)
            .into_iter()
            .map(|(_, stem)| stem)
            .collect();
        assert_eq!(stems, vec!["a", "b"]);
    }

    /// 回归（截图真因）：英文角色文件的章节标题（## Workflow / ## Output
    /// Format / ## Boundaries）必须映射进来，否则导入后方法论/交付物全空，
    /// 发布被必填项卡死。
    #[test]
    fn english_role_file_sections_are_mapped() {
        let base = std::env::temp_dir().join(format!("pi-expert-en-{}", now_ms()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("eng.md"),
            r#"---
name: frontend-eng
description: Frontend engineer
---

# Frontend Engineer

You are **Frontend Engineer**, a specialist in modern web UI frameworks.

## Workflow

1. Inspect the existing code first.
2. Implement incrementally.

## Output Format

Return a summary plus the diff.

## Boundaries

- Never fabricate test results.

## Stop Condition

Stop when the build passes.
"#,
        )
        .unwrap();
        let preview = plugin_level_preview(&base.join("eng.md"), &["read".to_string()], None).unwrap();
        let expert = &preview.experts[0];
        assert!(expert.definition.role.contains("Frontend Engineer"), "role={}", expert.definition.role);
        assert!(expert.definition.methodology.contains("Inspect"), "methodology 漏映射英文 Workflow");
        assert!(expert.definition.deliverables.contains("diff"), "deliverables 漏映射 Output Format");
        assert!(expert.definition.boundaries.contains("fabricate"), "boundaries 漏映射 Boundaries");
        assert!(expert.definition.stop_condition.contains("build passes"), "stop 漏映射 Stop Condition");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归（2026-11-22 截图真因）：WorkBuddy 市场包 code-crew 的「审查员 Ray」
    /// 方法论段叫「## 审查维度（按优先级）」——旧 needle 一个都不沾，导入后
    /// 「工作方法」恒空。同理「## 标准工作流」（队长）、「## 审查报告结构」
    /// 要落到交付物。
    #[test]
    fn workbuddy_marketplace_headings_are_mapped() {
        let base = std::env::temp_dir().join(format!("pi-expert-mkt-{}", now_ms()));
        let plugin_dir = base.join(".codebuddy-plugin");
        let agents_dir = plugin_dir.join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::json!({
                "name": "code-crew",
                "version": "1.0.0",
                "agents": ["./agents/reviewer.md", "./agents/lead.md"]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("reviewer.md"),
            r#"---
name: code-reviewer
description: 审查员 Ray
---

# 审查员 — Ray

你是代码小队的审查员 Ray。

## 职责边界

- ❌ **不改任何代码**

## 审查维度（按优先级）

1. **正确性** — 逻辑错误、边界遗漏
2. **安全** — 注入、越权

## 审查报告结构

1. **总体结论** — `APPROVE` / `REQUEST_CHANGES`

## 返回队长的状态块

STATUS: PASS / FAIL
"#,
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("lead.md"),
            r#"---
name: code-crew-team-lead
description: 队长 Horizon
---

# 队长 — Horizon

你是代码小队的队长。

## 团队协作机制（铁律）

只调度不亲自写。

## 标准工作流

1. 拆解任务 2. 派发 3. 验收 4. 收口
"#,
        )
        .unwrap();
        let preview = plugin_level_preview(&base, &["read".to_string()], None).unwrap();
        let reviewer = preview.experts.iter().find(|e| e.id == "code-reviewer").unwrap();
        assert!(
            reviewer.definition.methodology.contains("正确性"),
            "methodology 漏映射「审查维度」：{}",
            reviewer.definition.methodology
        );
        assert!(reviewer.definition.boundaries.contains("不改任何代码"));
        assert!(reviewer.definition.deliverables.contains("APPROVE"), "deliverables 漏映射「报告结构」");
        assert!(reviewer.definition.stop_condition.contains("STATUS"), "stop 漏映射「返回队长的状态块」");
        let lead = preview.experts.iter().find(|e| e.id == "code-crew-team-lead").unwrap();
        assert!(
            lead.definition.methodology.contains("拆解任务"),
            "methodology 漏映射「标准工作流」：{}",
            lead.definition.methodology
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 人设段（Core Identity / Your Core Mission）只能兜底：software-company
    /// 的英文角色文件里 `## Core Identity` 排在 `## Coding Process` 之前，
    /// 若与人设 needle 同批扫描会把角色定位误灌进方法论。
    #[test]
    fn persona_section_is_fallback_only_for_methodology() {
        let base = std::env::temp_dir().join(format!("pi-expert-persona-{}", now_ms()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("eng.md"),
            r#"---
name: software-engineer
description: SDE
---

# Software Engineer

## Core Identity

You are a senior engineer.

## Coding Process

1. Read the code first.
2. Then patch minimally.
"#,
        )
        .unwrap();
        let preview = plugin_level_preview(&base.join("eng.md"), &["read".to_string()], None).unwrap();
        let expert = &preview.experts[0];
        assert!(expert.definition.methodology.contains("Read the code"), "流程段应优先于人设段");
        assert!(!expert.definition.methodology.contains("senior engineer"), "人设段不应混进方法论");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 纯人设文件（只有 Core Identity）兜底仍要生效，不能倒退回全空。
    #[test]
    fn persona_section_fallback_still_catches_identity_only_files() {
        let base = std::env::temp_dir().join(format!("pi-expert-persona2-{}", now_ms()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("pm.md"),
            r#"---
name: pm
description: PM
---

# PM

## Core Identity

You are a product manager who writes PRDs first.
"#,
        )
        .unwrap();
        let preview = plugin_level_preview(&base.join("pm.md"), &["read".to_string()], None).unwrap();
        let expert = &preview.experts[0];
        assert!(expert.definition.methodology.contains("product manager"), "人设兜底失效");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_complete_definition_passes_validation() {
        assert!(validate_definition(&sample()).is_empty());
    }

    /// 必填只剩名称与描述：这两项空了卡片没法渲染、清单没法检索。
    #[test]
    fn missing_name_or_description_is_required() {
        let mut def = sample();
        def.name = "   ".into();
        let issues = validate_definition(&def);
        assert!(issue_codes(&issues).contains(&"definition/required"));
        assert!(issues
            .iter()
            .any(|i| i.path.as_deref() == Some("name")));
    }

    /// 角色定位 / 行为边界 / 工作方法 / 交付物为空只给非阻塞提示（definition/notice），
    /// 不再卡发布——外部角色文件段式千奇百怪，必填让大批导入草稿发不出去，
    /// 「发布」按钮形同虚设（用户截图：persona 207 tokens 有肉，role 字段却空着）。
    #[test]
    fn empty_prose_sections_are_notices_not_required() {
        let mut def = sample();
        def.role = "   ".into();
        def.boundaries = "".into();
        def.methodology = "   ".into();
        def.deliverables = "".into();
        let issues = validate_definition(&def);
        let codes = issue_codes(&issues);
        assert!(codes.contains(&"definition/notice"));
        assert!(!codes.contains(&"definition/required"));
        assert!(issues.iter().any(|i| i.path.as_deref() == Some("role")));
    }

    #[test]
    fn literal_template_braces_are_rejected() {
        let mut def = sample();
        def.role = "你是 {{expert}}".into();
        let issues = validate_definition(&def);
        assert!(issue_codes(&issues).contains(&"definition/template-braces"));
    }

    #[test]
    fn duplicate_tags_and_example_ids_are_reported() {
        let mut def = sample();
        def.tags = vec!["review".into(), " review ".into()];
        def.examples.push(ExpertExample {
            id: "e1".into(),
            title: None,
            prompt: "再来一条".into(),
        });
        let issues = validate_definition(&def);
        let codes = issue_codes(&issues);
        assert!(codes.contains(&"definition/duplicate-tag"));
        assert!(codes.contains(&"definition/duplicate-example-id"));
    }

    #[test]
    fn over_long_name_is_reported() {
        let mut def = sample();
        def.name = "x".repeat(NAME_MAX + 1);
        let issues = validate_definition(&def);
        assert!(issue_codes(&issues).contains(&"definition/limit"));
    }

    #[test]
    fn normalization_makes_spacing_insensitive_digests() {
        let mut spaced = sample();
        spaced.role = format!("  {}\n", sample().role);
        spaced.examples[0].prompt = format!("{}\n", sample().examples[0].prompt);
        spaced.tags = vec!["review".into(), "".into()];
        assert_eq!(definition_digest(&sample()), definition_digest(&spaced));
    }

    #[test]
    fn digest_changes_when_content_changes() {
        let mut def = sample();
        def.role = "你是另一类评审者".into();
        assert_ne!(definition_digest(&sample()), definition_digest(&def));
    }

    #[test]
    fn allowed_tools_are_trimmed_and_deduped() {
        let mut input = sample();
        input.allowed_tools = vec![" read ".into(), "read".into(), "".into(), "bash".into()];
        let normalized = normalize_definition(&input);
        assert_eq!(
            normalized.allowed_tools,
            vec!["read".to_string(), "bash".to_string()]
        );
    }

    #[test]
    fn iteration_cap_is_validated() {
        let mut def = sample();
        def.max_iterations = Some(MAX_ITERATIONS_CAP + 1);
        assert!(issue_codes(&validate_definition(&def)).contains(&"definition/limit"));
        def.max_iterations = Some(0);
        assert!(issue_codes(&validate_definition(&def)).contains(&"definition/limit"));
        def.max_iterations = Some(1);
        assert!(validate_definition(&def).is_empty());
    }

    #[test]
    fn policy_file_roundtrip_matches_definition() {
        let dir = std::env::temp_dir().join(format!("pi-expert-policy-{}", now_ms()));
        let root = dir.to_string_lossy().to_string();
        let path = write_expert_policy(&root, "code-reviewer", &sample()).unwrap();
        assert_eq!(path, expert_policy_path(&root).to_string_lossy());
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["expertId"], "code-reviewer");
        assert_eq!(value["allowedTools"], serde_json::json!(["read", "grep"]));
        assert_eq!(value["deniedPatterns"], serde_json::json!(["git push"]));
        assert_eq!(value["maxIterations"], 8);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persona_prefix_includes_stop_condition() {
        assert!(compile_persona_prefix(&sample()).contains("## 停止条件"));
    }

    #[test]
    fn persona_prefix_carries_role_and_constraints() {
        let prefix = compile_persona_prefix(&sample());
        assert!(prefix.contains("你是「代码评审专家」"));
        assert!(prefix.contains("## 角色定位"));
        assert!(prefix.contains("## 行为边界"));
        assert!(prefix.contains("## 交付物"));
    }

    #[test]
    fn persona_suffix_lists_start_examples() {
        let suffix = compile_persona_suffix(&sample());
        assert!(suffix.contains("不要臆造"));
        assert!(suffix.contains("审一个 PR"));
    }

    /// 回归（运行流程真 bug）：发布落盘的 persona 必须带 role-inject 认得的
    /// `<!-- role: expert:<id> | <name> -->` 头——缺头时扩展直接跳过整份文件，
    /// 人格从未注入系统提示，只有工具门生效（「选了专家像个没选一样」）。
    #[test]
    fn rendered_persona_carries_role_inject_header() {
        let persona = render_expert_persona("code-review", &sample());
        assert!(
            persona.starts_with("<!-- role: expert:code-review | 代码评审专家 -->"),
            "首行必须是 role 头：{persona}"
        );
        assert!(persona.contains("你是「代码评审专家」"));
    }

    /// 回归（十期运行链路核查）：发送时必须整份覆写 current.md——
    /// 只切工具门不切 persona，「发布 A 后选 B」会让 B 带着 A 的人格上场。
    /// 并且取消专家后要还原用户手选的全局角色，不是简单删文件。
    #[test]
    fn send_time_persona_switch_restores_global_role() {
        let root = std::env::temp_dir().join(format!("pi-expert-persona-{}", now_ms()));
        let dir = root.join(".pi").join("roles");
        std::fs::create_dir_all(&dir).unwrap();
        let current = dir.join("current.md");
        let global = dir.join("global.md");
        // 用户先手选了一个全局角色（模拟 role_set 的双写）。
        std::fs::write(&current, "<!-- role: general | 通用助手 -->\n\n通用提示\n").unwrap();
        std::fs::write(&global, "<!-- role: general | 通用助手 -->\n\n通用提示\n").unwrap();

        let mut def = sample();
        def.name = "评审乙".into();
        apply_expert_persona(&root.to_string_lossy(), "reviewer-b", &def).unwrap();
        let after = std::fs::read_to_string(&current).unwrap();
        assert!(
            after.starts_with("<!-- role: expert:reviewer-b | 评审乙 -->"),
            "发送后 current.md 必须是该专家的人格：{after}"
        );
        // 全局角色没被吃掉：sidecar 原样在。
        assert!(std::fs::read_to_string(&global).unwrap().contains("通用提示"));

        // 不带专家的发送 = 收回专家人格，还原用户的全局角色。
        clear_expert_persona(&root.to_string_lossy());
        let restored = std::fs::read_to_string(&current).unwrap();
        assert!(
            restored.starts_with("<!-- role: general |"),
            "取消专家后应还原全局角色，而不是静默丢失：{restored}"
        );

        // 没有 sidecar 时（用户从没切过角色），取消专家 = 删除专家写下的文件。
        std::fs::remove_file(&global).unwrap();
        apply_expert_persona(&root.to_string_lossy(), "reviewer-b", &def).unwrap();
        clear_expert_persona(&root.to_string_lossy());
        assert!(!current.exists(), "无全局角色可还原时应删除专家人格");

        // 非专家写下的 current.md 绝不动它。
        std::fs::write(&current, "<!-- role: aider-programmer | Aider -->\n\n正文\n").unwrap();
        clear_expert_persona(&root.to_string_lossy());
        assert!(std::fs::read_to_string(&current).unwrap().contains("aider-programmer"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confirmation_requires_an_explicit_user_confirm() {
        let store = ConfirmationStore::default();
        let req = store.request("e1", "publish", "1", "digest-a", "");
        assert_eq!(
            store.consume(
                &ConfirmationProof {
                    token: req.confirmation_token.clone()
                },
                "digest-a",
                ""
            ),
            Err("experts/confirmation-required".to_string())
        );
        let proof = store
            .confirm(&req.confirmation_token)
            .expect("UI 确认应通过");
        assert!(store.consume(&proof, "digest-a", "").is_ok());
    }

    #[test]
    fn publishing_a_stale_digest_is_rejected() {
        let store = ConfirmationStore::default();
        let req = store.request("e1", "publish", "1", "digest-a", "");
        let proof = store.confirm(&req.confirmation_token).unwrap();
        // 用户在确认后又改了草稿 —— 旧授权作废，必须重新确认。
        assert_eq!(
            store.consume(&proof, "digest-b", ""),
            Err("experts/confirmation-stale".to_string())
        );
    }

    #[test]
    fn a_proof_can_only_be_used_once() {
        let store = ConfirmationStore::default();
        let req = store.request("e1", "publish", "1", "digest-a", "");
        let proof = store.confirm(&req.confirmation_token).unwrap();
        assert!(store.consume(&proof, "digest-a", "").is_ok());
        // 已消费的 proof 再用一次必须被拒：实现把它当「凭证过期」处理，前端提示「请重新确认」。
        assert_eq!(
            store.consume(&proof, "digest-a", "").err(),
            Some("experts/confirmation-stale".to_string())
        );
    }

    #[test]
    fn an_unknown_or_confirmation_less_token_is_refused() {
        let store = ConfirmationStore::default();
        // ConfirmationProof 只携带不可比较的 String，这里断言错误码而不是整体相等。
        assert_eq!(
            store.confirm("nope").err(),
            Some("experts/confirmation-stale".to_string())
        );
    }

    #[test]
    fn random_hex_is_long_and_stable_in_length() {
        let a = random_hex(32);
        let b = random_hex(32);
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "两次生成不应相同，否则 token 可被枚举");
    }

    fn write_workbuddy_fixture(dir: &Path) {
        let plugin_dir = dir.join(".codebuddy-plugin");
        let agents_dir = plugin_dir.join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::json!({
                "name": "code-crew",
                "version": "1.0.0",
                "expertType": "team",
                "displayName": { "en": "Code Crew", "zh": "代码小队" },
                "displayDescription": { "en": "team", "zh": "一支代码调查小队" },
                "agents": ["./agents/investigator.md"],
                "tags": [{ "en": "code", "zh": "代码" }],
                "skills": ["graphify"],
                "quickPrompts": ["查一下这个报错"]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("investigator.md"),
            r#"---
name: code-investigator
description: 调查代码库里的调用链
displayName:
  en: Investigator
  zh: 调查员
profession:
  zh: 代码调查专家
tools: [read_file, web_search, mystery_tool]
---

你是代码小队里的调查员，负责把调用链查清楚。

## 职责边界

- ✅ 只读代码与日志
- ❌ 不修改任何文件

## 工作方式

先定位入口，再向上追调用者。

## 产出格式

给出调用链、证据文件与结论。

## 停止条件

状态为 done 时返回。
"#,
        )
        .unwrap();
    }

    #[test]
    fn workbuddy_preview_maps_sections_and_flags_unmapped_items() {
        let base = std::env::temp_dir().join(format!("pi-expert-import-{}", now_ms()));
        write_workbuddy_fixture(&base);
        let available = vec!["read".to_string(), "bash".to_string(), "grep".to_string()];
        let preview = plugin_level_preview(&base, &available, None).unwrap();

        assert_eq!(preview.experts.len(), 1);
        let expert = &preview.experts[0];
        assert_eq!(expert.id, "code-investigator");
        assert_eq!(expert.name, "调查员");
        assert!(expert.definition.role.contains("调查员"));
        assert!(expert.definition.methodology.contains("调用者"));
        assert!(expert.definition.boundaries.contains("不修改"));
        assert!(expert.definition.deliverables.contains("调用链"));
        assert!(expert.definition.stop_condition.contains("done"));
        assert_eq!(
            expert.definition.allowed_tools,
            vec!["read_file", "web_search", "mystery_tool"]
        );
        // 别名能落到内核清单的给出建议；落不上的留空让用户自己选。
        assert_eq!(expert.unmapped_tools[0].suggestion.as_deref(), Some("read"));
        assert_eq!(expert.unmapped_tools[1].suggestion, None);
        assert_eq!(expert.unmapped_tools[2].suggestion, None);
        // 插件级不支持的字段必须显式列出，不静默丢弃。
        let fields: Vec<&str> = preview.unmapped_fields.iter().map(|f| f.field.as_str()).collect();
        assert!(fields.contains(&"skills"));
        assert!(fields.contains(&"version"));
        assert!(fields.contains(&"quickPrompts"));
        let _ = std::fs::remove_dir_all(&base);
    }

    fn import_item(id: &str, conflict: &str, name: &str) -> ImportApplyItem {
        let mut def = sample();
        def.name = name.to_string();
        ImportApplyItem {
            id: id.into(),
            definition: def,
            conflict: conflict.into(),
            source_path: "/tmp/workbuddy".into(),
            avatar_from: None,
        }
    }

    #[test]
    fn import_apply_creates_skips_overwrites_and_renames() {
        let dir = std::env::temp_dir().join(format!("pi-expert-apply-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let existing = serde_json::json!({
            "definition": sample(),
            "revision": 3,
            "updated_at": 1,
        })
        .to_string();
        std::fs::write(dir.join("demo.draft.json"), &existing).unwrap();
        std::fs::write(dir.join("keep.draft.json"), &existing).unwrap();

        let results = write_import_items(
            &dir,
            &[
                import_item("fresh", "skip", "新专家"),
                import_item("keep", "skip", "不覆盖"),
                import_item("demo", "overwrite", "覆盖后的专家"),
                import_item("demo-imported", "rename", "改名后的专家"),
            ],
        )
        .unwrap();
        let actions: Vec<(&str, &str)> = results
            .iter()
            .map(|r| (r.id.as_str(), r.action.as_str()))
            .collect();
        assert_eq!(
            actions,
            vec![
                ("fresh", "created"),
                ("keep", "skipped"),
                ("demo", "overwritten"),
                ("demo-imported", "created"),
            ]
        );

        // 跳过项保留原内容（名称仍是样例名）。
        let keep: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("keep.draft.json")).unwrap())
                .unwrap();
        assert_eq!(keep["definition"]["name"], sample().name);
        assert!(keep.get("source").is_none());
        let demo: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("demo.draft.json")).unwrap())
                .unwrap();
        assert_eq!(demo["definition"]["name"], "覆盖后的专家");
        assert_eq!(demo["revision"], 4);
        assert_eq!(demo["source"], "imported");
        assert_eq!(source_of_dir(&dir, "demo"), "imported");
        assert_eq!(source_of_dir(&dir, "keep"), "local");
        assert!(dir.join("fresh.draft.json").exists());
        assert!(dir.join("demo-imported.draft.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_mapping_decisions_persist_in_draft() {
        let dir = std::env::temp_dir().join(format!("pi-expert-mapping-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut item = import_item("mapped-expert", "skip", "带映射记录的专家");
        item.definition.tool_mapping = vec![
            ToolMappingEntry {
                from: "read_file".into(),
                to: Some("read".into()),
                // 故意写错的 decision 应被规范化成 mapped。
                decision: "ignored".into(),
            },
            ToolMappingEntry {
                from: "web_search".into(),
                to: None,
                decision: "mapped".into(),
            },
        ];
        write_import_items(&dir, &[item]).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("mapped-expert.draft.json")).unwrap())
                .unwrap();
        let mapping = value["definition"]["tool_mapping"].as_array().unwrap();
        assert_eq!(mapping[0]["from"], "read_file");
        assert_eq!(mapping[0]["to"], "read");
        assert_eq!(mapping[0]["decision"], "mapped");
        assert_eq!(mapping[1]["from"], "web_search");
        assert!(mapping[1].get("to").is_none(), "忽略项不写 to");
        assert_eq!(mapping[1]["decision"], "ignored");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn draft_body_preserves_import_provenance() {
        let body = draft_body(
            &sample(),
            2,
            "imported".into(),
            Some("/tmp/sample-plugin".into()),
            Some(1234),
        );
        assert_eq!(body["revision"], 2);
        assert_eq!(body["source"], "imported");
        assert_eq!(body["imported_from"], "/tmp/sample-plugin");
        assert_eq!(body["imported_at"], 1234);
    }

    #[test]
    fn import_validation_failure_leaves_no_partial_files() {
        let dir = std::env::temp_dir().join(format!("pi-expert-rollback-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = write_import_items(
            &dir,
            &[
                import_item("alpha", "skip", "先写这个"),
                import_item("beta", "skip", "   "),
            ],
        )
        .unwrap_err();
        assert!(err.starts_with("experts/import-invalid"));
        // 整体校验在写盘之前完成，第一项也不能落盘。
        assert!(!dir.join("alpha.draft.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn single_role_markdown_can_be_imported() {
        let base = std::env::temp_dir().join(format!("pi-expert-md-{}", now_ms()));
        write_workbuddy_fixture(&base);
        let md = base.join(".codebuddy-plugin/agents/investigator.md");
        let preview = plugin_level_preview(&md, &["read".to_string()], None).unwrap();
        assert_eq!(preview.experts.len(), 1);
        assert_eq!(preview.experts[0].name, "调查员");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归（截图真因）：团队成员没有自身 displayName/profession 时，
    /// 名字必须落在自己的正文标题上，不能塌成插件包名——否则一支团队
    /// 所有成员同名，列表与下拉全是重复。
    #[test]
    fn team_member_without_display_name_keeps_own_heading() {
        let base = std::env::temp_dir().join(format!("pi-expert-dup-{}", now_ms()));
        let agents_dir = base.join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            base.join("plugin.json"),
            serde_json::json!({
                "name": "deep-research",
                "version": "1.0.0",
                "expertType": "team",
                "displayName": { "en": "Deep Research", "zh": "深度研究团队" },
                "agents": ["./agents/planner.md", "./agents/researcher.md"]
            })
            .to_string(),
        )
        .unwrap();
        // 两个成员都没有 displayName / profession，只有各自的正文一级标题。
        std::fs::write(
            agents_dir.join("planner.md"),
            "---\nname: research-planner\ndescription: plan\n---\n\n# 研究编辑\n\n你是研究编辑。\n",
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("researcher.md"),
            "---\nname: topic-researcher\ndescription: scout\n---\n\n# 课题研究员\n\n你是课题研究员。\n",
        )
        .unwrap();
        let preview = plugin_level_preview(&base, &["read".to_string()], None).unwrap();
        let names: Vec<&str> = preview.experts.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["研究编辑", "课题研究员"]);
        assert!(!names.contains(&"深度研究团队"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归（第二轮截图真因）：团队包 plugin.json.members 带成员真名 / 职能 / 头像时，
    /// 导入必须优先用成员清单——角色文件往往只有机器 id（sentiment-analyst），
    /// 可读身份全在 members 数组里。头像文件存在时给出 avatar_from。
    #[test]
    fn team_members_manifest_provides_name_and_avatar() {
        let base = std::env::temp_dir().join(format!("pi-expert-members-{}", now_ms()));
        let agents_dir = base.join("agents");
        let avatars_dir = base.join("avatars");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::create_dir_all(&avatars_dir).unwrap();
        std::fs::write(
            base.join("plugin.json"),
            serde_json::json!({
                "name": "trading-agent",
                "version": "1.0.0",
                "expertType": "team",
                "displayName": { "en": "Trading Analysis Team", "zh": "交易分析团队" },
                "agents": ["./agents/sentiment-analyst.md", "./agents/bull-researcher.md"],
                "members": [
                    {
                        "id": "sentiment-analyst",
                        "name": { "en": "Wen", "zh": "温知势" },
                        "profession": { "en": "Sentiment Analyst", "zh": "情绪分析师" },
                        "avatar": "avatars/sentiment.png",
                        "role": "member"
                    },
                    {
                        "id": "bull-researcher",
                        "name": { "en": "Mo", "zh": "牧长风" },
                        "profession": { "en": "Bull Researcher", "zh": "多头研究员" },
                        "avatar": "avatars/missing.png",
                        "role": "member"
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(avatars_dir.join("sentiment.png"), [0x89u8, b'P', b'N', b'G']).unwrap();
        // 角色文件没有 displayName / profession，只有机器 id。
        std::fs::write(
            agents_dir.join("sentiment-analyst.md"),
            "---\nname: sentiment-analyst\ndescription: 分析情绪面\n---\n\n你是一位市场情绪分析师。\n",
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("bull-researcher.md"),
            "---\nname: bull-researcher\ndescription: 多头论证\n---\n\n你是一位多头研究员。\n",
        )
        .unwrap();
        let preview = plugin_level_preview(&base, &["read".to_string()], None).unwrap();
        // 职能优先：团队内天然唯一、是人话，比人格名更适合做列表标题。
        assert_eq!(preview.experts[0].name, "情绪分析师");
        assert_eq!(preview.experts[1].name, "多头研究员");
        // 人格真名并进描述，两个信息都不丢。
        assert!(preview.experts[0].definition.description.starts_with("温知势："));
        // 头像：文件存在 → 给出源路径；文件缺失 → None（退回首字头像，不报错）。
        assert!(preview.experts[0].avatar_from.as_deref().unwrap().ends_with("avatars/sentiment.png"));
        assert!(preview.experts[1].avatar_from.is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归（第三轮截图真因）：厂商包把品牌名写进每个 agent 的 displayName
    /// （fullstack-dev / frontend / web 全是「鹏城信息AI专家」）——agent 的
    /// displayName 与包级一字不差时不提供身份信息，必须剔除并落到职能名。
    #[test]
    fn vendor_brand_in_agent_display_is_stripped() {
        let base = std::env::temp_dir().join(format!("pi-expert-brand-{}", now_ms()));
        let agents_dir = base.join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            base.join("plugin.json"),
            serde_json::json!({
                "name": "fullstack-dev",
                "version": "1.0.0",
                "expertType": "agent",
                "displayName": { "en": "PCXX AI Expert", "zh": "鹏城信息AI专家" },
                "agents": ["./agents/fullstack-dev.md", "./agents/web.md"]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("fullstack-dev.md"),
            "---\nname: fullstack-dev\ndescription: full stack\ndisplayName:\n  en: \"PCXX AI Expert\"\n  zh: \"鹏城信息AI专家\"\nprofession:\n  zh: 全栈开发专家\n---\n\n你是一位资深全栈开发专家。\n",
        )
        .unwrap();
        // 另一个 agent 的 displayName 与包名不同（真名），保留。
        std::fs::write(
            agents_dir.join("web.md"),
            "---\nname: web\ndescription: web dev\ndisplayName:\n  zh: 网站开发专家\nprofession:\n  zh: 网站开发与部署专家\n---\n\n你是经验丰富的 Web 开发专家。\n",
        )
        .unwrap();
        let preview = plugin_level_preview(&base, &["read".to_string()], None).unwrap();
        assert_eq!(preview.experts[0].name, "全栈开发专家", "品牌名 displayName 必须剔除，落到 profession");
        assert_eq!(preview.experts[1].name, "网站开发专家", "与包名不同的自身 displayName 保留");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 头像复制进 avatars/ 并随失败回滚清理；删除专家时头像一并消失。
    #[test]
    fn import_copies_avatar_and_rollback_removes_it() {
        let dir = std::env::temp_dir().join(format!("pi-expert-avatar-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let src_dir = std::env::temp_dir().join(format!("pi-expert-avatar-src-{}", now_ms()));
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("face.png");
        std::fs::write(&src, [0x89u8, b'P', b'N', b'G']).unwrap();

        let mut ok_item = import_item("with-face", "skip", "带头像的专家");
        ok_item.avatar_from = Some(src.to_string_lossy().into_owned());
        let bad_item = import_item("no-name", "skip", "   ");
        // beta 名称为空 → 整体校验先失败，任何文件都不该落盘。
        let err = write_import_items(&dir, &[ok_item.clone(), bad_item]).unwrap_err();
        assert!(err.starts_with("experts/import-invalid"));
        assert!(!dir.join("with-face.draft.json").exists());
        assert!(!dir.join("avatars/with-face.png").exists());

        // 单独成功导入：头像落到 avatars/<id>.<ext>。
        write_import_items(&dir, &[ok_item]).unwrap();
        assert!(dir.join("avatars/with-face.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    /// 本机装过 WorkBuddy 时，用真实样例跑一遍预览 + 落盘。
    /// 默认忽略（依赖本机数据），验收时手动执行：
    /// `cargo test local_workbuddy -- --ignored`
    #[test]
    #[ignore]
    fn local_workbuddy_sample_previews_and_imports() {
        let Some(home) = std::env::var_os("HOME") else { return };
        let base = Path::new(&home).join(".workbuddy/plugins/cache/experts/code-crew/1.0.0");
        if !base.exists() {
            return;
        }
        let available: Vec<String> = ["read", "write", "edit", "bash", "grep", "glob", "webfetch"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let preview = plugin_level_preview(&base, &available, None).unwrap();
        assert!(!preview.experts.is_empty());
        let dir = std::env::temp_dir().join(format!("pi-expert-local-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let items: Vec<ImportApplyItem> = preview
            .experts
            .iter()
            .map(|e| ImportApplyItem {
                id: e.id.clone(),
                definition: e.definition.clone(),
                conflict: "skip".into(),
                source_path: e.source_path.clone(),
                avatar_from: e.avatar_from.clone(),
            })
            .collect();
        let results = write_import_items(&dir, &items).unwrap();
        assert!(results.iter().all(|r| r.action == "created"));
        for item in &items {
            assert_eq!(source_of_dir(&dir, &item.id), "imported");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
