# 参考实现 版式对齐 —— 05 资料库

> 完成度：**版式已对齐**；搜索、最近、输出三个 tab 为版式占位，当前只实现「资料库」本地文件树。

## 1. 截图/源码对照

| 元素 | 参考实现 版式 | 本页落地 |
|---|---|---|
| 页头 | 「资料库」+ 副标题 | 一致 |
| Tab | 资料库 / 搜索 / 最近 / 输出 | 一致 |
| 搜索框 | 搜索资料库 | 一致（本地过滤） |
| 左侧文件树 | 可展开目录、显示文件数 | 一致 |
| 右侧预览区 | 选中文件后显示标题 + 编辑区 | 一致 |

## 2. 修改文件

- `src/components/panels/LibraryPanel.vue`：重写为 参考实现 版式，新增 view tab、搜索、文件树、预览区。
- `src/components/panels/LibraryPanel.css`：1:1 复刻树与预览区视觉。
- `src/components/ui/AppIcon.vue`：新增 `folder-open` 图标。

## 3. 后端逻辑

复用已有文件命令：

```rust
fs_read_dir  { path, root }
fs_read_file { path, root }
fs_write_file { path, content, root }
```

文件树按 `root` 递归读取；越界访问由后端拒绝。

## 4. 与 Pi 项目的融合

- 资料库直接映射 Pi 的「活动项目目录」。
- 选中的文本文件可直接编辑保存；后续可作为 Pi 的上下文附件或成果卡片引用。

## 5. 完成度清单

- [x] 资料库 tab + 文件树
- [x] 文本文件预览/编辑
- [x] 搜索框（本地过滤文件名）
- [x] 文件图标按扩展名区分
- [ ] 搜索 tab（后端全文检索）
- [ ] 最近 tab
- [ ] 输出 tab
- [ ] 右键菜单（新建/重命名/删除）
- [x] Office 预览（docx/xlsx 渲染；pptx/pdf 降级提示用「原件」打开，12 MiB 上限）
- [ ] 图片预览

## 6. 验证

- `pnpm typecheck` ✅
- `pnpm build` ✅
