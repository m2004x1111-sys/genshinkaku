# kakuyomub2-genshin（GenshinUI 美化版）

カクヨム 小说下载 & 日语朗读工具 —— 基于 **Vue 3 + Vite + [GenshinUI](https://shi-zhong.github.io/genshin-ui-docs/)**（原神风格 UI 组件库）的美化版。

保留 [kakuyomub2-web](../kakuyomub2-web/)（纯前端零构建版）的全部功能，界面用 GenshinUI 组件重写：按钮、下拉、开关、弹窗、消息提示均为原神风格。

## 功能

| 功能 | 说明 |
|------|------|
| 在线抓取 | 输入作品 ID/URL，CORS 代理抓取元数据 + 章节树 + 正文 |
| 章节树 | 扁平 / 树状 / 混合三种目录结构，递归组件展示 |
| 朗读播放 | edge-tts（ななみ/けいた）+ 语速/音调/倍速/音量 |
| 单话 MP3 | Edge 浏览器下保存到"下载"文件夹 |
| 批量 MP3 | 全部话合成后打包 ZIP 下载 |
| EPUB | 客户端生成 EPUB3 |
| 浏览器语音 | 非 Edge 自动降级 Web Speech API |
| 本地缓存 | IndexedDB 缓存正文 |

## 使用

```bash
# 方式一：双击「启动网页.bat」（自动安装依赖并打开浏览器）
# 方式二：手动
npm install
npm run dev        # 开发，浏览器访问 http://localhost:5173
npm run build      # 生产构建到 dist/
npm run preview    # 预览构建产物
```

1. 用 **Microsoft Edge**（143+）体验完整功能（MP3 导出/批量/ZIP）
2. 输入作品 ID（如 `16817330668128729529`）→ 点击「读取」
3. 点击左侧章节开始朗读；「EPUB」「全话 MP3」分别导出

## 技术要点

- **GenshinUI**：全局注册，组件带 `G` 前缀（`<GButton>` `<GSelect>` `<GSwitch>` `<GModal>`）；`Message` 用于消息提示
- **edge-tts**：纯 JS 复刻 WebSocket 协议（Sec-MS-GEC 令牌 / SSML / `Path:audio` 解析），MP3 产出已通过帧级验证
- **抓取**：解析 `__NEXT_DATA__` 的 Apollo State → 章节树；公共代理 allorigins/corsproxy 自动回退 + 重试，设置里可配自建代理
- **ZIP/EPUB**：自写最小 ZIP 写入器（STORED + CRC32），零额外依赖
- 说明：微软语音服务校验 User-Agent（要求 `Edg/143+`），故仅新版 **Edge** 支持完整 MP3 导出；其他浏览器降级为浏览器内置语音

## 目录结构

```
kakuyomub2-genshin/
├── index.html
├── package.json
├── vite.config.js
├── 启动网页.bat
└── src/
    ├── main.js              # Vue 入口 + GenshinUI 引入
    ├── style.css            # 全局样式（原神风深色背景）
    ├── App.vue              # 主界面（头部/章节树/播放器/批量/设置/加载）
    ├── components/
    │   └── ChapterNode.vue  # 递归章节树
    └── lib/                 # 业务逻辑（ES 模块，与零构建版共用）
        ├── config.js        # 代理/音色/语速配置
        ├── util.js          # SHA-256、字节切分、转义
        ├── proxy.js         # CORS 代理请求
        ├── storage.js       # IndexedDB 缓存
        ├── kakuyomu.js      # 章节树解析 + 正文提取
        ├── edge-tts.js      # 浏览器版 edge-tts
        ├── zip.js           # 最小 ZIP 写入器
        ├── epub.js          # EPUB 生成
        └── player.js        # 播放控制（MSE 流式 + 语音回退）
```

## 常见问题

- **抓取失败/超时**：公共代理不稳定。点击 ⚙ 设置 →「测试代理」，或填写自建代理模板 `https://your-proxy.com/?url={url}`
- **无声音/提示浏览器语音**：请在最新版 Microsoft Edge 中打开
- **首次启动慢**：`npm install` 需下载依赖
