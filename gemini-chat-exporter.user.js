// ==UserScript==
// @name         Gemini Chat Exporter (获取当前交谈记录)
// @namespace    https://gemini.google.com/
// @version      1.3.1
// @description  在 gemini.google.com 上抓取当前对话记录，支持 Markdown / JSON 复制与下载、悬浮面板预览
// @author       you
// @match        https://gemini.google.com/*
// @match        https://gemini.google.com/u/*/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /* ---------------- 工具函数 ---------------- */

  const d = document;

  function deepQuery(selector) {
    // Gemini 大量使用 shadow DOM，需要递归穿透查找
    const results = [];
    function walk(root) {
      if (!root) return;
      if (root.querySelector) {
        const hit = root.querySelector(selector);
        if (hit) results.push(hit);
      }
      // 遍历 shadow roots
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(d);
    return results;
  }

  function qSel(selector) {
    // 先普通查找，找不到再穿透 shadow DOM
    const direct = Array.from(d.querySelectorAll(selector));
    if (direct.length > 0) return direct;
    return deepQuery(selector);
  }

  function pick(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const found = qSel(n);
        if (found.length > 0) return found;
      } else if (Array.isArray(n) && n.length > 0) {
        return n;
      } else if (n instanceof Element) {
        return [n];
      }
    }
    return [];
  }

  function textOf(el) {
    if (!el) return '';
    return domToMd(el).trim();
  }

  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'PRE', 'BLOCKQUOTE',
    'TABLE', 'TR', 'DIV', 'SECTION', 'ARTICLE',
  ]);

  /**
   * 把列表元素序列化为 Markdown：
   * - 有序列表 <ol> → "1. 2. 3."，无序列表 <ul> → "- "
   * - <li> 内的非列表内容作为条目正文，嵌套的 <ul>/<ol> 递归缩进
   */
  function listToMd(list, ordered, depth = 0) {
    let out = '';
    let idx = 0;
    const pad = '  '.repeat(depth);
    for (const li of list.children) {
      if (li.nodeType !== Node.ELEMENT_NODE || li.tagName !== 'LI') continue;
      idx++;

      let content = '';
      let nested = '';
      for (const c of li.childNodes) {
        if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === 'UL' || c.tagName === 'OL')) {
          nested += listToMd(c, c.tagName === 'OL', depth + 1);
        } else {
          content += domToMd(c);
        }
      }

      const marker = ordered ? idx + '. ' : '- ';
      // 条目内若含段落换行，续行与首行对齐
      out += pad + marker + content.trim().replace(/\n/g, '\n' + pad + ' '.repeat(marker.length)) + '\n';
      if (nested) out += nested;
    }
    return out;
  }

  const LANG_SHAPE = /^[A-Za-z0-9#\-+_.]{1,15}$/;

  /**
   * 找 <pre> 对应的语言（D3）：
   * ① <pre> 内部的 language-xxx class —— 不受包装层数影响，最可靠
   * ② 语言标签 —— 通常是 <pre> 的前置短文本兄弟节点；可能隔着包装层，
   *    沿父链向上最多回溯 2 层，每层查找前置兄弟（上限避免无限上溯误吞正文）
   * 返回 { lang, label }：label 为将被围栏吸收、需要跳过序列化的标签节点
   */
  function findFenceLanguage(pre) {
    let lang = '';
    const codeEl = pre.querySelector && pre.querySelector('[class*="language-"]');
    const m = codeEl && /language-([\w+#-]+)/.exec(codeEl.className);
    if (m) lang = m[1];

    let label = null;
    let root = pre;
    for (let level = 0; level <= 2 && root; level++) {
      for (let sib = root.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const t = (sib.textContent || '').trim();
        if (t && LANG_SHAPE.test(t) && !sib.querySelector('pre')) {
          label = sib;
          if (!lang) lang = t; // class 信息更可靠，标签仅在缺 class 时作为语言
          break;
        }
      }
      if (label) break;
      root = root.parentElement;
    }
    return { lang, label };
  }

  /**
   * 跨包装层的语言标签不在 <pre> 的直接子层级里，会被父层独立序列化，
   * 导致围栏外多出一行干扰文本。特征：短文本 + 不含 <pre> +
   * 同层级紧邻（下一个非空元素分支）包含 <pre> —— 命中即跳过。
   */
  function isLoneLanguageLabel(el) {
    const t = (el.textContent || '').trim();
    if (!t || !LANG_SHAPE.test(t)) return false;
    if (el.querySelector && el.querySelector('pre')) return false;
    let sib = el.nextElementSibling;
    while (sib && !(sib.textContent || '').trim()) sib = sib.nextElementSibling;
    return !!(sib && sib.querySelector && sib.querySelector('pre'));
  }

  /**
   * 把 DOM 递归序列化为带换行的文本：
   * - 块级元素（p/li/标题/代码块...）之间补换行，解决 textContent 丢换行的问题
   * - 列表 → "- "，代码块 → ``` 围栏，行内 code → `xxx`，链接 → [text](href)
   */
  function domToMd(node, inPre = false) {
    // 节点类型守卫（fix-domtomed-text-node）：listToMd 会把 <li> 内的裸文本
    // 节点直接传入本函数；文本节点没有 children 属性，v1.3.0 的预扫描在此崩溃。
    // 契约：任意节点进 → Markdown 字符串出
    if (node.nodeType === Node.TEXT_NODE) {
      const v = node.nodeValue || '';
      return inPre ? v : v.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''; // 注释等安全短路

    let out = '';

    // 预扫描：Gemini 代码块的语言标签（如 "JavaScript"）可能直接是 <pre> 的前置
    // 兄弟节点，也可能隔着包装层。溯源到语言并入围栏信息串（```JavaScript），
    // 同层的标签节点标记为 consumed 避免重复序列化
    const consumed = new Set();
    const fenceLang = new Map();
    for (const child of node.children) {
      if (child.tagName !== 'PRE') continue;
      const info = findFenceLanguage(child);
      if (info.lang) fenceLang.set(child, info.lang);
      if (info.label) consumed.add(info.label);
    }

    for (const child of node.childNodes) {
      if (consumed.has(child)) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        // <pre> 内的空白是有意义的，其他地方折叠多余空格
        out += inPre ? (child.nodeValue || '') : (child.nodeValue || '').replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;

      if (tag === 'BR') { out += '\n'; continue; }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') continue;
      if (isLoneLanguageLabel(child)) continue; // 跨层的语言标签，已由围栏吸收

      const inner = domToMd(child, inPre || tag === 'PRE');

      if (tag === 'PRE') {
        const lang = fenceLang.get(child) || '';
        out += '\n```' + lang + '\n' + inner.replace(/^\n+|\n+$/g, '') + '\n```\n\n';
      } else if (/^H[1-6]$/.test(tag)) {
        out += '#'.repeat(+tag[1]) + ' ' + inner.trim() + '\n\n';
      } else if (tag === 'UL' || tag === 'OL') {
        out += (out.endsWith('\n') ? '' : '\n') + listToMd(child, tag === 'OL') + '\n';
      } else if (tag === 'TR') {
        out += inner.trim() + '\n';
      } else if (tag === 'TD' || tag === 'TH') {
        out += inner.trim() + ' | ';
      } else if (tag === 'P') {
        out += inner.trim() + '\n\n';
      } else if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || BLOCK_TAGS.has(tag)) {
        out += inner + '\n';
      } else if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        const txt = inner.trim();
        // 文本和链接相同就直接输出 URL，避免 [url](url) 这种重复
        out += href && txt && txt !== href ? `[${txt}](${href})` : (href || txt);
      } else if (tag === 'CODE' && !inPre) {
        out += '`' + inner.trim() + '`';
      } else if (tag === 'STRONG' || tag === 'B') {
        out += '**' + inner.trim() + '**';
      } else if (tag === 'EM' || tag === 'I') {
        out += '*' + inner.trim() + '*';
      } else {
        out += inner;
      }
    }
    // 收尾清理：行尾空格、3 个以上连续空行压成 1 个空行
    return out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  function titleOf() {
    const t = d.title || '';
    // Gemini 页面标题通常形如 "对话标题 - Gemini"
    return t.replace(/\s*[-–]\s*Gemini.*$/i, '').trim() || 'Gemini 对话';
  }

  /* ---------------- 对话解析 ---------------- */

  // 依次尝试多组选择器（Gemini 改版时只需修改这里）
  // 方案 B 全页扫描的自定义元素标签
  const TURN_TAGS = ['user-query', 'model-response'];
  // 以下选择器相对命中节点（user-query / model-response 根元素）使用
  const USER_SELECTORS = [
    '.query-content',      // 2024+ 主要结构
    '.user-query',
    '.query-text',
  ];

  const BOT_SELECTORS = [
    'response-container .markdown',   // 正文 markdown
    '.model-response-text',
    '.markdown',
    'response-container',
  ];

  const PAIR_CONTAINERS = [
    'conversation-container',          // 每轮问答的容器
    'chat-window .conversation-container',
    'chat-item',
  ];

  /**
   * 抓取当前对话，返回标准化数组
   * @returns {{role:'user'|'model', text:string, time?:string}[]}
   */
  function getConversation() {
    const pairs = [];

    // 方案 A：按轮次容器配对（最准确）
    const containers = pick(...PAIR_CONTAINERS);
    if (containers.length >= 1) {
      for (const c of containers) {
        const u = c.querySelector('user-query');
        const m = c.querySelector('model-response');
        const uText = u ? textOf(maybeInner(u, USER_SELECTORS)) : '';
        const mText = m ? textOf(maybeInner(m, BOT_SELECTORS)) : '';
        if (uText) pairs.push({ role: 'user', text: uText });
        if (mText) pairs.push({ role: 'model', text: mText });
      }
      if (pairs.length > 0) return dedupe(pairs);
    }

    // 方案 B：全页扫 user-query / model-response，按 DOM 顺序交错配对
    const users = deepQueryAllByName(TURN_TAGS[0]);
    const models = deepQueryAllByName(TURN_TAGS[1]);
    if (users.length > 0 || models.length > 0) {
      // compareDocumentPosition 直接比较文档序，避免每元素全页枚举（D5）
      const items = [
        ...users.map(el => ({ el, role: 'user' })),
        ...models.map(el => ({ el, role: 'model' })),
      ].sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : (pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0);
      });

      for (const it of items) {
        // maybeInner 按表内顺序取“第一个有文本的最精确节点”，单次序列化即可
        const text = textOf(maybeInner(
          it.el,
          it.role === 'user' ? USER_SELECTORS : BOT_SELECTORS
        ));
        if (text) pairs.push({ role: it.role, text });
      }
      if (pairs.length > 0) return dedupe(pairs);
    }

    // 方案 C：最后兜底 —— 用 data 作者属性或 aria 标签的通用消息节点
    const generic = pick(
      '[data-test-id="chat-turn"]',
      'div[role="listitem"]'
    );
    if (generic.length > 0) {
      for (const g of generic) {
        const txt = textOf(g);
        if (txt) pairs.push({ role: inferRole(g), text: txt });
      }
    }

    return dedupe(pairs);
  }

  function maybeInner(root, selectors) {
    for (const s of selectors) {
      try {
        const hit = root.querySelector(s);
        if (hit && textOf(hit).length > 0) return hit;
      } catch (e) {}
    }
    return root;
  }

  function deepQueryAllByName(tagName) {
    // 收集自定义元素标签（含 shadow DOM 内部）
    const out = [];
    function walk(root) {
      if (!root) return;
      if (root.querySelectorAll) {
        root.querySelectorAll(tagName).forEach(el => out.push(el));
      }
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(d);
    return out.filter((el, i, arr) => arr.indexOf(el) === i);
  }

  /**
   * 兜底路径的角色推断（D2）：
   * ① 结构特征优先 —— 节点内含 user-query 系提问结构 → user
   * ② 启发式 —— 短文本且以疑问句 / 请求语气开头或结尾 → user
   * ③ 判不出 → model（宁降级不误报，与旧行为一致）
   */
  function inferRole(node) {
    if (!node) return 'model';
    try {
      if (node.querySelector && node.querySelector('user-query, .query-content, .query-text')) return 'user';
    } catch (e) {}
    const text = textOf(node);
    if (text && text.length <= 200) {
      if (/[?？]\s*$/.test(text) || /^(请|帮我|如何|怎么|为何|为什么|可否|能否|是什么)/.test(text)) return 'user';
    }
    return 'model';
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter(item => {
      const key = item.role + '|' + item.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /* ---------------- 导出格式 ---------------- */

  function toMarkdown(conv) {
    const lines = [`# ${titleOf()}`, ''];
    for (const m of conv) {
      lines.push(m.role === 'user' ? '## 🧑 我' : '## ✨ Gemini');
      lines.push('');
      lines.push(m.text);
      lines.push('');
    }
    lines.push(`> 导出于 ${new Date().toLocaleString()}`);
    return lines.join('\n');
  }

  function toJSON(conv) {
    return JSON.stringify(
      { title: titleOf(), url: location.href, exportedAt: new Date().toISOString(), messages: conv },
      null,
      2
    );
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const a = d.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = d.createElement('textarea');
      ta.value = text;
      d.body.appendChild(ta);
      ta.select();
      const ok = d.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  /* ---------------- 悬浮 UI ---------------- */

  const CSS = `
    #gce-btn {
      position: fixed; right: 18px; bottom: 88px; z-index: 99999;
      padding: 8px 14px; border-radius: 999px; border: none;
      background: #1a73e8; color: #fff; font-size: 13px; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,.25); transition: opacity .2s;
      font-family: system-ui, sans-serif;
    }
    #gce-btn:hover { background: #1765cc; }
    #gce-panel {
      position: fixed; right: 18px; bottom: 130px; z-index: 99999;
      width: 420px; max-height: 60vh; display: none; flex-direction: column;
      background: #fff; border-radius: 12px; overflow: hidden;
      box-shadow: 0 8px 30px rgba(0,0,0,.3);
      font-family: system-ui, sans-serif; font-size: 13px; color: #202124;
    }
    #gce-panel.open { display: flex; }
    #gce-head {
      padding: 10px 14px; background: #f1f3f4; font-weight: 600;
      display: flex; justify-content: space-between; align-items: center;
    }
    #gce-head button {
      border: none; background: transparent; cursor: pointer; font-size: 16px; color: #5f6368;
    }
    #gce-actions { display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #e0e0e0; }
    #gce-actions button {
      padding: 6px 10px; border: 1px solid #dadce0; border-radius: 8px;
      background: #fff; cursor: pointer; font-size: 12px;
    }
    #gce-actions button:hover { background: #f1f3f4; }
    #gce-body { overflow: auto; padding: 12px 14px; line-height: 1.6; background: #f8f9fa; }
    .gce-turn { display: flex; margin: 10px 0; }
    .gce-turn.user { justify-content: flex-end; }
    .gce-bubble {
      max-width: 86%; padding: 8px 12px; border-radius: 12px;
      white-space: pre-wrap; word-break: break-word; font-size: 13px;
    }
    .gce-turn.user .gce-bubble {
      background: #1a73e8; color: #fff;
      border-bottom-right-radius: 4px;
    }
    .gce-turn.model .gce-bubble {
      background: #fff; color: #202124; border: 1px solid #e0e0e0;
      border-bottom-left-radius: 4px;
    }
    .gce-label { font-size: 11px; color: #5f6368; margin-bottom: 3px; }
    .gce-turn.user .gce-label { text-align: right; }
    .gce-col { max-width: 92%; display: flex; flex-direction: column; }
    .gce-turn.user .gce-col { align-items: flex-end; margin-left: auto; }
    .gce-empty { color: #5f6368; font-size: 12px; text-align: center; padding: 24px 8px; }
    @media (prefers-color-scheme: dark) {
      #gce-panel { background: #1e1f20; color: #e3e3e3; }
      #gce-head { background: #2a2b2d; color: #e3e3e3; }
      #gce-head button { color: #9aa0a6; }
      #gce-actions { border-bottom-color: #333537; }
      #gce-actions button { background: #2a2b2d; border-color: #444746; color: #e3e3e3; }
      #gce-actions button:hover { background: #333537; }
      #gce-body { background: #131314; }
      .gce-turn.model .gce-bubble { background: #2a2b2d; color: #e3e3e3; border-color: #333537; }
      .gce-label { color: #9aa0a6; }
      .gce-empty { color: #9aa0a6; }
    }
    #gce-msg {
      padding: 0 14px 8px; color: #188038; font-size: 12px; min-height: 16px;
    }
  `;

  function injectStyle() {
    const style = d.createElement('style');
    style.textContent = CSS;
    d.head.appendChild(style);
  }

  function buildUI() {
    injectStyle();

    const btn = d.createElement('button');
    btn.id = 'gce-btn';
    btn.textContent = '📋 抓取对话';

    const panel = d.createElement('div');
    panel.id = 'gce-panel';

    // Google 页面开启 Trusted Types，不能用 innerHTML，改为 createElement 构建
    const el = (tag, id, text) => {
      const n = d.createElement(tag);
      if (id) n.id = id;
      if (text) n.textContent = text;
      return n;
    };

    const head = el('div', 'gce-head');
    head.append(el('span', '', 'Gemini 对话记录'), el('button', 'gce-close', '✕'));

    const actions = el('div', 'gce-actions');
    actions.append(
      el('button', 'gce-md', '复制 Markdown'),
      el('button', 'gce-json', '复制 JSON'),
      el('button', 'gce-dl-md', '下载 .md'),
      el('button', 'gce-dl-json', '下载 .json'),
      el('button', 'gce-refresh', '刷新'),
    );

    panel.append(head, actions, el('div', 'gce-body'), el('div', 'gce-msg'));

    d.body.append(btn, panel);

    let current = [];

    function refresh(silent) {
      current = getConversation();
      const body = panel.querySelector('#gce-body');
      body.textContent = '';

      if (current.length === 0) {
        body.append(el('div', 'gce-empty',
          '未抓取到对话内容。\n请先发送至少一条消息；\n若 Gemini 已改版，可打开控制台调整选择器。'));
      } else {
        for (const m of current) {
          const col = d.createElement('div');
          col.className = 'gce-col';

          const label = el('div', '', m.role === 'user' ? '🧑 我' : '✨ Gemini');
          label.className = 'gce-label';

          const turn = d.createElement('div');
          turn.className = 'gce-turn ' + (m.role === 'user' ? 'user' : 'model');

          const bubble = el('div', '', m.text);
          bubble.className = 'gce-bubble';

          turn.append(bubble);
          col.append(label, turn);
          body.append(col);
        }
      }

      if (!silent) {
        panel.querySelector('#gce-msg').textContent =
          current.length ? `已抓取 ${current.length} 条消息` : '';
      }
      return current;
    }

    btn.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) refresh();
    });

    panel.querySelector('#gce-close').addEventListener('click', () => panel.classList.remove('open'));
    panel.querySelector('#gce-refresh').addEventListener('click', () => refresh());

    panel.querySelector('#gce-md').addEventListener('click', async () => {
      const conv = refresh(true);
      const ok = await copyText(toMarkdown(conv));
      flash(ok ? '✅ Markdown 已复制到剪贴板' : '❌ 复制失败');
    });

    panel.querySelector('#gce-json').addEventListener('click', async () => {
      const conv = refresh(true);
      const ok = await copyText(toJSON(conv));
      flash(ok ? '✅ JSON 已复制到剪贴板' : '❌ 复制失败');
    });

    panel.querySelector('#gce-dl-md').addEventListener('click', () => {
      const conv = refresh(true);
      download(toMarkdown(conv), safeName(titleOf()) + '.md', 'text/markdown');
      flash('✅ 已下载 .md');
    });

    panel.querySelector('#gce-dl-json').addEventListener('click', () => {
      const conv = refresh(true);
      download(toJSON(conv), safeName(titleOf()) + '.json', 'application/json');
      flash('✅ 已下载 .json');
    });

    function flash(msg) {
      const el = panel.querySelector('#gce-msg');
      el.textContent = msg;
      setTimeout(() => { el.textContent = ''; }, 2500);
    }
  }

  function safeName(name) {
    return (name || 'gemini-chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  }

  /* ---------------- 控制台 API ---------------- */

  // 在 DevTools Console 里可直接调用：
  //   window.getGeminiConversation()                  → 结构化数组
  //   window.exportGeminiChat('md' | 'json')          → 复制到剪贴板
  window.getConversation = getConversation;
  window.getGeminiConversation = () => toJSON(getConversation());
  window.exportGeminiChat = async function (fmt = 'md') {
    const conv = getConversation();
    if (conv.length === 0) return console.warn('[GCE] 未抓取到对话');
    const text = fmt === 'json' ? toJSON(conv) : toMarkdown(conv);
    await copyText(text);
    console.log(`[GCE] 已复制 ${fmt.toUpperCase()}（${conv.length} 条消息）到剪贴板`);
    return text;
  };

  /* ---------------- 启动 ---------------- */

  function init() {
    if (window.top !== window.self) return; // 不在 iframe 中运行
    buildUI();
    console.log('[Gemini Chat Exporter] 已加载。控制台可用: getConversation() / exportGeminiChat("md"|"json")');
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // SPA 路由切换后按钮可能被顶掉：用 MutationObserver 事件驱动兜底，取代轮询（D7）。
  // 观察顶层 childList 即可（只关心按钮/面板直挂 body 的存亡）；buildUI 的重建
  // 本身也会触发回调，但 id 幂等检查使其空转，无死循环
  const ensureUI = () => {
    if (d.getElementById('gce-btn') && !d.getElementById('gce-panel')) {
      d.getElementById('gce-btn').remove();
      buildUI();
    } else if (!d.getElementById('gce-btn')) {
      buildUI();
    }
  };
  const uiObserver = new MutationObserver(ensureUI);
  uiObserver.observe(d.body || d.documentElement, { childList: true });
})();
