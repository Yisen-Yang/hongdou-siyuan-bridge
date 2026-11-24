/* eslint-disable no-undef */
/**
 * Hongdou SiYuan Bridge — 红豆端插件（Zotero 7/10 通用格式）
 *
 * 职责边界（只做红豆侧才能做的三件事）：
 *   1. 6 位配对码鉴权，给思源端发本地 token
 *   2. 右键「发送到思源」把选中文献写入待办队列，等思源来拉
 *   3. 提供完整文献元数据 + 附件本地路径（思源端跳转 PDF 要用）
 *
 * 搜索、CSL 渲染等留在红豆 MCP（127.0.0.1:18500），不重复造。
 *
 * 关键实现依据（从红豆 omni.ja 里核实的官方写法）：
 *   - HttpServer 路径是 resource://zotero/httpd/httpd.sys.mjs（不是 gre/modules）
 *   - pane.getSelectedItems() 不传 true（传 true 返回 ID 数组而非对象）
 *   - item.itemType 直接可用，无需 ItemTypes.getName(itemTypeID)
 */

const PORT = 18501;
const PREF_PREFIX = "extensions.zotero.hongdouSYSBridge";
const VERSION = "0.3.1";
const QUEUE_MAX = 20;

let server = null;          // HttpServer 实例
let serverPort = -1;        // 实际监听端口
let pendingCode = null;     // 待校验的 6 位配对码
let pendingCodeAt = 0;      // 生成时间（10 分钟过期）
let queue = [];             // 待插入队列 [{at, items:[...]}]
let menuItems = [];         // 已插入的菜单项（防重复注册）
let menuListeners = [];     // 菜单事件监听（退出时清理）

/* ---------------- 基础工具 ---------------- */

function logMsg(msg) {
    try { Zotero.debug("[HongdouBridge] " + msg); } catch (e) { /* noop */ }
}

function prefGet(key, dflt) {
    try {
        const v = Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true);
        return v === undefined || v === null ? dflt : v;
    } catch (e) { return dflt; }
}

function prefSet(key, val) {
    try { Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, val, true); }
    catch (e) { logMsg("prefSet failed " + key + ": " + e); }
}

function genCode() {
    // 6 位数字
    let s = "";
    while (s.length < 6) s += String(Math.floor(Math.random() * 10));
    return s;
}

function genToken() {
    try {
        if (Zotero.Utilities && Zotero.Utilities.randomString) {
            return Zotero.Utilities.randomString(32);
        }
    } catch (e) { /* fallthrough */ }
    let s = "";
    for (let i = 0; i < 4; i++) {
        s += Math.random().toString(36).slice(2);
    }
    return (s + Date.now().toString(36)).slice(0, 32);
}

function getToken() {
    return prefGet("token", null);
}

/* ---------------- 文献元数据读取 ---------------- */

function safeField(item, name) {
    try { return item.getField(name) || ""; } catch (e) { return ""; }
}

/** 作者列表 → { creators:[{first,last,type}], author:"Smith et al." } */
function readCreators(item) {
    const creators = [];
    try {
        const list = item.getCreators() || [];
        for (const c of list) {
            creators.push({
                firstName: c.firstName || "",
                lastName: c.lastName || "",
                name: c.name || "",
                creatorType: c.creatorType || "author",
            });
        }
    } catch (e) { /* noop */ }
    return creators;
}

/** 从 date 字段抓 4 位年份 */
function readYear(item) {
    const d = String(safeField(item, "date") || "");
    const m = d.match(/(1[5-9]\d{2}|20\d{2}|21\d{2})/);
    return m ? m[1] : "";
}

/** 附件列表（含本地绝对路径，思源端跳转 PDF 用） */
function readAttachments(item) {
    const out = [];
    let ids = [];
    try { ids = item.getAttachments() || []; } catch (e) { return out; }
    for (const id of ids) {
        try {
            const att = Zotero.Items.get(id);
            if (!att) continue;
            let path = null;
            try { path = att.getFilePath(); } catch (e) { path = null; }
            out.push({
                itemID: att.id,
                key: att.key || "",
                title: safeField(att, "title"),
                contentType: att.attachmentContentType || "",
                path: path || null,
                exists: !!path,
            });
        } catch (e) { /* 跳过坏附件 */ }
    }
    return out;
}

