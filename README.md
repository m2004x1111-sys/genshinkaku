# kakuyomub2-genshin（GenshinUI 美化版）

カクヨム 小说下载 & 日语朗读工具 —— 基于 **Vue 3 + Vite + [GenshinUI](https://shi-zhong.github.io/genshin-ui-docs/)**（原神风格 UI 组件库）的美化版。

保留 [kakuyomub2-web](../kakuyomub2-web/)（纯前端零构建版）的全部功能，界面用 GenshinUI 组件重写：按钮、下拉、开关、弹窗、消息提示均为原神风格。

## 功能

| 功能 | 说明 |
|------|------|
| 在线抓取 | 输入作品 ID/URL，抓取元数据 + 章节树 + 正文（本地中转直连，或 CORS 代理回退） |
| 章节树 | 扁平 / 树状 / 混合三种目录结构，递归组件展示 |
| 朗读播放 | edge-tts（ななみ/けいた）+ 语速/音调/倍速/音量 |
| 单话 MP3 | 任何浏览器都可保存到"下载"文件夹 |
| 批量 MP3 | 全部话合成后打包 ZIP 下载 |
| EPUB | 客户端生成 EPUB3 |
| 浏览器语音 | 无本地服务时非 Edge 自动降级 Web Speech API |
| 本地缓存 | IndexedDB 缓存正文 |

## 使用

**推荐：本地中转模式（推荐，任何浏览器/手机都能放 MP3）**

```bash
# 方式一：双击「启动网页.bat」（自动安装依赖、构建并启动本地服务）
# 方式二：手动
npm install
npm run build
npm run serve      # 启动 http://localhost:5174
```

- 本机访问：`http://localhost:5174`
- 手机同网访问：`http://<本机局域网IP>:5174`
- 该模式下：抓取由本地服务**直连 kakuyomu**（无需免费公共代理、无 CORS 限制）；MP3 由本地服务以正确 UA 合成（**不再要求 Edge，Chrome/Firefox/手机均可播放与导出**）

**备选：纯前端模式**（需要 Microsoft Edge 143+，走公共代理）

```bash
npm run dev        # 开发，浏览器访问 http://localhost:5173
npm run preview    # 预览构建产物
```

## 技术要点

- **GenshinUI**：全局注册，组件带 `G` 前缀（`<GButton>` `<GSelect>` `<GSwitch>` `<GModal>`）；`Message` 用于消息提示
- **本地中转服务器（server.js）**：静态托管 + `/api/proxy`（服务器端直连抓取）+ `/api/tts`（服务器端 edge-tts 流式合成）；浏览器检测到 `/api/ping` 即自动切换中转模式
- **edge-tts**：纯 JS 复刻 WebSocket 协议（Sec-MS-GEC 令牌 / SSML / `Path:audio` 解析）；微软服务校验 User-Agent 要求 `Edg/143+`，浏览器无法改头，故中转模式下由服务器端带正确 UA 连接
- **抓取**：解析 `__NEXT_DATA__` 的 Apollo State → 章节树；中转优先，公共代理（r.jina.ai/allorigins/corsproxy）自动回退 + 重试，设置里可配自建代理
- **ZIP/EPUB**：自写最小 ZIP 写入器（STORED + CRC32），零额外依赖

## 目录结构

```
kakuyomub2-genshin/
├── index.html
├── package.json
├── vite.config.js
├── server.js               # 本地中转服务器（静态 + /api/proxy + /api/tts）
├── 启动网页.bat            # 一键构建并启动本地服务
└── src/
    ├── main.js              # Vue 入口 + GenshinUI 引入
    ├── style.css            # 全局样式（原神风深色背景）
    ├── App.vue              # 主界面（头部/章节树/播放器/批量/设置/加载）
    ├── components/
    │   └── ChapterNode.vue  # 递归章节树
    └── lib/                 # 业务逻辑（ES 模块）
        ├── config.js        # 代理/音色/语速配置
        ├── util.js          # SHA-256、字节切分、转义
        ├── relay.js         # 本地中转模式检测
        ├── proxy.js         # 抓取（中转优先 + CORS 代理回退）
        ├── storage.js       # IndexedDB 缓存
        ├── kakuyomu.js      # 章节树解析 + 正文提取
        ├── edge-tts.js      # TTS（中转流式 / 浏览器 WS）
        ├── zip.js           # 最小 ZIP 写入器
        ├── epub.js          # EPUB 生成
        └── player.js        # 播放控制（MSE 流式 + 语音回退）
```

## 常见问题

- **抓取失败/超时**：建议用「启动网页.bat」走本地中转模式（服务器直连 kakuyomu）。纯前端模式则点击 ⚙ 设置 →「测试代理」，或填写自建代理模板
- **手机放不了/非 Edge 无声音**：请用「启动网页.bat」启动本地服务后，手机访问 `http://<本机IP>:5174`（中转模式任意浏览器均可放 MP3）；纯前端模式才要求 Edge
- **必须挂代理才能访问卡古ヨム**：这是网络层面的限制（卡古ヨム在你网络不可达）。本地中转模式在你网络可达 kakuyomu 时即可直连，不再依赖第三方公共代理
- **首次启动慢**：`npm install` 需下载依赖
