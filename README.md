# Gemini Chat Exporter

> 探索报告 · 基于 v1.3.1（`gemini-chat-exporter.user.js`）· 2026-11-02

一个 Tampermonkey 用户脚本：在 https://gemini.google.com 上**抓取当前对话**，以聊天气泡预览，并导出为 Markdown / JSON。

---

## 1. 金字塔视图：整体架构

```
                        ┌─────────────────────────────┐
                        │   用户点击「📋 抓取对话」   │
                        └──────────────┬──────────────┘
                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │                    UI 层                              │
        │  injectStyle → buildUI → refresh(silent)             │
        │  （Trusted Types 安全构建，禁用 innerHTML）          │
        └──────────────┬───────────────────────────────────────┘
                       ▼
        ┌──────────────────────────────────────────────────────┐
        │                  解析层 getConversation()             │
        │  方案A 轮次容器配对 → 方案B 全页扫描排序 → 方案C 兜底  │
        │  依赖：pick / maybeInner / deepQueryAllByName         │
        │        domOrder / dedupe                              │
        └──────────────┬───────────────────────────────────────┘
                       ▼  输出 [{role:'user'|'model', text}]
        ┌──────────────────────────────────────────────────────┐
        │                 序列化层 textOf → domToMd             │
        │  DOM 树 → Markdown 文本（换行/列表/代码/链接/粗体）  │
        │  domToMd ⇄ listToMd 互相递归                          │
        └──────────────┬───────────────────────────────────────┘
                       ▼
        ┌──────────────────────────────────────────────────────┐
        │                  导出层                                │
        │  toMarkdown / toJSON → copyText / download            │
        └──────────────────────────────────────────────────────┘
```

层与层之间只靠 `{role, text}` 这个最小数据结构交接——任何一层改坏不影响另外两层。

---

## 2. 函数清单与调用关系

### 2.1 查找工具（定位消息用）

| 函数 | 行号 | 作用 |
|------|------|------|
| `deepQuery(selector)` | L21 | 递归穿透 **Shadow DOM** 查找第一个命中。Gemini 聊天区藏在多层 Web Component 里，普通 `document.querySelector` 无效 |
| `qSel(selector)` | L40 | 先常规查找，找不到才走 `deepQuery`（性能：常规查找便宜，穿透贵） |
| `pick(...nodes)` | L47 | "兜底"原语：依次尝试候选选择器，返回**第一个非空**结果 |
| `deepQueryAllByName(tagName)` | L286 | `deepQuery` 的"全部命中"版，收集所有同名自定义元素并去重 |
| `domOrder(el)` | L303 | 全量枚举 `document.querySelectorAll('*')` 后取 `indexOf` 作为文档序号 |
| `maybeInner(root, selectors)` | L276 | 在命中节点内部继续下钻，选择文本非空的最精确子节点；都空则退回根节点本身 |

### 2.2 序列化（DOM → Markdown，解决"没有换行"的核心)

| 函数 | 行号 | 作用 |
|------|------|------|
| `textOf(el)` | L61 | 入口：`domToMd(el).trim()` |
| `domToMd(node, inPre)` | L108 | 递归遍历 `childNodes`，**只走常规 DOM、不进 shadowRoot**（内容就在命中节点内） |
| `listToMd(list, ordered, depth)` | L77 | 专管 `<ul>/<ol>`：编号、`- `、嵌套缩进、续行对齐 |

`domToMd` 的标签分发表：

| 输入元素 | 输出 |
|---------|------|
| `<p>` | 段落，段间空行 |
| `<br>` | `\n` |
| `<h1>-<h6>` | `#`×N 标题 |
| `<ul>/<ol>` | 委托 `listToMd`（`1.` 编号 / `- ` 符号） |
| `<pre>` | ` ```围栏 `，并向子孙传递 `inPre=true` 保留缩进 |
| 行内 `<code>` | `` `xx` `` |
| `<a>` | `[text](href)`，text=href 时只输出 URL 防重复 |
| `<strong>/<b>` / `<em>/<i>` | `**粗体**` / `*斜体*` |
| `<td>/<th>/<tr>` | 伪表格（`\|` 分隔） |
| 其他 | 直接拼接子内容 |

**预扫描机制**（L111-132）：每次进入 `domToMd` 先扫一遍同级 children，把 `<pre>` 前面的语言标签兄弟节点（如 "JavaScript"）标记进 `consumed` 集合并记入 `fenceLang`；主循环里跳过 consumed 节点，语言并入围栏信息串输出 ```` ```JavaScript ````。双保险：`<code class="language-xxx">` 的 class 也能提供语言名。

**与 textContent 的本质区别**：`textContent` 会把块级元素粘成一行；`domToMd` 按语义在每个块级边界主动补 `\n`/`\n\n`，输出天然是规整 Markdown。

### 2.3 解析层（三级降级）

```
getConversation()
   │
   ├─ 方案A  pick('conversation-container', 'chat-item', ...)
   │         每个轮次容器内 querySelector('user-query'/'model-response')
   │         → 问答天然配对，最准确
   │
   ├─ 方案B  deepQueryAllByName 两个自定义元素
   │         + domOrder 排序交错还原顺序
   │         （无需轮次容器，只要标签存在就能抓）
   │
   └─ 方案C  pick('[data-test-id="chat-turn"]', 'div[role="listitem"]')
             全部标为 model —— 纯兜底，宁多勿漏
```

### 2.4 导出与 UI