/** 单篇文献完整信息 */
function itemDetail(item) {
    const creators = readCreators(item);
    const names = creators
        .filter(c => c.creatorType === "author" || !c.creatorType)
        .map(c => c.lastName || c.name)
        .filter(Boolean);

    let authorShort = "";
    if (names.length === 1) authorShort = names[0];
    else if (names.length === 2) authorShort = names[0] + " & " + names[1];
    else if (names.length > 2) authorShort = names[0] + " et al.";

    const itemType = item.itemType || "";
    const detail = {
        itemID: item.id,
        key: item.key || "",
        libraryID: item.libraryID,
        itemType: itemType,
        title: safeField(item, "title"),
        creators: creators,
        authors: names,
        authorShort: authorShort,
        year: readYear(item),
        date: safeField(item, "date"),
        // 期刊/会议/书名三选一
        publication:
            safeField(item, "publicationTitle") ||
            safeField(item, "bookTitle") ||
            safeField(item, "proceedingsTitle") ||
            safeField(item, "websiteTitle") ||
            "",
        journal: safeField(item, "publicationTitle"),
        volume: safeField(item, "volume"),
        issue: safeField(item, "issue"),
        pages: safeField(item, "pages"),
        doi: safeField(item, "DOI"),
        isbn: safeField(item, "ISBN"),
        issn: safeField(item, "ISSN"),
        url: safeField(item, "url"),
        abstract: safeField(item, "abstractNote"),
        language: safeField(item, "language"),
        publisher: safeField(item, "publisher"),
        tags: [],
        attachments: [],
    };

    try {
        const tags = item.getTags() || [];
        detail.tags = tags.map(t => t.tag).filter(Boolean);
    } catch (e) { /* noop */ }

    // 只有普通文献条目才去读附件（附件条目自身没有子附件）
    try {
        if (item.isRegularItem && item.isRegularItem()) {
            detail.attachments = readAttachments(item);
        }
    } catch (e) { /* noop */ }

    return detail;
}

/** 取当前主窗口 ZoteroPane（含阅读器标签页的父文献） */
function getPane() {
    try {
        const win = Zotero.getMainWindow();
        if (!win || win.closed) return null;
        return win.ZoteroPane || null;
    } catch (e) { return null; }
}

/**
 * 当前选中的文献。
 * 修 bug：getSelectedItems() 不能传 true（true 返回 ID 数字数组）。
 * 额外支持：当前标签是 PDF 阅读器时，返回该附件对应的父文献。
 */
function getSelectedItems(limit) {
    const out = [];
    const seen = new Set();
    const push = (item) => {
        if (!item || seen.has(item.id)) return;
        // 跳过附件/笔记本身，但它们有父条目时用父条目
        try {
            if (item.isAttachment && item.isAttachment()) {
                const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
                if (parent && !seen.has(parent.id)) {
                    seen.add(parent.id);
                    out.push(itemDetail(parent));
                }
                return;
            }
            if (item.isNote && item.isNote()) {
                const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
                if (parent && !seen.has(parent.id)) {
                    seen.add(parent.id);
                    out.push(itemDetail(parent));
                }
                return;
            }
        } catch (e) { /* noop */ }
        seen.add(item.id);
        out.push(itemDetail(item));
    };

    const pane = getPane();
    if (!pane) return out;
    const max = limit && limit > 0 ? limit : 50;

    // 1) 文献列表选中
    try {
        const selected = pane.getSelectedItems ? pane.getSelectedItems() : [];
        for (const item of selected) {
            if (out.length >= max) break;
            push(item);
        }
    } catch (e) { logMsg("getSelectedItems failed: " + e); }

    // 2) 阅读器标签页（选中列表为空时兜底）
    if (out.length === 0) {
        try {
            const tabs = Zotero.getMainWindow().Zotero_Tabs;
            if (tabs && tabs.selectedType === "reader") {
                const reader = Zotero.Reader.getByTabID(tabs.selectedID);
                const itemID = reader && reader.itemID;
                if (itemID) {
                    const att = Zotero.Items.get(itemID);
                    if (att) push(att);
                }
            }
        } catch (e) { logMsg("reader focus failed: " + e); }
    }

    return out;
}

