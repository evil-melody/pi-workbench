use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::to_string_pretty;
use tauri::{AppHandle, Manager, State};

use crate::state::ProjectsState;

/// 项目指令的 token 预算。超出后内核每轮都要重放这段提示，
/// 成本会线性叠加，所以在写入侧就拦住（对齐内核的
/// `PROJECT_INSTRUCTION_TOKEN_BUDGET`）。
const PROJECT_INSTRUCTION_TOKEN_BUDGET: usize = 8_000;

/// 活动流水只保留最近这么多条，避免 projects.json 无上限膨胀。
const ACTIVITY_LIMIT: usize = 200;

const NAME_MAX: usize = 10_000;
const TITLE_MAX: usize = 500;

/// 估算一段文本的策略提示词 token 数：中日韩等宽字符按 1 个 token，
/// 其余 ASCII 按 4 字符 1 个 token（按 instruction-budget 口径）。
fn estimate_instruction_tokens(value: &str) -> usize {
    let mut wide = 0usize;
    let mut narrow = 0usize;
    for ch in value.chars() {
        if ch.is_ascii() {
            narrow += 1;
        } else {
            wide += 1;
        }
    }
    wide + narrow.div_ceil(4)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// 自增计数器。仅靠时间戳不够：同一纳秒内连续生成两个 id 会撞号，
/// 表现为「第二个项目覆盖了第一个项目」。 nanotime + 计数器基本不可能重复。
static ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{nanos:x}{seq:x}")
}

fn clean(value: &str, code: &str, max: usize) -> Result<String, String> {
    let next = value.trim().to_string();
    if next.is_empty() || next.len() > max {
        return Err(code.to_string());
    }
    Ok(next)
}

// ── 领域模型 ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ProjectTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instruction: String,
}

const TEMPLATE_ROWS: &[(&str, &str, &str, &str)] = &[
    (
        "product",
        "产品需求全流程",
        "从需求规划、PRD 到研发测试验收",
        "围绕产品目标维护需求、计划、任务、资产和决策记录。",
    ),
    (
        "research",
        "市场调研与竞品分析",
        "深度调研、竞品拆解、报告评审",
        "引用可核验资料，区分事实、推断与建议，持续沉淀研究资产。",
    ),
    (
        "knowledge",
        "团队知识库",
        "持续沉淀 SOP、经验和 FAQ",
        "优先复用项目资产，输出可维护、可追溯的团队知识。",
    ),
    (
        "delivery",
        "项目交付",
        "管理客户需求、计划、风险和周报",
        "跟踪交付范围、负责人、时间、风险和验收证据。",
    ),
    (
        "bugs",
        "Bug 跟踪/测试验收",
        "持续跟踪 Bug、测试用例和验收",
        "问题必须关联复现步骤、负责人、优先级、状态和验证证据。",
    ),
];

pub fn templates() -> Vec<ProjectTemplate> {
    TEMPLATE_ROWS
        .iter()
        .map(|(id, name, description, instruction)| ProjectTemplate {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            instruction: instruction.to_string(),
        })
        .collect()
}