| 函数 | 行号 | 说明 |
|------|------|------|
| `toMarkdown(conv)` | L321 | `# 标题` + 每条 `## 🧑 我`/`## ✨ Gemini` + 尾部导出时间 |
| `toJSON(conv)` | L333 | `{title, url, exportedAt, messages}` |
| `download()` | L341 | Blob → `URL.createObjectURL` → 合成 `<a download>` 点击，1s 后 revoke |
| `copyText()` | L350 | 优先 `navigator.clipboard`，异常降级 `textarea + execCommand` |
| `safeName()` | L550 | 文件名清理 Windows 非法字符，截断 60 字符 |
| `buildUI()` | L440 | `createElement` 逐节点构建（见下方"安全约束"）；|内部闭包 `refresh/current/flash` |
| `refresh(silent)` | L476 | 每次都重新调 `getConversation()`——保证导出永远是当下最新 |
| `init()` | L572 | 唯一入口，拒绝 iframe、构建 UI、打日志 |
| `setInterval` 兜底 | L585 | 每 3 秒检查按钮存活（SPA 路由切换会重绘 DOM） |

### 2.5 控制台 API（L559-568）

```js
getConversation()               // 调试：原始结构化数组
getGeminiConversation()         // 快捷：JSON 字符串
exportGeminiChat('md' | 'json') // 复制到剪贴板并返回文本
```

`@grant none` 意味着脚本运行在页面上下文（非沙箱），所以 `window.xxx` 赋值对 DevTools 可见。

---

## 3. 三次"环境对抗"的设计决策

| 对抗 | 症状 | 对策 |
|------|------|------|
| **Trusted Types CSP** | `innerHTML` 赋值直接抛 TypeError | UI 全部 `createElement` + `textContent`；样式走 `style.textContent`（TT 不限制） |
| **多层 Shadow DOM** | 常规选择器什么都找不到 | `deepQueryAllByName` 递归 `el.shadowRoot` |
| **频繁改版** | 选择器失效即全盘失效 | 三级降级 + `pick` 首个命中即返回 + 轮次容器/自定义元素/通用节点三条独立路径 |

---

## 4. 探索中发现的隐患 🔍

按重要度排序。**当前状态：1-7 已全部修复**（OpenSpec 变更 `harden-chat-exporter`，见 `openspec/changes/harden-chat-exporter/`，v1.3.0），✔ 为对应决策：

1. ~~**死代码**~~ ✔D4：`USER_SELECTORS`/`BOT_SELECTORS` 已成为方案 A/B 的唯一选择器来源（另加 `TURN_TAGS` 表，改编版时只改一处）。

2. ~~**`domOrder` 性能隐患**~~ ✔D5：改为 `compareDocumentPosition` 排序，不再全页枚举。

3. ~~**`dedupe` 碰撞风险**~~ ✔D1：键改为全文比对，前 120 字符相同的不同消息不再被误删。

4. ~~**方案 C 语义不准**~~ ✔D2：兜底路径增加 `inferRole` 启发式（结构特征优先 → 短问句），判不出仍降级为 model。

5. ~~**方案 B 内 `maybeInner` 双重选择**~~ ✔D6：删除二次序列化，单次取最精确节点。

6. ~~**`fenceLang` 预扫描的边界**~~ ✔D3：`findFenceLanguage` 沿父链溯源最多 2 层；跨层标签由 `isLoneLanguageLabel` 在自身层级跳过；`language-xxx` class 路径不受层数限制。

7. ~~**`setInterval` 兜底永不停止**~~ ✔D7：改用 `MutationObserver`（顶层 `childList`）事件驱动，消除轮询。

---

## 5. 迭代史（本工程的调试轨迹）

| 版本节点 | 问题 | 修复 |
|---------|------|------|
| 初版 | Trusted Types 拦截 `innerHTML` | 改 `createElement` 构建 |
| 预览版 | 面板是原始 Markdown 源码，无换行 | 升级为聊天气泡渲染 + 暗色模式 |
| 提取版 | `textContent` 吞掉块级换行 | 重写 `textOf` → `domToMd` 递归序列化 |
| 列版 | `<ol>` 也输出 `- `，编号消失 | `listToMd`：有序编号 + 嵌套缩进；补 `**粗体**`/`*斜体*` |
| 代码块版 | 语言标签泄漏为游离 `**JavaScript` | 预扫描并入围栏：```` ```JavaScript ```` |
| 加固版 1.3.0 | 探索发现的 7 个隐患 | dedupe 全文键、兜底角色推断、语言标签 2 层溯源、选择器表收敛（+`TURN_TAGS`）、`compareDocumentPosition` 排序、去二次序列化、`MutationObserver`（OpenSpec 变更 `harden-chat-exporter`，fixture 见 `test/fixture.html`） |
| 热修 1.3.1 | v1.3.0 在 `<li>` 裸文本消息上崩溃（回归） | `domToMd` 入口节点类型守卫：`listToMd` 传入的 TEXT_NODE 直通返回、注释等返回空（OpenSpec 变更 `fix-domtomed-text-node`）；fixture 补 2 用例至 9/9 |

节奏特征：**用户视角报"显示不对" → 根因往往在提取层或 DOM 语义层**，UI 层只是受害者。

---

## 6. 可能的下一步（想法，非承诺）

- **全量导出**：当前只能抓"当前打开的对话"。Gemini 侧边栏的历史对话列表也可抓，理论上能遍历导出全部历史。
- **格式增强**：图片（用户上传的附件）、思考过程（thought summary）、引用来源超链接的完整保留。
- **健壮性**：把选择器表变成唯一配置点（解决死代码 #1）；` MutationObserver` 替换轮询。
- **测试**：`domToMd/listToMd` 是纯函数，可以脱离浏览器用 jsdom 单测——这是全脚本最适合补测试的地方。

---

*本 README 为探索模式的思考沉淀，不锁定实现方向。*