/** 按 id 取单篇 */
function getItemDetail(id) {
    const n = parseInt(id, 10);
    if (!n || n <= 0) return null;
    const item = Zotero.Items.get(n);
    if (!item) return null;
    return itemDetail(item);
}

/* ---------------- HTTP 基础设施 ---------------- */

function sendJSON(response, status, obj) {
    try {
        const text = JSON.stringify(obj);
        response.setStatusLine(null, status, status === 200 ? "OK" : "Error");
        response.setHeader("Content-Type", "application/json; charset=utf-8", false);
        response.setHeader("Access-Control-Allow-Origin", "*", false);
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS", false);
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Hongdou-Token", false);
        response.setHeader("Cache-Control", "no-store", false);
        // 中文必须走 UTF-8 转换流，直接 response.write(string) 会按 Latin-1 输出乱码
        const intlStream = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
            .createInstance(Components.interfaces.nsIConverterOutputStream);
        intlStream.init(response.bodyOutputStream, "UTF-8", 1024, 0x3F);
        intlStream.writeString(text);
        intlStream.close();
    } catch (e) {
        logMsg("sendJSON failed: " + e);
    }
}

function readBody(request) {
    try {
        // 必须按 Content-Length 读；nsIInputStream.read() 不能只传长度
        let len = 0;
        try { len = parseInt(request.getHeader("Content-Length") || "0", 10); }
        catch (e) { len = 0; }
        const stream = request.bodyInputStream;
        if (!len || len <= 0) {
            try { len = stream.available(); } catch (e) { len = 0; }
        }
        if (!len || len <= 0) return "";

        // 优先用 Zotero 自带工具（内部 NetUtil + decodeUTF8）
        try {
            if (Zotero.Server && Zotero.Server.networkStreamToString) {
                return Zotero.Server.networkStreamToString(stream, len);
            }
        } catch (e) {
            logMsg("networkStreamToString failed: " + e);
        }

        // 兜底：ScriptableInputStream
        const sis = Components.classes["@mozilla.org/scriptableinputstream;1"]
            .createInstance(Components.interfaces.nsIScriptableInputStream);
        sis.init(stream);
        const raw = sis.read(len);
        sis.close();
        try { return decodeURIComponent(escape(raw)); } catch (e) { return raw; }
    } catch (e) {
        logMsg("readBody failed: " + e);
        return "";
    }
}

function parseQuery(request) {
    const out = {};
    try {
        const q = request.queryString || "";
        for (const pair of q.split("&")) {
            if (!pair) continue;
            const idx = pair.indexOf("=");
            const k = idx < 0 ? pair : pair.slice(0, idx);
            const v = idx < 0 ? "" : pair.slice(idx + 1);
            out[decodeURIComponent(k)] = decodeURIComponent(v);
        }
    } catch (e) { /* noop */ }
    return out;
}

/** 取请求里的 token（header 或 query） */
function requestToken(request) {
    try {
        const h = request.getHeader("X-Hongdou-Token");
        if (h) return h;
    } catch (e) { /* noop */ }
    return parseQuery(request).token || "";
}

/** 除 ping/pair 外都要 token 校验 */
function requireAuth(request, response, q) {
    const stored = getToken();
    if (!stored) {
        sendJSON(response, 403, { ok: false, error: "NOT_PAIRED", message: "尚未配对，请先在红豆里显示配对码并在思源端输入" });
        return false;
    }
    const got = requestToken(request) || (q && q.token) || "";
    if (got !== stored) {
        sendJSON(response, 401, { ok: false, error: "BAD_TOKEN", message: "配对令牌无效，请重新配对" });
        return false;
    }
    return true;
}

/* ---------------- 路由处理 ---------------- */

function handlePing(request, response) {
    sendJSON(response, 200, {
        ok: true,
        app: "hongdou-siyuan-bridge",
        version: VERSION,
        paired: !!getToken(),
        port: serverPort,
        queue: queue.length,
        hongdouVersion: (() => { try { return Zotero.version; } catch (e) { return ""; } })(),
    });
}