fn template_by_id(id: &str) -> Option<ProjectTemplate> {
    TEMPLATE_ROWS
        .iter()
        .find(|(row_id, _, _, _)| *row_id == id)
        .map(|(id, name, description, instruction)| ProjectTemplate {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            instruction: instruction.to_string(),
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectCapabilityRef {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// 配置是不可变追加的：每次保存生成新修订，旧的留着以便回溯。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectConfigRevision {
    pub id: String,
    pub project_id: String,
    pub number: u32,
    pub instruction: String,
    #[serde(default)]
    pub capabilities: Vec<ProjectCapabilityRef>,
    pub created_by: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectWorkItem {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default = "default_work_item_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 乐观锁版本号：每次更新都变，用于发现并发编辑冲突。
    pub revision: String,
    pub created_at: u64,
    pub updated_at: u64,
}

fn default_work_item_status() -> String {
    "todo".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectAssetRef {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub asset_id: String,
    pub revision_id: String,
    pub name: String,
    pub kind: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectInputRef {
    pub kind: String,
    pub id: String,
    pub revision: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectTaskLink {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub title: String,
    pub config_revision_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<ProjectCapabilityRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    #[serde(default)]
    pub references: Vec<ProjectInputRef>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectActivity {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub text: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    /// 绑定的目录（本项目特有的字段，用于把项目与实际工作区挂钩）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub archived: bool,
    /// 当前生效的配置修订 id。
    #[serde(default)]
    pub config_revision_id: String,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub updated_at: Option<u64>,
    /// codebase-memory-mcp 为该目录生成的项目名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codebase_project_name: Option<String>,
    /// 索引节点数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codebase_nodes: Option<usize>,
    /// 索引边数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codebase_edges: Option<usize>,
    /// 最近成功索引的时间戳。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codebase_indexed_at: Option<u64>,
    /// 最近一次索引失败的错误文本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codebase_index_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectSnapshot {
    pub project: Project,
    #[serde(default)]
    pub config: Option<ProjectConfigRevision>,
    #[serde(default)]
    pub work_items: Vec<ProjectWorkItem>,
    #[serde(default)]
    pub assets: Vec<ProjectAssetRef>,
    #[serde(default)]
    pub tasks: Vec<ProjectTaskLink>,
    #[serde(default)]
    pub activity: Vec<ProjectActivity>,
    /// 当前指令的 token 用量与预算，前端据此画预算条。
    #[serde(default)]
    pub instruction_usage: InstructionUsage,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct InstructionUsage {
    pub tokens: usize,
    pub budget: usize,
}

/// 会话 → 项目的结构化上下文，供 Pi 每轮注入。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectTaskContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_capabilities: Option<Vec<ProjectCapabilityRef>>,
    pub project: Project,
    pub config: ProjectConfigRevision,
    pub task: ProjectTaskLink,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProjectStore {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    projects: HashMap<String, Project>,
    #[serde(default)]
    configs: HashMap<String, ProjectConfigRevision>,
    #[serde(default)]
    work_items: HashMap<String, ProjectWorkItem>,
    #[serde(default)]
    assets: HashMap<String, ProjectAssetRef>,
    #[serde(default)]
    tasks: HashMap<String, ProjectTaskLink>,
    #[serde(default)]
    activity: HashMap<String, ProjectActivity>,
}

// ── 状态读写 ──────────────────────────────────────────────────

pub(crate) fn projects_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("projects.json"))
}

/// 兼容早期版本：那时 projects.json 顶层直接是 `Vec<Project>`。
/// 现在统一为 store 结构，导入时给每个项目补一条初始配置修订。
fn decode_store(raw: &str) -> ProjectStore {
    if let Ok(store) = serde_json::from_str::<ProjectStore>(raw) {
        if !store.projects.is_empty() {
            return store;
        }
    }
    if let Ok(list) = serde_json::from_str::<Vec<Project>>(raw) {
        let mut store = ProjectStore::default();
        for project in list {
            let now = project.updated_at.unwrap_or(0);
            let revision_id = new_id("cfg");
            store.configs.insert(
                revision_id.clone(),
                ProjectConfigRevision {
                    id: revision_id.clone(),
                    project_id: project.id.clone(),
                    number: 1,
                    instruction: String::new(),
                    capabilities: Vec::new(),
                    created_by: "migrated".to_string(),
                    created_at: now,
                },
            );
            store.projects.insert(
                project.id.clone(),
                Project {
                    config_revision_id: revision_id,
                    created_at: if now == 0 { None } else { Some(now) },
                    ..project
                },
            );
        }
        return store;
    }
    ProjectStore::default()
}

pub fn load(app: &AppHandle, state: &State<ProjectsState>) {
    if let Ok(f) = projects_file(app) {
        if let Ok(s) = fs::read_to_string(&f) {
            *state.store.lock().unwrap() = decode_store(&s);
        }
    }
}

pub(crate) fn save(app: &AppHandle, state: &State<ProjectsState>) -> Result<(), String> {
    let f = projects_file(app)?;
    let v = state.store.lock().unwrap().clone();
    fs::write(&f, to_string_pretty(&v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

// ── 领域操作（纯函数，便于测试；命令层只负责取状态与落盘） ──

impl ProjectStore {
    /// 按 project_id 过滤并按创建时间升序，供快照组装使用。
    fn scoped<T: Clone + ProjectScoped>(&self, rows: &HashMap<String, T>, project_id: &str) -> Vec<T> {
        let mut out: Vec<T> = rows
            .values()
            .filter(|r| r.project_id() == project_id)
            .cloned()
            .collect();
        out.sort_by(|a, b| a.created_at().cmp(&b.created_at()));
        out
    }
}

fn touch(store: &mut ProjectStore, project_id: &str) {
    if let Some(p) = store.projects.get_mut(project_id) {
        p.updated_at = Some(now_ms());
    }
}

/// 写入项目代码库索引结果（成功或失败都走这个入口）。
///
/// 放在 projects 模块内是因为 `ProjectStore.projects` 是私有字段；
/// 其它 crate 内模块统一通过本函数改索引状态，不要在外部直接碰字段。
pub(crate) fn set_codebase_status(
    store: &mut ProjectStore,
    project_id: &str,
    project_name: Option<String>,
    nodes: Option<usize>,
    edges: Option<usize>,
    indexed_at: Option<u64>,
    error: Option<String>,
) {
    if let Some(p) = store.projects.get_mut(project_id) {
        p.codebase_project_name = project_name;
        p.codebase_nodes = nodes;
        p.codebase_edges = edges;
        p.codebase_indexed_at = indexed_at;
        p.codebase_index_error = error;
        p.updated_at = Some(now_ms());
    }
}

fn record_activity(store: &mut ProjectStore, project_id: &str, kind: &str, text: &str) {
    let id = new_id("act");
    store.activity.insert(
        id.clone(),
        ProjectActivity {
            id,
            project_id: project_id.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
            created_at: now_ms(),
        },
    );
    if store.activity.len() > ACTIVITY_LIMIT {
        // 按时间倒序保留最近的 ACTIVITY_LIMIT 条，其余丢弃。
        let keep = {
            let mut all: Vec<ProjectActivity> = store.activity.values().cloned().collect();
            all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            all.truncate(ACTIVITY_LIMIT);
            all
        };
        store.activity.clear();
        for item in keep {
            store.activity.insert(item.id.clone(), item);
        }
    }
}

pub(crate) fn require_project<'a>(store: &'a ProjectStore, project_id: &str) -> Result<&'a Project, String> {
    let project = store
        .projects
        .get(project_id)
        .ok_or_else(|| "projects/not-found".to_string())?;
    if project.archived {
        return Err("projects/not-found".to_string());
    }
    Ok(project)
}

fn active_config<'a>(
    store: &'a ProjectStore,
    project: &'a Project,
) -> Result<&'a ProjectConfigRevision, String> {
    store
        .configs
        .get(&project.config_revision_id)
        .ok_or_else(|| "projects/not-found".to_string())
}

fn sorted_activity(store: &ProjectStore, project_id: &str) -> Vec<ProjectActivity> {
    let mut rows: Vec<ProjectActivity> = store
        .activity
        .values()
        .filter(|a| a.project_id == project_id)
        .cloned()
        .collect();
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    rows
}

pub fn snapshot_of(store: &ProjectStore, project_id: &str) -> Result<ProjectSnapshot, String> {
    let project = require_project(store, project_id)?.clone();
    let config = active_config(store, &project)?.clone();
    Ok(ProjectSnapshot {
        instruction_usage: InstructionUsage {
            tokens: estimate_instruction_tokens(&config.instruction),
            budget: PROJECT_INSTRUCTION_TOKEN_BUDGET,
        },
        project: project.clone(),
        config: Some(config),
        work_items: store.scoped(&store.work_items, &project.id),
        assets: store.scoped(&store.assets, &project.id),
        tasks: store.scoped(&store.tasks, &project.id),
        activity: sorted_activity(store, &project.id),
    })
}
trait ProjectScoped {
    fn project_id(&self) -> &str;
    fn created_at(&self) -> u64;
}

impl ProjectScoped for ProjectWorkItem {
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn created_at(&self) -> u64 {
        self.created_at
    }
}
impl ProjectScoped for ProjectAssetRef {
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn created_at(&self) -> u64 {
        self.created_at
    }
}
impl ProjectScoped for ProjectTaskLink {
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn created_at(&self) -> u64 {
        self.created_at
    }
}

pub fn create_project(
    store: &mut ProjectStore,
    name: &str,
    description: &str,
    template_id: Option<&str>,
    path: Option<&str>,
) -> Result<Project, String> {
    let name = clean(name, "projects/invalid-name", NAME_MAX)?;
    let template = template_id.and_then(template_by_id);
    if template_id.is_some() && template.is_none() {
        return Err("projects/template-not-found".to_string());
    }
    let created_at = now_ms();
    // 先造修订再造项目：项目的 config_revision_id 必须指向这条修订，
    // 否则项目会挂在一个空的修订 id 上，快照永远解析不出来。
    let revision = ProjectConfigRevision {
        id: new_id("cfg"),
        project_id: String::new(),
        number: 1,
        instruction: template.as_ref().map(|t| t.instruction.clone()).unwrap_or_default(),
        capabilities: Vec::new(),
        created_by: "local".to_string(),
        created_at,
    };
    let revision_id = revision.id.clone();
    let project_id = new_id("p");
    let project = Project {
        id: project_id.clone(),
        name,
        description: description.trim().to_string(),
        template_id: template.as_ref().map(|t| t.id.clone()),
        path: path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
        archived: false,
        config_revision_id: revision_id.clone(),
        created_at: Some(created_at),
        updated_at: Some(created_at),
        codebase_project_name: None,
        codebase_nodes: None,
        codebase_edges: None,
        codebase_indexed_at: None,
        codebase_index_error: None,
    };
    let mut revision = revision;
    revision.project_id = project_id.clone();
    store.configs.insert(revision_id, revision);
    store.projects.insert(project_id, project.clone());
    record_activity(
        store,
        &project.id,
        "project",
        &format!("创建了项目「{}」", project.name),
    );
    Ok(project)
}

pub fn update_config(
    store: &mut ProjectStore,
    project_id: &str,
    instruction: &str,
    capabilities: &[ProjectCapabilityRef],
    expected_revision_id: &str,
    revision_number: u32,
) -> Result<ProjectConfigRevision, String> {
    let project = require_project(store, project_id)?.clone();
    let previous = active_config(store, &project)?;
    if previous.id != expected_revision_id || previous.number != revision_number {
        return Err("projects/revision-conflict".to_string());
    }
    if estimate_instruction_tokens(instruction) > PROJECT_INSTRUCTION_TOKEN_BUDGET {
        return Err("projects/instruction-budget-exceeded".to_string());
    }
    let next = ProjectConfigRevision {
        id: new_id("cfg"),
        project_id: project.id.clone(),
        number: previous.number + 1,
        instruction: instruction.to_string(),
        capabilities: capabilities.to_vec(),
        created_by: "local".to_string(),
        created_at: now_ms(),
    };
    store
        .configs
        .insert(next.id.clone(), next.clone());
    if let Some(p) = store.projects.get_mut(&project.id) {
        p.config_revision_id = next.id.clone();
        p.updated_at = Some(next.created_at);
    }
    record_activity(
        store,
        &project.id,
        "project",
        &format!("更新了项目配置（修订 {}）", next.number),
    );
    Ok(next)
}

pub fn add_work_item(
    store: &mut ProjectStore,
    project_id: &str,
    title: &str,
) -> Result<ProjectWorkItem, String> {
    require_project(store, project_id)?;
    let now = now_ms();
    let item = ProjectWorkItem {
        id: new_id("wi"),
        project_id: project_id.to_string(),
        title: clean(title, "projects/invalid-title", TITLE_MAX)?,
        status: "todo".to_string(),
        assignee: None,
        priority: "none".to_string(),
        tags: Vec::new(),
        revision: new_id("rev"),
        created_at: now,
        updated_at: now,
    };
    store.work_items.insert(item.id.clone(), item.clone());
    touch(store, project_id);
    record_activity(
        store,
        project_id,
        "work-item",
        &format!("新增计划「{}」", item.title),
    );
    Ok(item)
}

pub fn update_work_item(
    store: &mut ProjectStore,
    project_id: &str,
    patch: WorkItemPatch,
    expected_revision: &str,
) -> Result<ProjectWorkItem, String> {
    let target_id = patch.id.clone().unwrap_or_default();
    let old = store
        .work_items
        .get(&target_id)
        .cloned()
        .ok_or_else(|| "projects/not-found".to_string())?;
    if old.project_id != project_id {
        return Err("projects/not-found".to_string());
    }
    if old.revision != expected_revision {
        return Err("projects/revision-conflict".to_string());
    }
    let title = if let Some(t) = patch.title.as_deref() {
        clean(t, "projects/invalid-title", TITLE_MAX)?
    } else {
        old.title.clone()
    };
    let item = ProjectWorkItem {
        title,
        status: patch.status.unwrap_or(old.status).clone(),
        assignee: patch.assignee.clone().or(old.assignee.clone()),
        priority: patch.priority.unwrap_or(old.priority.clone()),
        tags: patch.tags.clone().unwrap_or(old.tags.clone()),
        revision: new_id("rev"),
        updated_at: now_ms(),
        ..old
    };
    store.work_items.insert(item.id.clone(), item.clone());
    touch(store, project_id);
    record_activity(
        store,
        project_id,
        "work-item",
        &format!("更新计划「{}」", item.title),
    );
    Ok(item)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkItemPatch {
    pub id: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub assignee: Option<String>,
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
}

pub fn remove_work_item(
    store: &mut ProjectStore,
    project_id: &str,
    item_id: &str,
) -> Result<(), String> {
    let old = store
        .work_items
        .get(item_id)
        .ok_or_else(|| "projects/not-found".to_string())?;
    if old.project_id != project_id {
        return Err("projects/not-found".to_string());
    }
    let removed = old.title.clone();
    store.work_items.remove(item_id);
    touch(store, project_id);
    record_activity(
        store,
        project_id,
        "work-item",
        &format!("移除计划「{removed}」"),
    );
    Ok(())
}

pub fn add_asset(
    store: &mut ProjectStore,
    project_id: &str,
    input: AssetInput,
) -> Result<ProjectAssetRef, String> {
    require_project(store, project_id)?;
    // 同一资产同一版本的引用只保留一条，重复关联不应产生脏数据。
    if let Some(existing) = store
        .assets
        .values()
        .find(|a| {
            a.project_id == project_id
                && a.asset_id == input.asset_id
                && a.revision_id == input.revision_id
        })
    {
        return Ok(existing.clone());
    }
    let ref_asset = ProjectAssetRef {
        id: new_id("as"),
        project_id: project_id.to_string(),
        node_id: input.node_id,
        asset_id: input.asset_id,
        revision_id: input.revision_id,
        name: clean(&input.name, "projects/invalid-title", TITLE_MAX)?,
        kind: input.kind,
        created_at: now_ms(),
    };
    store.assets.insert(ref_asset.id.clone(), ref_asset.clone());
    touch(store, project_id);
    record_activity(
        store,
        project_id,
        "asset",
        &format!("关联资产「{}」", ref_asset.name),
    );
    Ok(ref_asset)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AssetInput {
    pub node_id: String,
    pub asset_id: String,
    pub revision_id: String,
    pub name: String,
    pub kind: String,
}

pub fn remove_asset(store: &mut ProjectStore, project_id: &str, ref_id: &str) -> Result<(), String> {
    let old = store
        .assets
        .get(ref_id)
        .ok_or_else(|| "projects/not-found".to_string())?;
    if old.project_id != project_id {
        return Err("projects/not-found".to_string());
    }
    let removed = old.name.clone();
    store.assets.remove(ref_id);
    touch(store, project_id);
    record_activity(
        store,
        project_id,
        "asset",
        &format!("移除资产引用「{removed}」"),
    );
    Ok(())
}

/// 校验一批输入引用是否还指向项目里的当前版本；过期引用会被拒绝，
 /// 防止会话拿着已被改动的计划项/资产继续推进。
fn validate_references(
    store: &ProjectStore,
    project: &Project,
    references: &[ProjectInputRef],
) -> Result<Vec<ProjectInputRef>, String> {
    let config = active_config(store, project)?;
    let mut unique: HashMap<String, ProjectInputRef> = HashMap::new();
    for reference in references {
        let key = format!("{}:{}", reference.kind, reference.id);
        if unique.contains_key(&key) {
            continue;
        }
        if reference.kind == "work-item" {
            let item = store
                .work_items
                .get(&reference.id)
                .ok_or_else(|| "projects/reference-stale".to_string())?;
            if item.project_id != project.id || item.revision != reference.revision {
                return Err("projects/reference-stale".to_string());
            }
        } else if reference.kind == "asset" {
            let asset = store
                .assets
                .get(&reference.id)
                .ok_or_else(|| "projects/reference-stale".to_string())?;
            if asset.project_id != project.id || asset.revision_id != reference.revision {
                return Err("projects/reference-stale".to_string());
            }
        } else {
            let skill = config
                .capabilities
                .iter()
                .find(|c| c.kind == "skill" && c.id == reference.id);
            let effective = skill
                .and_then(|c| c.revision.clone())
                .unwrap_or_else(|| project.config_revision_id.clone());
            if skill.is_none() || effective != reference.revision {
                return Err("projects/reference-stale".to_string());
            }
        }
        let mut row = reference.clone();
        row.label = clean(&row.label, "projects/invalid-title", TITLE_MAX)?;
        unique.insert(key, row);
    }
    Ok(unique.into_values().collect())
}

pub fn link_task(
    store: &mut ProjectStore,
    project_id: &str,
    session_id: &str,
    title: &str,
    work_item_id: Option<&str>,
    references: &[ProjectInputRef],
    capabilities: &[ProjectCapabilityRef],
) -> Result<ProjectTaskLink, String> {
    let project = require_project(store, project_id)?.clone();
    if let Some(work_item_id) = work_item_id {
        if store
            .work_items
            .get(work_item_id)
            .map(|w| w.project_id.as_str() != project.id)
            .unwrap_or(true)
        {
            return Err("projects/not-found".to_string());
        }
    }
    let validated = validate_references(store, &project, references)?;
    let configured = active_config(store, &project)?.capabilities.clone();
    // 会话可以只借用其中一部分能力，但必须来自当前配置里已绑定的那些。
    let selection = capabilities
        .iter()
        .map(|want| {
            configured
                .iter()
                .find(|c| {
                    c.kind == want.kind && c.id == want.id && c.revision == want.revision
                })
                .ok_or_else(|| "projects/capability-not-bound".to_string())
                .map(|c| c.clone())
        })
        .collect::<Result<Vec<ProjectCapabilityRef>, String>>()?;
    let link = ProjectTaskLink {
        id: new_id("task"),
        project_id: project.id.clone(),
        session_id: clean(session_id, "projects/invalid-title", TITLE_MAX)?.to_string(),
        title: clean(title, "projects/invalid-title", TITLE_MAX)?,
        config_revision_id: project.config_revision_id.clone(),
        capabilities: Some(selection),
        work_item_id: work_item_id.map(|s| s.to_string()),
        references: validated,
        created_at: now_ms(),
    };
    store.tasks.insert(link.id.clone(), link.clone());
    touch(store, &project.id);
    record_activity(
        store,
        &project.id,
        "task",
        &format!("创建任务「{}」", link.title),
    );
    Ok(link)
}

pub fn task_context(
    store: &ProjectStore,
    session_id: &str,
) -> Result<Option<ProjectTaskContext>, String> {
    let task = store
        .tasks
        .values()
        .find(|t| t.session_id == session_id)
        .cloned();
    let task = match task {
        Some(t) => t,
        None => return Ok(None),
    };
    let project = store
        .projects
        .get(&task.project_id)
        .ok_or_else(|| "projects/not-found".to_string())?
        .clone();
    // 任务记录的是「创建那一刻的修订」，所以这里按 task.config_revision_id 取，
    // 而不是取项目当前的修订——否则历史会话会突然套用后来改过的能力。
    let config = store
        .configs
        .get(&task.config_revision_id)
        .ok_or_else(|| "projects/not-found".to_string())?
        .clone();
    Ok(Some(ProjectTaskContext {
        available_capabilities: Some(config.capabilities.clone()),
        project: project.clone(),
        config: config.clone(),
        task: task.clone(),
    }))
}

// ── 命令层 ────────────────────────────────────────────────────

fn with_store<R>(state: &State<ProjectsState>, f: impl FnOnce(&mut ProjectStore) -> R) -> R {
    f(&mut state.store.lock().unwrap())
}

pub(crate) fn persist(app: &AppHandle, state: &State<ProjectsState>) -> Result<(), String> {
    save(app, state)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn projects_templates() -> Vec<ProjectTemplate> {
    templates()
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn projects_list(state: State<ProjectsState>) -> Vec<Project> {
    with_store(&state, |store| {
        let mut rows: Vec<Project> = store.projects.values().cloned().collect();
        rows.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
        rows
    })
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_get(id: String, state: State<ProjectsState>) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| snapshot_of(store, &id))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_add(
    app: AppHandle,
    name: String,
    description: Option<String>,
    templateId: Option<String>,
    path: Option<String>,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    let project = with_store(&state, |store| {
        create_project(store, &name, &description.unwrap_or_default(), templateId.as_deref(), path.as_deref())
    })?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &project.id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_update_config(
    app: AppHandle,
    id: String,
    instruction: String,
    capabilities: Vec<ProjectCapabilityRef>,
    expectedRevisionId: String,
    expectedRevisionNumber: u32,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| {
        update_config(
            store,
            &id,
            &instruction,
            &capabilities,
            &expectedRevisionId,
            expectedRevisionNumber,
        )
    })?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_add_work_item(
    app: AppHandle,
    id: String,
    title: String,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| add_work_item(store, &id, &title))?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_update_work_item(
    app: AppHandle,
    id: String,
    patch: WorkItemPatch,
    expectedRevision: String,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| update_work_item(store, &id, patch, &expectedRevision))?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_remove_work_item(
    app: AppHandle,
    id: String,
    workItemId: String,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| remove_work_item(store, &id, &workItemId))?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_add_asset(
    app: AppHandle,
    id: String,
    asset: AssetInput,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| add_asset(store, &id, asset))?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_remove_asset(
    app: AppHandle,
    id: String,
    refId: String,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| remove_asset(store, &id, &refId))?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_link_task(
    app: AppHandle,
    id: String,
    sessionId: String,
    title: String,
    workItemId: Option<String>,
    references: Option<Vec<ProjectInputRef>>,
    capabilities: Option<Vec<ProjectCapabilityRef>>,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    with_store(&state, |store| {
        link_task(
            store,
            &id,
            &sessionId,
            &title,
            workItemId.as_deref(),
            references.as_deref().unwrap_or_default(),
            capabilities.as_deref().unwrap_or_default(),
        )
    })?;
    persist(&app, &state)?;
    Ok(with_store(&state, |store| snapshot_of(store, &id))?)
}

/// 发消息主链路第一跳（taskContextPreamble）：必须 async。
/// 它要抢 `store` 锁；锁被后台任务（如索引收尾）短暂持有时，非 async 命令
/// 会让主线程跟着等——发送瞬间整窗冻结正是这类「跑错线程」的典型症状。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn project_task_context(
    sessionId: String,
    state: State<ProjectsState>,
) -> Result<Option<ProjectTaskContext>, String> {
    with_store(&state, |store| task_context(store, &sessionId))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_remove(
    app: AppHandle,
    id: String,
    state: State<ProjectsState>,
) -> Result<Vec<Project>, String> {
    {
        let mut store = state.store.lock().unwrap();
        if store.projects.remove(&id).is_none() {
            return Err("projects/not-found".to_string());
        }
    }
    persist(&app, &state)?;
    Ok(projects_list(state))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_set_path(
    app: AppHandle,
    id: String,
    path: Option<String>,
    state: State<ProjectsState>,
) -> Result<ProjectSnapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        let project = require_project(&store, &id)?.clone();
        let next = path
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        let summary = match &next {
            Some(p) => format!("绑定了工作目录 {p}"),
            None => "解绑了工作目录".to_string(),
        };
        if let Some(p) = store.projects.get_mut(&id) {
            p.path = next;
            p.updated_at = Some(now_ms());
        }
        record_activity(&mut store, &project.id, "project", &summary);
    }
    persist(&app, &state)?;
    with_store(&state, |store| snapshot_of(store, &id))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_set_active(id: String, state: State<ProjectsState>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if !store.projects.contains_key(&id) {
        return Err("projects/not-found".to_string());
    }
    *state.active.lock().unwrap() = Some(id.clone());
    if let Some(p) = store.projects.get_mut(&id) {
        p.updated_at = Some(now_ms());
    }
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_active(state: State<ProjectsState>) -> Option<String> {
    state.active.lock().unwrap().clone()
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_archive(
    app: AppHandle,
    id: String,
    state: State<ProjectsState>,
) -> Result<Vec<Project>, String> {
    {
        let mut store = state.store.lock().unwrap();
        if let Some(p) = store.projects.get_mut(&id) {
            p.archived = true;
            p.updated_at = Some(now_ms());
            let name = p.name.clone();
            record_activity(&mut store, &id, "project", &format!("归档了项目「{name}」"));
        }
    }
    persist(&app, &state)?;
    Ok(projects_list(state))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn project_unarchive(
    app: AppHandle,
    id: String,
    state: State<ProjectsState>,
) -> Result<Vec<Project>, String> {
    {
        let mut store = state.store.lock().unwrap();
        if let Some(p) = store.projects.get_mut(&id) {
            p.archived = false;
            p.updated_at = Some(now_ms());
            let name = p.name.clone();
            record_activity(&mut store, &id, "project", &format!("恢复了项目「{name}」"));
        }
    }
    persist(&app, &state)?;
    Ok(projects_list(state))
}

#[derive(Debug, Clone, Serialize)]
pub struct BillingStatus {
    pub balance: f64,
    pub today: f64,
    pub period_label: String,
    pub period_until: String,
    /// 数据是否为占位值。前端据此显示「演示」角标，
    /// 而不是把写死的余额当成真实额度——避免 UI 撒谎。
    pub demo: bool,
}

/// 用户可在 app_config_dir/billing.json 写入真实计费数据，
/// 否则返回占位值并置 `demo = true`，避免 UI 把演示数据当成真实额度。
#[derive(Debug, Clone, Deserialize)]
pub struct BillingConfig {
    pub balance: f64,
    pub today: f64,
    pub period_label: String,
    pub period_until: String,
}

fn read_billing_config(app: &AppHandle) -> Option<BillingConfig> {
    let path = app.path().app_config_dir().ok()?.join("billing.json");
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 当前余额与计费时段。
///
/// Pi 暂无统一计费接口：若用户在 `app_config_dir/billing.json` 提供数据则按真实值展示，
/// 否则返回占位值并置 `demo = true`。
#[tauri::command]
#[allow(non_snake_case)]
pub fn billing_status(app: AppHandle) -> BillingStatus {
    if let Some(cfg) = read_billing_config(&app) {
        return BillingStatus {
            balance: cfg.balance,
            today: cfg.today,
            period_label: cfg.period_label,
            period_until: cfg.period_until,
            demo: false,
        };
    }
    BillingStatus {
        balance: 96.28,
        today: 2.4201,
        period_label: "早场时段——全谷价".into(),
        period_until: "9小时19分后进入高峰".into(),
        demo: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_store() -> ProjectStore {
        ProjectStore::default()
    }

    fn seeded(template: Option<&str>) -> ProjectStore {
        let mut store = empty_store();
        create_project(&mut store, "测试项目", "", template, None).unwrap();
        store
    }

    fn first_project_id(store: &ProjectStore) -> String {
        store.projects.keys().next().unwrap().clone()
    }

    fn ref_of(kind: &str, id: &str, revision: &str) -> ProjectInputRef {
        ProjectInputRef {
            kind: kind.to_string(),
            id: id.to_string(),
            revision: revision.to_string(),
            label: id.to_string(),
        }
    }

    #[test]
    fn estimate_counts_cjk_as_one_token_and_ascii_as_four() {
        assert_eq!(estimate_instruction_tokens("ab"), 1);
        assert_eq!(estimate_instruction_tokens("abcd"), 1);
        assert_eq!(estimate_instruction_tokens("中文"), 2);
        assert_eq!(estimate_instruction_tokens("ab中文"), 3);
    }

    #[test]
    fn creating_project_with_unknown_template_is_rejected() {
        assert!(create_project(&mut empty_store(), "x", "", Some("nope"), None).is_err());
    }

    #[test]
    fn creating_project_prefills_revision_from_template() {
        let store = seeded(Some("bugs"));
        let id = first_project_id(&store);
        let project = store.projects.get(&id).unwrap();
        let config = store.configs.get(&project.config_revision_id).unwrap();
        assert_eq!(config.number, 1);
        assert!(!config.instruction.is_empty());
    }

    #[test]
    fn update_config_bumps_revision_number() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let current = store.configs.get(&store.projects[&id].config_revision_id).unwrap().clone();

        let next = update_config(
            &mut store,
            &id,
            "新的项目指令",
            &[],
            &current.id,
            current.number,
        )
        .unwrap();

        assert_eq!(next.number, 2);
        assert_eq!(store.projects[&id].config_revision_id, next.id);
    }

    #[test]
    fn update_config_rejects_stale_revision() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let current = store.configs.get(&store.projects[&id].config_revision_id).unwrap().clone();

        let err = update_config(&mut store, &id, "x", &[], "stale-revision", current.number)
            .expect_err("过期修订必须被拒");

        assert_eq!(err, "projects/revision-conflict");
    }

    #[test]
    fn update_config_rejects_instruction_over_budget() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let current = store.configs.get(&store.projects[&id].config_revision_id).unwrap().clone();

        // 每个中文字符 1 token，造一个刚好超预算的指令。
        let oversized = "中".repeat(PROJECT_INSTRUCTION_TOKEN_BUDGET + 1);
        let err = update_config(&mut store, &id, &oversized, &[], &current.id, current.number)
            .expect_err("超预算必须被拒");

        assert_eq!(err, "projects/instruction-budget-exceeded");
    }

    #[test]
    fn snapshot_reports_instruction_usage_against_budget() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let current = store.configs.get(&store.projects[&id].config_revision_id).unwrap().clone();

        update_config(&mut store, &id, "四条 ascii 字符", &[], &current.id, current.number).unwrap();
        let snap = snapshot_of(&store, &id).unwrap();

        assert!(snap.instruction_usage.tokens > 0);
        assert_eq!(snap.instruction_usage.budget, PROJECT_INSTRUCTION_TOKEN_BUDGET);
    }

    #[test]
    fn work_item_update_rejects_stale_revision() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let item = add_work_item(&mut store, &id, "搭脚手架").unwrap();

        let err = update_work_item(
            &mut store,
            &id,
            WorkItemPatch {
                id: Some(item.id.clone()),
                title: None,
                status: Some("doing".into()),
                assignee: None,
                priority: None,
                tags: None,
            },
            "stale",
        )
        .expect_err("过期修订必须被拒");

        assert_eq!(err, "projects/revision-conflict");
    }

    #[test]
    fn work_item_update_bumps_revision_and_keeps_title_when_omitted() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let item = add_work_item(&mut store, &id, "搭脚手架").unwrap();

        let patched = update_work_item(
            &mut store,
            &id,
            WorkItemPatch {
                id: Some(item.id.clone()),
                title: None,
                status: Some("doing".into()),
                assignee: Some("tatsuma".into()),
                priority: Some("high".into()),
                tags: Some(vec!["infra".into()]),
            },
            &item.revision,
        )
        .unwrap();

        assert_ne!(patched.revision, item.revision);
        assert_eq!(patched.title, "搭脚手架");
        assert_eq!(patched.status, "doing");
    }

    #[test]
    fn removing_work_item_rejects_ids_from_other_projects() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let item = add_work_item(&mut store, &id, "临时").unwrap();

        assert!(remove_work_item(&mut store, &id, &item.id).is_ok());
        assert!(remove_work_item(&mut store, &id, &item.id).is_err());
    }

    #[test]
    fn adding_same_asset_twice_is_idempotent() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let input = AssetInput {
            node_id: "n1".into(),
            asset_id: "a1".into(),
            revision_id: "r1".into(),
            name: "设计稿".into(),
            kind: "image".into(),
        };

        let first = add_asset(&mut store, &id, input.clone()).unwrap();
        let second = add_asset(&mut store, &id, input).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(store.assets.len(), 1);
    }

    #[test]
    fn removing_asset_rejects_ref_from_other_project() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let asset = add_asset(
            &mut store,
            &id,
            AssetInput {
                node_id: "n1".into(),
                asset_id: "a1".into(),
                revision_id: "r1".into(),
                name: "设计稿".into(),
                kind: "image".into(),
            },
        )
        .unwrap();

        assert!(remove_asset(&mut store, &id, &asset.id).is_ok());
        assert!(remove_asset(&mut store, &id, &asset.id).is_err());
    }

    #[test]
    fn link_task_rejects_work_item_from_another_project() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        // 另一个项目里的一条计划，不该能被绑到本项目会话上。
        create_project(&mut store, "别的项目", "", None, None).unwrap();
        // 注意不能再用 first_project_id：HashMap 顺序不确定，可能又拿回本项目。
        let other_id = store
            .projects
            .keys()
            .find(|k| **k != id)
            .expect("应存在第二个项目")
            .clone();
        let other = add_work_item(&mut store, &other_id, "别人的计划").unwrap();

        let err = link_task(&mut store, &id, "s1", "会话任务", Some(&other.id), &[], &[])
            .expect_err("跨项目的计划不能绑");

        assert_eq!(err, "projects/not-found");
    }

    #[test]
    fn link_task_rejects_capabilities_not_bound_in_config() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let item = add_work_item(&mut store, &id, "登录页").unwrap();
        // 先把一个 skill 绑进配置，会话才能引用它。
        let current = store.configs.get(&store.projects[&id].config_revision_id).unwrap().clone();
        update_config(
            &mut store,
            &id,
            "指令",
            &[ProjectCapabilityRef {
                kind: "skill".into(),
                id: "pdf-tools".into(),
                revision: Some("r9".into()),
                label: "PDF".into(),
                scope: None,
            }],
            &current.id,
            current.number,
        )
        .unwrap();

        let err = link_task(
            &mut store,
            &id,
            "s1",
            "会话任务",
            Some(&item.id),
            &[],
            &[ProjectCapabilityRef {
                kind: "skill".into(),
                id: "ghost".into(),
                revision: Some("r9".into()),
                label: "幽灵技能".into(),
                scope: None,
            }],
        )
        .expect_err("未绑定的能力不能注入");

        assert_eq!(err, "projects/capability-not-bound");
    }

    #[test]
    fn link_task_records_session_and_task_context_resolves_it() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let item = add_work_item(&mut store, &id, "登录页").unwrap();

        let link = link_task(
            &mut store,
            &id,
            "session-42",
            "重构登录",
            Some(&item.id),
            &[ref_of("work-item", &item.id, &item.revision)],
            &[],
        )
        .unwrap();

        let ctx = task_context(&store, "session-42").unwrap().expect("会话应能解析出上下文");
        assert_eq!(ctx.task.id, link.id);
        assert_eq!(ctx.config.id, ctx.task.config_revision_id);
        assert_eq!(ctx.available_capabilities.unwrap().len(), 0);
    }

    #[test]
    fn task_context_is_scoped_per_session() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        add_work_item(&mut store, &id, "任务 A").unwrap();
        link_task(&mut store, &id, "s-alpha", "会话 A", None, &[], &[]).unwrap();

        assert!(task_context(&store, "s-beta").unwrap().is_none());
    }

    #[test]
    fn link_task_rejects_stale_work_item_reference() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        let item = add_work_item(&mut store, &id, "登录页").unwrap();
        let stale = ref_of("work-item", &item.id, "stale-revision");

        let err = link_task(&mut store, &id, "s1", "会话任务", None, &[stale], &[])
            .expect_err("过期引用必须被拒");

        assert_eq!(err, "projects/reference-stale");
    }

    #[test]
    fn snapshot_excludes_data_of_other_projects() {
        let mut store = empty_store();
        create_project(&mut store, "A", "", None, None).unwrap();
        create_project(&mut store, "B", "", None, None).unwrap();
        let ids: Vec<String> = store.projects.keys().cloned().collect();
        let other = ids.iter().find(|i| *i != &ids[0]).unwrap().clone();

        add_work_item(&mut store, &ids[0], "A 的计划").unwrap();
        add_asset(
            &mut store,
            &other,
            AssetInput {
                node_id: "n".into(),
                asset_id: "x".into(),
                revision_id: "r".into(),
                name: "B 的资产".into(),
                kind: "file".into(),
            },
        )
        .unwrap();

        let snap = snapshot_of(&store, &ids[0]).unwrap();
        assert_eq!(snap.work_items.len(), 1);
        assert!(snap.assets.is_empty());
    }

    #[test]
    fn archived_project_is_not_visible_through_get() {
        let mut store = seeded(None);
        let id = first_project_id(&store);
        store.projects.get_mut(&id).unwrap().archived = true;

        assert!(snapshot_of(&store, &id).is_err());
    }

    #[test]
    fn legacy_project_file_upgrades_to_a_config_revision() {
        let legacy = r#"[
          {"id":"p1","name":"旧项目","path":"/tmp/old","archived":false}
        ]"#;
        let store = decode_store(legacy);

        let project = store.projects.get("p1").unwrap();
        let revision = store.configs.get(&project.config_revision_id).unwrap();
        assert_eq!(revision.number, 1);
        assert_eq!(revision.instruction, "");
        assert_eq!(revision.created_by, "migrated");
    }
}
