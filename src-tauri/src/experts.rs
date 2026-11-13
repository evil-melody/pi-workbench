use std::collections::HashMap;
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
/// 发布定义的总字节上限（32 KiB）。
const PUBLISHED_MAX_BYTES: usize = 32 * 1024;

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

fn push_required(issues: &mut Vec<DomainIssue>, path: &str, label: &str, value: &str) {
    if value.trim().is_empty() {
        issues.push(DomainIssue {
            code: "definition/required".into(),
            path: Some(path.into()),
            message: format!("{label}不能为空。"),
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
    push_required(&mut issues, "role", "角色定位", &candidate.role);
    push_required(
        &mut issues,
        "methodology",
        "工作方法",
        &candidate.methodology,
    );
    push_required(&mut issues, "boundaries", "行为边界", &candidate.boundaries);
    push_required(
        &mut issues,
        "deliverables",
        "交付物",
        &candidate.deliverables,
    );

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

/// persona 前缀：进入系统提示的人格本体。
pub fn compile_persona_prefix(definition: &ExpertDefinition) -> String {
    let mut sections = vec![
        format!("你是「{}」。", definition.name),
        String::new(),
        "## 角色定位".into(),
        definition.role.clone(),
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
    for file in files {
        let Some(stem) = file.file_stem().and_then(|s| s.to_str()).map(|s| {
            s.trim_end_matches(".draft")
                .trim_end_matches(".published")
                .to_string()
        }) else {
            continue;
        };
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
        "updatedAt": now_ms(),
    });
    fs::write(
        &path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 运行期取专家定义：已发布优先，其次草稿。
pub(crate) fn load_expert(app: &AppHandle, id: &str) -> Option<ExpertDefinition> {
    if let Ok(path) = published_path(app, id) {
        if let Some((definition, _)) = read_definition(&path) {
            return Some(definition);
        }
    }
    draft_path(app, id)
        .ok()
        .and_then(|path| read_definition(&path))
        .map(|(definition, _)| definition)
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

fn find_section(sections: &[(String, String)], needles: &[&str]) -> Option<String> {
    sections
        .iter()
        .find(|(h, _)| needles.iter().any(|n| h.contains(n)))
        .map(|(_, body)| body.trim().to_string())
        .filter(|s| !s.is_empty())
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
        &["可用工具", "允许工具", "工具策略", "工具清单", "Tools"],
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
    let display = fm
        .get("displayname.zh")
        .or_else(|| fm.get("displayname.en"))
        .cloned()
        .unwrap_or_default();
    let profession = fm
        .get("profession.zh")
        .or_else(|| fm.get("profession.en"))
        .cloned()
        .unwrap_or_default();
    let name = if !display.trim().is_empty() {
        display
    } else if !profession.trim().is_empty() {
        profession.clone()
    } else {
        localized_zh(plugin.get("displayName").unwrap_or(&serde_json::Value::Null))
            .unwrap_or(raw_name.clone())
    };

    let description = fm
        .get("description")
        .cloned()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| localized_zh(plugin.get("displayDescription").unwrap_or(&serde_json::Value::Null)))
        .or_else(|| plugin.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();

    let mut unmapped_fields: Vec<ImportUnmappedField> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let role = intro_text(&body);
    if role.trim().is_empty() {
        unmapped_fields.push(ImportUnmappedField {
            field: "role".into(),
            reason: "角色正文为空，已留空；发布前需要补一段角色定位。".into(),
        });
    }
    let boundaries = find_section(&sections, &["职责边界", "行为边界", "禁止"]).unwrap_or_default();
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
    let methodology = find_section(&sections, &["工作方式", "工作方法", "工作流程", "核心原则"])
        .unwrap_or_default();
    let deliverables = find_section(&sections, &["产出", "交付", "报告结构", "输出"])
        .unwrap_or_default();
    let stop_condition = find_section(&sections, &["停止条件", "状态块", "返回队长"]).unwrap_or_default();

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

    let definition = normalize_definition(&ExpertDefinition {
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
    });

    Ok(ImportExpertPreview {
        id,
        name: definition.name.clone(),
        role: definition.role.clone(),
        definition,
        source_path: path.to_string_lossy().into_owned(),
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
    push("members", "成员展示信息未映射：只保留角色文件里的名称与职责。");
    push("quickPrompts", "开箱提示词未映射：导入不写入对话预设。");
    push("defaultInitPrompt", "默认开场白未映射：导入不写入对话预设。");
    push("avatar", "头像未映射：专家列表不展示外部头像。");
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
        let mut preview = parse_agent_md(&agent, &plugin, available)?;
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
        results.push(ImportApplyResult {
            id: item.id.clone(),
            action: action.into(),
            source_path: item.source_path.clone(),
        });
    }

    // 快照已经拍好；写失败时按快照回滚，避免出现「导入一半」的脏状态。
    let mut written: Vec<(PathBuf, Option<String>)> = Vec::new();
    for (path, previous, body) in &plan {
        if let Err(e) = fs::write(path, body) {
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
    if !validate_definition(&definition).is_empty() {
        return Err("experts/invalid-definition".to_string());
    }

    let persona = format!(
        "{}\n\n---\n\n{}\n",
        compile_persona_prefix(&definition),
        compile_persona_suffix(&definition)
    );
    // 落盘到项目级 .pi/roles/current.md，与 role_set 同一条通道，
    // Pi 的 role-inject 扩展每轮读取并追加到系统提示，切换即时生效。
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
    // 先取名字：删除文件后就没法确认 persona 是不是这位专家的了。
    let name = read_definition(&dir.join(format!("{id}.published.json")))
        .or_else(|| read_definition(&dir.join(format!("{id}.draft.json"))))
        .map(|(definition, _)| definition.name)
        .unwrap_or_default();
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
    let persona = PathBuf::from(&root)
        .join(".pi")
        .join("roles")
        .join("current.md");
    if let Ok(text) = fs::read_to_string(&persona) {
        let first = text.lines().next().unwrap_or_default();
        if !name.is_empty() && first == format!("你是「{name}」。") {
            let _ = fs::remove_file(&persona);
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
        }
    }

    fn issue_codes(issues: &[DomainIssue]) -> Vec<&str> {
        issues.iter().map(|i| i.code.as_str()).collect()
    }

    #[test]
    fn a_complete_definition_passes_validation() {
        assert!(validate_definition(&sample()).is_empty());
    }

    #[test]
    fn missing_required_sections_are_reported_with_path() {
        let mut def = sample();
        def.methodology = "   ".into();
        let issues = validate_definition(&def);
        assert!(issue_codes(&issues).contains(&"definition/required"));
        assert!(issues
            .iter()
            .any(|i| i.path.as_deref() == Some("methodology")));
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