function handlePair(request, response) {
    if (request.method === "OPTIONS") { sendJSON(response, 200, { ok: true }); return; }
    try {
        const body = JSON.parse(readBody(request) || "{}");
        const code = String(body.code || "").trim();

        // 优先用内存里的码；内存丢了（插件重载）就退回 prefs 里持久化的
        let expect = pendingCode;
        let expectAt = pendingCodeAt;
        if (!expect) {
            expect = prefGet("pendingCode", null);
            expectAt = prefGet("pendingCodeAt", 0);
        }
        if (!expect) {
            sendJSON(response, 400, { ok: false, error: "NO_PENDING_CODE", message: "红豆端还没有生成配对码，请先在红豆里点「显示配对码」" });
            return;
        }
        if (Date.now() - expectAt > 10 * 60 * 1000) {
            pendingCode = null;
            prefSet("pendingCode", "");
            sendJSON(response, 400, { ok: false, error: "CODE_EXPIRED", message: "配对码已过期（10 分钟），请重新生成" });
            return;
        }
        if (code !== expect) {
            sendJSON(response, 403, { ok: false, error: "BAD_CODE", message: "配对码不正确" });
            return;
        }
        const token = genToken();
        prefSet("token", token);
        prefSet("pairedAt", Date.now());
        prefSet("pendingCode", "");
        pendingCode = null;
        sendJSON(response, 200, { ok: true, token: token, app: "hongdou-siyuan-bridge", version: VERSION });
        logMsg("paired ok");
    } catch (e) {
        sendJSON(response, 400, { ok: false, error: "BAD_REQUEST", message: String(e) });
    }
}

function handleSelected(request, response, q) {
    if (!requireAuth(request, response, q)) return;
    try {
        const items = getSelectedItems(parseInt(q.limit, 10) || 50);
        sendJSON(response, 200, { ok: true, items: items, count: items.length });
    } catch (e) {
        sendJSON(response, 500, { ok: false, error: "READ_FAILED", message: String(e) });
    }
}

function handleItem(request, response, q) {
    if (!requireAuth(request, response, q)) return;
    try {
        const d = getItemDetail(q.id);
        if (!d) { sendJSON(response, 404, { ok: false, error: "NOT_FOUND" }); return; }
        sendJSON(response, 200, { ok: true, item: d });
    } catch (e) {
        sendJSON(response, 500, { ok: false, error: "READ_FAILED", message: String(e) });
    }
}

function handleAttachments(request, response, q) {
    if (!requireAuth(request, response, q)) return;
    try {
        const item = Zotero.Items.get(parseInt(q.id, 10) || 0);
        if (!item) { sendJSON(response, 404, { ok: false, error: "NOT_FOUND" }); return; }
        const atts = readAttachments(item);
        // 优先给出 PDF 的本地路径
        const pdf = atts.find(a => a.exists && String(a.contentType).toLowerCase().indexOf("pdf") >= 0) || null;
        sendJSON(response, 200, { ok: true, attachments: atts, pdf: pdf });
    } catch (e) {
        sendJSON(response, 500, { ok: false, error: "READ_FAILED", message: String(e) });
    }
}

/** 思源端拉取待插入队列（取走即清空） */
function handlePending(request, response, q) {
    if (!requireAuth(request, response, q)) return;
    try {
        const take = q.keep !== "1";
        const items = [];
        for (const batch of queue) {
            for (const it of batch.items) items.push(it);
        }
        if (take) queue = [];
        sendJSON(response, 200, { ok: true, items: items, count: items.length, cleared: take });
    } catch (e) {
        sendJSON(response, 500, { ok: false, error: "READ_FAILED", message: String(e) });
    }
}

/** 只 peek 不清空 */
function handleQueueInfo(request, response, q) {
    if (!requireAuth(request, response, q)) return;
    sendJSON(response, 200, { ok: true, count: queue.length, batches: queue.length });
}

var ROUTES = {
    "/ping": handlePing,
    "/pair": handlePair,
    "/selected": handleSelected,
    "/item": handleItem,
    "/attachments": handleAttachments,
    "/pending": handlePending,
    "/queue": handleQueueInfo,
};

