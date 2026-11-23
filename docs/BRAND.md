# 品牌资产与图标生成

> 一个吉祥物源图 → 全套平台图标 + 前端品牌资源。全部可重跑，不依赖手工导出。

## 真源

| 文件 | 说明 |
|---|---|
| `assets/brand/mascot-transparent.png` | **唯一真源**：透明背景吉祥物原图（928×928，抠图产出） |
| `assets/brand/icon-1024.png` | 圆角方形应用图标母版（脚本产出，改参数时可直接比对） |

改品牌只改真源，其余全部由脚本重新生成 —— **不要手工另存图标**，否则下次重跑会被覆盖，且尺寸/圆角不统一。

## 生成

```bash
python3 scripts/make-icons.py --src assets/brand/mascot-transparent.png --repo .
```

前置：`Pillow`。macOS 上还需系统自带的 `iconutil`（生成 `.icns`）；没有则跳过 icns 并在输出里说明，其余产物照出。

## 产物

| 目标 | 文件 | 用途 |
|---|---|---|
| macOS / Dock / 桌面 | `src-tauri/icons/icon.icns`（16→1024 全档） | 打包后 `.app` 图标，Dock 与访达显示的就是它 |
| Windows | `src-tauri/icons/icon.ico`（16→256）、`Square*Logo.png`、`StoreLogo.png` | 任务栏、开始菜单、商店包 |
| 通用 | `src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png` | Tauri 打包读取的位图档 |
| Android | `src-tauri/icons/android/mipmap-*` | 启动图标（圆角/圆形）+ 自适应图标前景 + 背景色 |
| 浏览器 | `public/favicon.png` | `index.html` 的 `<link rel="icon">` |
| 界面内 | `src/assets/mascot.png`（384×348，透明） | 首页主视觉与侧栏品牌标记，走打包器（带 hash） |

## 设计参数（想改动看这里）

| 参数 | 值 | 出处 |
|---|---|---|
| 圆角比例 | 边长 × **22.37%** | macOS Big Sur 之后的系统图标几何；系统**不再**替应用裁圆角，必须自己画 |
| 吉祥物高度占比 | 画布 **74%** | 视觉重量与留白平衡（踩过坑：80% 时耳朵贴边） |
| 底部留白 | 画布 **10%** | 底座不贴下边缘 |
| 底色 | 竖向渐变 `#f3f9fe → #cee5f6` | 与吉祥物自身的淡蓝/青色调同源 |
| 内描边 | `rgba(255,255,255,0.67)`，宽 `size/256` | 暗色 Dock 背景上仍能认出图标边界 |
| 投影 | 主体底部椭圆，高斯模糊 `size×3.5%` | 避免主体像贴纸一样浮在底板上 |

## 两个必须知道的坑

1. **模板里的静态 `src="/mascot.png"` 会被当项目根路径解析。**
   Vue 的 asset 转换会把绝对路径交给打包器解析，仓库根一旦存在同名文件，就会**静默替换**掉 `public/` 里那张——本项目真实发生过：根目录遗留的 928×928 不透明原图顶掉了 `public/mascot.png`，首页吉祥物带着一圈白底方块。
   规避：品牌图放 `src/assets/` 用 `import` 引入（本仓现做法），或确保根目录不存在同名文件。

2. **透明底要用像素证明，不能靠肉眼。**
   白底在浅色主题下几乎看不出来。`visual-check.mjs` 直接把原图画进 canvas，读左上角像素的 alpha，`alpha !== 0` 即判失败。

## 回归守卫

`scripts/visual-check.mjs` 中与品牌相关的断言：

- 应用主图标为 1024 方形且 `colorType=6`（带 alpha）
- 32×32 同样带 alpha（Dock/任务栏不留白底）
- `icon.icns`、`icon.ico` 存在且体积合理
- 首页品牌图为高清原图（长边 ≥ 2× 显示尺寸）
- 品牌图为透明底（四角 alpha = 0）
- 品牌图只有一处且旧小图已下线
- 分类选中态跟随全局强调色（首页不得出现第二套主色）
- 深色主题下首页背景随之切换
