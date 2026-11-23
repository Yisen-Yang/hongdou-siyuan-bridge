# Hongdou → SiYuan Bridge

红豆（Hongdou）端的配套插件。装进红豆后，在文献上右键即可「发送到思源」，由思源端插件自动落笔。

红豆内核基于 Zotero 10，所以本插件是标准 **Zotero 7/10 `.xpi` 格式**。

---

## 安装

1. 下载 `hongdou-siyuan-bridge-0.3.0.xpi`；
2. 红豆 → 工具 → **插件中心** → 右上角「从文件安装」→ 选这个 xpi；
3. 按提示重启红豆；
4. 重启后菜单栏「工具」里应出现两项：
   - 红豆 ↔ 思源：显示配对码
   - 红豆 ↔ 思源：清空待发送队列

> **从早期测试版升级**：如果你装过 0.1–0.2 的测试版（插件 ID 带 `@example.com`），
> 请先在红豆「插件中心 → 已安装」里卸载它，再装本版本。否则两个插件会同时存在，
> 都尝试监听 18501 端口，导致发送不稳定。
>
> 如果安装时提示「文件损坏」，那是 manifest 缺少 `update_url` 的经典报错——
> 本包已修好，请确认下载的是 0.3.0 及以上版本。

---

## 配对

1. 红豆 → 工具 → **红豆 ↔ 思源：显示配对码**，弹窗里有 6 位数字，10 分钟有效；
2. 思源 → 设置 → 红豆文献联动 → **配对** → 输入这 6 位数字；
3. 配对成功后思源端会保存令牌，以后免配。

配对只在本机 `127.0.0.1` 进行，令牌存在红豆偏好设置里。

---

## 使用

1. 红豆里选中一篇文献（或在 PDF 阅读器中打开一篇）；
2. 右键 → **发送到思源**；
3. 切回思源，2–3 秒内光标处自动出现该文献的引用，文末自动补参考文献；
4. 多选文献可批量发送；重复发送会自动去重。

如果思源没开或没配对，文献会暂存在队列里（最多 20 批），等思源连上后再取。

---

## 提供的本地接口

默认监听 `127.0.0.1:18501`。除 `/ping`、`/pair` 外都需要请求头 `X-Hongdou-Token`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ping` | 健康检查：版本、端口、是否已配对、队列长度 |
| POST | `/pair` | 配对，body `{"code":"123456"}`，返回 `{token}` |
| GET | `/selected` | 红豆当前选中的文献（完整元数据 + 附件路径） |
| GET | `/item?id=510` | 按条目 ID 取单篇详情 |
| GET | `/attachments?id=510` | 附件列表，含 PDF 本地绝对路径 |
| GET | `/pending` | 取走待发送队列（取走即清空）；加 `?keep=1` 只读不清 |
| GET | `/queue` | 只看队列长度，不清空 |

返回的条目字段：

```
itemID, key, libraryID, itemType, title,
creators[{firstName,lastName,name,creatorType}], authors[], authorShort,
year, date, publication, journal, volume, issue, pages,
doi, isbn, issn, url, abstract, language, publisher,
tags[], attachments[{itemID,key,title,contentType,path,exists}]
```

示例：

```bash
curl http://127.0.0.1:18501/ping
# {"ok":true,"app":"hongdou-siyuan-bridge","version":"0.3.0","paired":false,"port":18501,...}

curl -X POST http://127.0.0.1:18501/pair \
  -H "Content-Type: application/json" -d '{"code":"417574"}'
# {"ok":true,"token":"..."}

curl -H "X-Hongdou-Token: <token>" http://127.0.0.1:18501/selected
```

---

## 实现要点（给二次开发）

- HTTP 服务用红豆内核自带的 `resource://zotero/httpd/httpd.sys.mjs`（**不是** `gre/modules/HttpServer.sys.mjs`）；
- 读选中文献用 `ZoteroPane.getSelectedItems()`，**不能传 `true`**（传 true 返回 ID 数组而非条目对象）；
- `open-pdf` 协议只认**文件附件**的 key，传父条目 key 会被静默丢弃；
- 响应体必须经 `nsIConverterOutputStream` 以 UTF-8 写出，直接 `response.write(string)` 会中文乱码。

---

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 安装提示「文件损坏」 | manifest 缺 `update_url`；用 0.3.0+ |
| 右键没有「发送到思源」 | 插件未启用或红豆未重启；到插件中心确认状态 |
| 思源收不到 | 端口不一致（思源设置里桥接端口要同样是 18501）；或未配对 |
| 配对总报「配对码不正确」 | 重新点一次菜单会生成新码，以最新弹窗为准；码 10 分钟过期 |
| 端口 18501 没监听 | 被占用或插件加载失败；查红豆 帮助 → 调试输出 |

---

## 许可

MIT