function dispatch(request, response) {
    let path = "/";
    try { path = request.path || "/"; } catch (e) { path = "/"; }
    // 去掉可能的尾部斜杠
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const handler = ROUTES[path];
    if (!handler) {
        sendJSON(response, 404, { ok: false, error: "NO_ROUTE", path: path, routes: Object.keys(ROUTES) });
        return;
    }
    if (request.method === "OPTIONS") { sendJSON(response, 200, { ok: true }); return; }
    const q = parseQuery(request);
    try {
        handler(request, response, q);
    } catch (e) {
        logMsg("dispatch error " + path + ": " + e);
        sendJSON(response, 500, { ok: false, error: "INTERNAL", message: String(e) });
    }
}

function startServer() {
    try {
        const { HttpServer } = ChromeUtils.importESModule(
            "resource://zotero/httpd/httpd.sys.mjs"
        );
        server = new HttpServer();
        server.registerPrefixHandler("/", dispatch);
        try {
            server.start(PORT);
        } catch (e) {
            logMsg("fixed port " + PORT + " busy, fallback: " + e);
            server.start(-1);
        }
        serverPort = server.identity.primaryPort;
        prefSet("port", serverPort);
        logMsg("server started on " + serverPort);
        return serverPort;
    } catch (e) {
        logMsg("startServer failed: " + e);
        return -1;
    }
}

function stopServer() {
    try {
        if (server) { server.stop(); server = null; }
    } catch (e) { /* noop */ }
}

/* ---------------- 配对码 UI ---------------- */

function showPairingDialog() {
    pendingCode = genCode();
    pendingCodeAt = Date.now();
    // 持久化，便于排查/重启后仍可用（10 分钟有效）
    prefSet("pendingCode", pendingCode);
    prefSet("pendingCodeAt", pendingCodeAt);

    const pane = getPane();
    const win = pane ? pane.document.defaultView : null;
    const msg =
        "在「思源 → 红豆文献联动」的设置里输入下面这 6 位数字完成配对：\n\n" +
        "              " + pendingCode + "\n\n" +
        "10 分钟内有效。全程只在本机 127.0.0.1 通信，不联网。";
    try {
        Services.prompt.alert(win || Zotero.getMainWindow(), "红豆 ↔ 思源 配对码", msg);
    } catch (e) {
        logMsg("alert failed: " + e);
    }
    logMsg("pairing code generated: " + pendingCode);
}

/* ---------------- 右键菜单 ---------------- */

function showToast(text) {
    try {
        const pw = new Zotero.ProgressWindow();
        pw.changeHeadline("红豆 ↔ 思源");
        pw.addDescription(text);
        pw.show();
        pw.startCloseTimer(2600);
    } catch (e) {
        logMsg("toast failed: " + e);
    }
}

/** 右键「发送到思源」：写入待办队列，等思源端拉 */
function onSendToSiyuan() {
    try {
        const items = getSelectedItems(20);
        if (!items.length) {
            Services.prompt.alert(
                Zotero.getMainWindow(),
                "发送到思源",
                "请先在红豆中选中一篇文献（或在 PDF 阅读器中打开一篇文献）。"
            );
            return;
        }

        // 去重：队列里已有的 itemID 不再重复入队
        const queued = new Set();
        for (const b of queue) for (const it of b.items) queued.add(it.itemID);
        const fresh = items.filter(it => !queued.has(it.itemID));

        if (!fresh.length) {
            showToast("已在待发送队列中，无需重复发送");
            return;
        }

        queue.push({ at: Date.now(), items: fresh });
        while (queue.length > QUEUE_MAX) queue.shift();

        if (!getToken()) {
            // 未配对：提示先配对
            Services.prompt.alert(
                Zotero.getMainWindow(),
                "发送到思源",
                "已暂存 " + fresh.length + " 篇文献。\n\n" +
                "但还没和思源配对——请先在红豆里运行「红豆 ↔ 思源：显示配对码」，" +
                "再把配对码输入思源的插件设置。配对后思源即可取走这些文献。"
            );
        } else {
            showToast("已发送 " + fresh.length + " 篇文献到思源待办队列");
        }
        logMsg("queued " + fresh.length + " items, queue=" + queue.length);
    } catch (e) {
        logMsg("sendToSiyuan failed: " + e);
    }
}

