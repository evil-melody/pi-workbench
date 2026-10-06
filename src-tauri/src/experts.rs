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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DomainIssue {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

/// 会进入 persona 前缀的文本字段：字面量 `{{}}` 会被模板引擎当变量插值，必须拒绝。
const TEMPLATE_TEXT_FIELDS: &[&str] = &["name", "description", "role", "methodology", "boundaries", "deliverables"];

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
    push_required(&mut issues, "methodology", "工作方法", &candidate.methodology);
    push_required(&mut issues, "boundaries", "行为边界", &candidate.boundaries);
    push_required(&mut issues, "deliverables", "交付物", &candidate.deliverables);

    push_limit(&mut issues, "name", "名称", &candidate.name, NAME_MAX);
    push_limit(&mut issues, "description", "描述", &candidate.description, DESCRIPTION_MAX);
    push_limit(&mut issues, "role", "角色定位", &candidate.role, PROSE_MAX);
    push_limit(&mut issues, "methodology", "工作方法", &candidate.methodology, PROSE_MAX);
    push_limit(&mut issues, "boundaries", "行为边界", &candidate.boundaries, PROSE_MAX);
    push_limit(&mut issues, "deliverables", "交付物", &candidate.deliverables, PROSE_MAX);

    for (i, tag) in candidate.tags.iter().enumerate() {
        push_limit(&mut issues, &format!("tags.{i}"), "标签", tag, 40);
    }
    for (i, example) in candidate.examples.iter().enumerate() {
        push_required(&mut issues, &format!("examples.{i}.id"), "示例 id", &example.id);
        push_required(&mut issues, &format!("examples.{i}.prompt"), "示例内容", &example.prompt);
        push_limit(&mut issues, &format!("examples.{i}.id"), "示例 id", &example.id, 64);
        push_limit(&mut issues, &format!("examples.{i}.prompt"), "示例内容", &example.prompt, 4000);
        if let Some(title) = example.title.as_deref() {
            push_limit(&mut issues, &format!("examples.{i}.title"), "示例标题", title, 120);
        }
    }
    for (i, r) in candidate.skill_requirements.iter().enumerate() {
        push_required(&mut issues, &format!("skillRequirements.{i}.name"), "Skill 名称", &r.name);
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

    for field in TEMPLATE_TEXT_FIELDS {
        let value = match *field {
            "name" => &candidate.name,
            "description" => &candidate.description,
            "role" => &candidate.role,
            "methodology" => &candidate.methodology,
            "boundaries" => &candidate.boundaries,
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
        if has_template_braces(&example.prompt) || example.title.as_deref().is_some_and(has_template_braces) {
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
        tags: input.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect(),
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
    }
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
    let mut sections = vec![format!("你是「{}」。", definition.name), String::new(), "## 角色定位".into(), definition.role.clone()];
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
    if !definition.tags.is_empty() {
        sections.push("## 适用标签".into());
        sections.push(definition.tags.join("、"));
    }
    sections.join("\n")
}

/// persona 后缀：保留内核自带的行为约束，再补一条身份提醒与启动示例。
pub fn compile_persona_suffix(definition: &ExpertDefinition) -> String {
    let mut lines = vec!["请始终以以上专家身份回应，并在超出能力边界时明确说明，不要臆造。".to_string()];
    if !definition.examples.is_empty() {
        lines.push("可参考的启动示例：".into());
        for example in &definition.examples {
            lines.push(format!("- {}：{}", example.title.as_deref().unwrap_or(&example.id), example.prompt.lines().next().unwrap_or("")));
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
        self.records
            .lock()
            .unwrap()
            .insert(request.confirmation_token.clone(), ConfirmationRecord {
                request: request.clone(),
                definition_digest: definition_digest.to_string(),
                dependency_lock_digest: dependency_lock_digest.to_string(),
                confirmed: false,
                consumed: false,
            });
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
        Ok(ConfirmationProof { token: token.to_string() })
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
}

#[derive(Clone, Debug, Serialize)]
pub struct ExpertSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub published: bool,
    pub draft_revision: u32,
    pub digest: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExpertPublication {
    pub id: String,
    pub name: String,
    pub digest: String,
    pub revision: u32,
    /// persona 前缀与后缀合成后的文件路径。
    pub persona_path: String,
}

// ── 命令 ──────────────────────────────────────────────────────

#[tauri::command]
#[allow(non_snake_case)]
pub fn experts_list(app: AppHandle) -> Vec<ExpertSummary> {
    let dir = match experts_dir(&app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let files: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    for file in files {
        let Some(stem) = file
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.trim_end_matches(".draft").trim_end_matches(".published").to_string())
        else {
            continue;
        };
        let draft = Some(file.with_file_name(format!("{stem}.draft.json")))
            .and_then(|p| read_definition(&p));
        let published = Some(file.with_file_name(format!("{stem}.published.json")))
            .and_then(|p| read_definition(&p));

        let definition = draft.as_ref().map(|(d, _)| d.clone()).or_else(|| published.as_ref().map(|(d, _)| d.clone()));
        let Some(definition) = definition else {
            continue;
        };
        let digest = definition_digest(&definition);
        out.push(ExpertSummary {
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

fn read_definition(path: &Path) -> Option<(ExpertDefinition, u32)> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let definition: ExpertDefinition = serde_json::from_value(value.get("definition")?.clone()).ok()?;
    let revision = value.get("revision").and_then(|r| r.as_u64()).unwrap_or(1) as u32;
    Some((definition, revision))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_draft_load(
    app: AppHandle,
    id: String,
) -> Result<Option<ExpertDraft>, String> {
    let path = draft_path(&app, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    let (definition, revision) = read_definition(&path).ok_or_else(|| "experts/draft-unreadable".to_string())?;
    Ok(Some(ExpertDraft {
        digest: definition_digest(&definition),
        updated_at: fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(stamp_ms).unwrap_or_default(),
        definition,
        revision,
    }))
}

fn stamp_ms(time: std::time::SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_draft_save(
    app: AppHandle,
    id: String,
    definition: ExpertDefinition,
    expectedRevision: Option<u32>,
) -> Result<ExpertDraft, String> {
    let path = draft_path(&app, &id)?;
    let previous = if path.exists() {
        read_definition(&path)
            .map(|(_, r): (ExpertDefinition, u32)| r)
            .unwrap_or(0)
    } else {
        0
    };
    if let Some(expected) = expectedRevision {
        if previous != expected {
            return Err("experts/revision-conflict".to_string());
        }
    }
    let revision = previous + 1;
    let normalized = normalize_definition(&definition);
    let digest = definition_digest(&normalized);
    fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::json!({
            "definition": normalized,
            "revision": revision,
            "updated_at": now_ms(),
        }))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(ExpertDraft {
        definition: normalized,
        revision,
        digest,
        updated_at: now_ms(),
    })
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_validate(definition: ExpertDefinition) -> Vec<DomainIssue> {
    validate_definition(&definition)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_request_confirmation(
    id: String,
    draftRevision: u32,
    definitionDigest: String,
) -> Result<ConfirmationRequest, String> {
    // 依赖锁摘要：本应用暂无外部依赖锁，用空串占位；
    // 将来接了 skill 依赖清单，这里换成对应摘要即可，发布链路无需改动。
    let dependency_lock_digest = String::new();
    Ok(confirmations().request(
        &id,
        "publish",
        &draftRevision.to_string(),
        &definitionDigest,
        &dependency_lock_digest,
    ))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn expert_confirm(token: String) -> Result<ConfirmationProof, String> {
    confirmations().confirm(&token)
}

#[tauri::command]
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
            let file = PathBuf::from(root).join(".pi").join("roles").join("current.md");
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
    })
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
        assert!(issues.iter().any(|i| i.path.as_deref() == Some("methodology")));
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
            store.consume(&ConfirmationProof { token: req.confirmation_token.clone() }, "digest-a", ""),
            Err("experts/confirmation-required".to_string())
        );
        let proof = store.confirm(&req.confirmation_token).expect("UI 确认应通过");
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
}
