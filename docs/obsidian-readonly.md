# Obsidian → HALOFLUX：本地元数据快照（可选）

当前集成等级：**静态快照导入（可用），实时 Obsidian 插件（未实现）**。

这条通道只导入三个计数：笔记、已解析的有向链接、文件夹；**不读取笔记正文，不把笔记标题/路径/附件发到 Agent 事件桥**。网页内存中保留本次导入的数字，刷新即清空，不写入 localStorage。不能据此宣称正在“观察用户思维”或“AI 的思维链”。

## 从 Obsidian 导出

1. 在 Obsidian 桌面版打开目标 Vault，等待索引完成。
2. 打开开发者工具的 Console（需要自行启用），在信任本仓库代码并审阅后运行下列只读脚本。它不会修改 Vault。
3. 结果已复制到剪贴板，将其保存到本机 `obsidian-metadata.json`，核实里面只有 schema、三个数字与时间。
4. 打开 HALOFLUX 的 **Agent Monitor** 桌面宽屏界面，在 **OBSIDIAN / KNOWLEDGE FIELD** 点击 `IMPORT LOCAL METADATA JSON` 并选择该文件。

```javascript
// 在 Obsidian 的开发者控制台中运行；app 为 Obsidian 自身提供的对象。
const markdownFiles = app.vault.getMarkdownFiles();
const linkMap = app.metadataCache.resolvedLinks;
const resolvedLinkCount = Object.values(linkMap).reduce((sum, targets) =>
  sum + Object.values(targets).reduce((n, count) => n + count, 0), 0);
const folderCount = app.vault.getAllLoadedFiles()
  .filter(file => file.constructor?.name === 'TFolder').length;
copy(JSON.stringify({
  schema: 'haloflux.obsidian.metadata.v1',
  notes: markdownFiles.length,
  links: resolvedLinkCount,
  folders: folderCount,
  generatedAt: new Date().toISOString(),
}, null, 2));
```

`resolvedLinks` 是 Obsidian MetadataCache 已建立的链接缓存，尚未完成索引时数值可能不完整。`links` 是有向链接计数，而非去重后的无向边数。文件夹计数可能包含 Vault 根目录。该导出不含嵌入、未解析链接、附件的完整关系。

## 输入限制与隐私

- 只接收 schema=`haloflux.obsidian.metadata.v1`、三个非负安全整数（每项上限 5,000 万）和可选时间。
- 文件最大 64 KiB；不解析、呈现或保存未列入白名单的 JSON 属性。
- 只在用户主动选择文件时导入；不能自动访问 Vault；页面不能修改 Obsidian。
- 在 GitHub Pages 的演示中导入不会连接任何本地 Agent，数据依旧只存在当前浏览器页面。

## 后续：如果要做实时联动

设计一个独立 Obsidian 社区插件，通过用户明示授权的 Vault 与字段白名单来聚合 `metadataCache.resolvedLinks`、笔记数、文件夹数；本地只向 `127.0.0.1` 上的已鉴权桥提交聚合数据。插件默认断开，随时可撤销授权；无需发送笔记正文、路径、标题或节点 ID。建议增加速率限制、数据新鲜度、独立启停与删除缓存。**此实时插件尚不存在，不计入当前通过项目。**

官方 API：[Vault](https://docs.obsidian.md/Reference/TypeScript+API/Vault)、[MetadataCache](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache)。