/** 清空待办队列 */
function onClearQueue() {
    queue = [];
    showToast("已清空待发送队列");
}

function makeMenuItem(doc, id, label, handler) {
    const mi = doc.createXULElement("menuitem");
    mi.setAttribute("id", id);
    mi.setAttribute("label", label);
    mi.addEventListener("command", handler);
    return mi;
}

function buildMenu() {
    try {
        const pane = getPane();
        if (!pane || !pane.document) return;
        const doc = pane.document;

        // 防重复：已存在就跳过
        if (doc.getElementById("hongdou-sys-send")) return;

        // 1) 条目右键菜单
        const itemMenu = doc.getElementById("zotero-itemmenu");
        if (itemMenu) {
            const sep = doc.createXULElement("menuseparator");
            sep.setAttribute("id", "hongdou-sys-sep");
            const mi = makeMenuItem(doc, "hongdou-sys-send", "发送到思源", onSendToSiyuan);
            itemMenu.appendChild(sep);
            itemMenu.appendChild(mi);
            menuItems.push(sep, mi);

            // 每次打开右键菜单都刷新一下待发送数量，别让用户猜
            const refreshLabel = () => {
                try {
                    const el = doc.getElementById("hongdou-sys-send");
                    if (!el) return;
                    const n = queue.reduce((s2, b) => s2 + ((b && b.items) ? b.items.length : 0), 0);
                    el.setAttribute("label", n > 0 ? `发送到思源（队列 ${n} 篇）` : "发送到思源");
                } catch (e) { logMsg("refreshLabel failed: " + e); }
            };
            itemMenu.addEventListener("popupshowing", refreshLabel);
            menuListeners.push({ el: itemMenu, type: "popupshowing", fn: refreshLabel });
        }

        // 2) 工具菜单入口（显示配对码 / 清空队列）
        const toolsMenu = doc.getElementById("menu_ToolsPopup");
        if (toolsMenu) {
            const sep2 = doc.createXULElement("menuseparator");
            sep2.setAttribute("id", "hongdou-sys-tools-sep");
            const miPair = makeMenuItem(doc, "hongdou-sys-pair", "红豆 ↔ 思源：显示配对码", showPairingDialog);
            const miClear = makeMenuItem(doc, "hongdou-sys-clear", "红豆 ↔ 思源：清空待发送队列", onClearQueue);
            toolsMenu.appendChild(sep2);
            toolsMenu.appendChild(miPair);
            toolsMenu.appendChild(miClear);
            menuItems.push(sep2, miPair, miClear);
        }
    } catch (e) {
        logMsg("buildMenu failed: " + e);
    }
}

function removeMenu() {
    for (const l of menuListeners) {
        try { if (l.el && l.fn) l.el.removeEventListener(l.type, l.fn); } catch (e) { /* noop */ }
    }
    menuListeners = [];
    for (const el of menuItems) {
        try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* noop */ }
    }
    menuItems = [];
}

/* ---------------- 生命周期 ---------------- */

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
    await Zotero.initializationPromise;

    if (!rootURI && resourceURI) rootURI = resourceURI.spec;

    // 注册 chrome 资源（供 icon 等使用）
    try {
        const aomStartup = Components.classes[
            "@mozilla.org/addons/addon-manager-startup;1"
        ].getService(Components.interfaces.amIAddonManagerStartup);
        const manifestURI = Services.io.newURI(rootURI + "manifest.json");
        aomStartup.registerChrome(manifestURI, [
            ["content", "hongdousys", rootURI + "chrome/content/"],
        ]);
    } catch (e) {
        logMsg("registerChrome failed: " + e);
    }

    // 恢复已配对状态
    const port = startServer();
    buildMenu();
    // 重启后旧配对码作废，避免和上次残留的码混淆
    prefSet("pendingCode", "");
    pendingCode = null;
    logMsg(`startup done v${VERSION}, port=${port}, paired=${!!getToken()}`);
}

async function onMainWindowLoad({ window }, reason) {
    buildMenu();
}

async function onMainWindowUnload({ window }, reason) {
    removeMenu();
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
    if (reason === APP_SHUTDOWN) return;
    removeMenu();
    stopServer();
    logMsg("shutdown");
}

function uninstall(data, reason) {}
