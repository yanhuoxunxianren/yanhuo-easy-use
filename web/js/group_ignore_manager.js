/**
 * 组忽略管理器 · Group Ignore Manager（yanhuo 版）
 * ---------------------------------------------------------------
 * 功能：
 *   1. 自由添加要管理的组，支持拖拽排序
 *   2. 一键开启 / 忽略某个组（切换组内节点的 mode：ALWAYS=0 / BYPASS=4）
 *   3. 每个组可配置「组开启时」「组关闭时」两组联动规则
 *   4. 两种管理模式：自定义（手动挑组）/ 按颜色（同色组一起管理）
 *      · 自定义模式**默认为空列表**，必须点「+ 添加组」自行挑选（fix3 起）
 *      · 按颜色模式规则不变：自动纳入当前颜色命中的全部组
 *   5. 切换限制（顶栏，位于「自定义/按颜色」与「+ 添加组」之间）：
 *      · 默认 —— 各组开/关互不影响，可同时开启多个
 *      · 只开启一个 —— 打开某组时其余受管组自动忽略（类似 max one）
 *   6. 名称排序与检索（fix4）：
 *      · 所有选择列表按字母 / 拼音序（`Intl.Collator` + numeric，组名里的数字按数值排）
 *      · 「添加组」弹窗顶部搜索框，按名检索；空格分隔多个关键词为 AND
 *        （「图」命中所有含"图"的；「图像 加载」只命中同时含两者的）
 *      · 「添加组」弹窗左下角「全选」，只作用于**当前搜索结果**
 *      · 「联动配置」的目标组下拉换成可搜索下拉
 *   7. 一键定位到组（画布视图跳转）
 *
 * 与旧版 GroupIgnoreManager 的关键差异（也是重写的理由）：
 *   旧版把函数、Set、DOM 引用等不可结构化克隆的对象直接挂在节点实例上，
 *   新版 ComfyUI 前端保存工作流时会对节点做 structuredClone，于是抛出
 *   "Failed to execute 'structuredClone' on 'Window': [object Array] could not be cloned"。
 *
 *   本实现严格遵守三条规则，从根上规避：
 *     R1. 运行时对象（DOM、事件处理器、定时器、临时标记）一律放模块级 WeakMap，
 *         绝不作为属性挂到 node 上；
 *     R2. 需要持久化的数据只写 node.properties[PROPS_KEY]，并保证是纯 JSON；
 *     R3. DOM widget 显式 serialize:false，并覆写 serializeValue，
 *         确保 DOM 元素绝不会进入 widgets_values。
 *
 * ---------------------------------------------------------------
 * build 2026-09-22-fix2 —— 修「能加载但开关是灰的、点了没反应」
 *
 *   根因（唯一）：新版前端里 `LGraphGroup._children` 是**懒计算容器，初始为空**，
 *     必须先调 `group.recomputeInsideNodes()` 才会被填充。
 *     此前从未调用 → `groupNodes()` 恒返回空 → 面板给每个组打上「空组」徽标
 *     → `isGroupEnabled()` 恒为 false → 开关永远是灰的，点击也改不动任何节点。
 *     依据：settingStore-*.js 里
 *       recomputeInsideNodes(){ ... let a=this._children; this._nodes.length=0; a.clear();
 *         for(let e of n) containsCentre(...) && (this._nodes.push(e), a.add(e)); ... }
 *     且原生右键菜单 / Fit Group / 选择组 / 转到子图，全都是「先 recompute 再读」。
 *
 *   顺带修正（不是本次故障的原因，只是加固，别误记）：
 *     - isLGraphNode 改为优先用 graph.getNodeById() 反查。
 *       原先靠 `window.LiteGraph.LGraphNode` 的 instanceof 兜住了（前端确实通过
 *       useGlobalLitegraph() 挂了全局），所以没出事；但依赖全局变量不稳，
 *       而后备分支里的 `Array.isArray(obj.pos)` 在新版恒为 false
 *       （`get pos(){ return nodePositionView(this) }` 返回 Float64Array 视图），
 *       一旦全局没了就会静默判空，故改成不依赖全局的写法。
 *
 *   对齐原生行为的另外两点：
 *     - 改完 mode 要 canvas.setDirty + graph.change()，否则外观/脏标记不更新；
 *     - 不再递归进子图内部改内部节点 mode（原生也不改，避免覆盖用户设置）。
 *
 * ---------------------------------------------------------------
 * build 2026-09-22-fix3 —— 两条需求
 *
 *   1. 「自定义」模式默认空列表：删掉旧的「!initialized 就自动填满所有组」逻辑，
 *      order 只装用户点「+ 添加组」挑出来的组。「按颜色」模式规则不变。
 *      附带一次性迁移（STATE_VERSION 1→2）：若 order 覆盖了图里全部组，
 *      判定为旧版自动填充 → 清空。真子集（用户挑过）保持不动。
 *
 *   2. 新增「切换限制」（st.restriction）：默认 / 只开启一个。
 *      只开启一个 = 打开某组时，把**受管组**（面板当前列出的那些）里其余的全部忽略。
 *      只由「点击组开关」驱动：仅切换下拉框不改动画布，避免静默 bypass 掉用户开着的组。
 *      与既有联动功能的冲突处理（关键）：
 *        - 清扫只发生在**最外层**调用（用户直接点击）。级联过程中不再清扫，
 *          否则 A 的联动刚打开 D，D 的清扫就会把刚点开的 A 关掉，互相打架。
 *        - 清扫用 setGroupEnabledRaw（只改 mode，不触发联动），
 *          避免把别组的 onDisable 规则一起引爆。
 *        - 清扫后才执行被点组自己的联动规则，规则里显式打开的组**保留**
 *          —— 那是用户自己配的规则，不算冲突。
 *
 * ---------------------------------------------------------------
 * build 2026-09-23-fix4 —— 排序 / 搜索 / 全选
 *
 *   排序与「拖拽排序」本来是冲突的，处理办法：
 *     · 自定义模式默认按字母序显示（`orderManual === false`）
 *     · 用户一旦拖拽，`orderManual = true`，完全按用户顺序显示
 *     · 顶栏加「按名称排序」按钮，一点即恢复字母序
 *     · 按颜色模式永远字母序（那个模式本来就没有手动排序）
 *   注意拖拽的落点计算必须基于 **managedGroupNames(cur)（当前显示顺序）**，
 *   而不是 cur.order —— 字母序模式下 cur.order 可能是旧顺序，直接拿它算会错位。
 *
 *   搜索：`matchQuery` 空格拆词 + AND + 任意位置子串 + 大小写不敏感。
 *   全选：只作用于**当前筛选结果**，所以「搜 图像 → 全选 → 确定」= 批量选中一类组。
 *
 *   顺带修掉一个老 bug：旧版「添加组」确定时用
 *   `allGroups().map(title).filter(keep)` 重排 order，会把用户拖拽的顺序冲掉。
 *   现在改为保留既有顺序、新加入的按字母序补在后面。
 */

import { app } from "../../../scripts/app.js";

/** 便于在控制台确认浏览器加载的是哪一版 */
const BUILD = "2026-09-23-fix4";

const NODE_TYPE = "YanhuoGroupIgnoreManager";
const PROPS_KEY = "yanhuoGroupIgnore";

const MODE_ALWAYS = 0; // LiteGraph.ALWAYS —— 组内节点正常参与执行
const MODE_BYPASS = 4; // LiteGraph.BYPASS —— 组被「忽略」

/** 状态结构版本。用于一次性迁移旧版「自定义模式自动填满组列表」的行为。 */
const STATE_VERSION = 2;

/** 切换限制：默认可同时开启多个组 */
const RESTRICT_DEFAULT = "default";
/** 切换限制：只开启一个（类似 max one）——打开一个组就把其它受管组全部忽略 */
const RESTRICT_ONLY_ONE = "onlyOne";

const DEFAULT_W = 420;
const DEFAULT_H = 560;

/** node -> 运行时上下文。绝不写到 node 上。 */
const RUNTIME = new WeakMap();
/** node -> 定时器 id */
const TIMERS = new WeakMap();

// ============================================================
// 一、基础工具
// ============================================================

function isLGraphNode(obj) {
    if (!obj || typeof obj !== "object") return false;

    // 最可靠：真实节点一定登记在 graph 的节点表里（reroute / 嵌套组都不在）
    const byId = app.graph?.getNodeById?.(obj.id);
    if (byId !== undefined) return byId === obj;

    const Ctor = globalThis.LiteGraph?.LGraphNode;
    if (Ctor && obj instanceof Ctor) return true;

    // 兜底：子图节点的 id 是 UUID 字符串，不能只认 number
    return (
        (typeof obj.id === "number" || typeof obj.id === "string") &&
        Array.isArray(obj.pos) &&
        "mode" in obj
    );
}

/**
 * 取组内节点。
 *
 * ⚠️ 关键：新版前端里 `LGraphGroup._children`（以及 `nodes` getter 背后的 `_nodes`）
 * 是一个**懒计算的容器，初始为空**，只有调用 `recomputeInsideNodes()` 之后才会填充。
 * 原生前端自己的右键菜单、Fit Group、选择组、转子图，全都是先调一次再读。
 * 不调的话 `_children` 恒为空 → 面板显示「空组」→ 开关永远是灰的、点了也没反应。
 *
 * `_children` 里除了节点，还会有 reroute 和嵌套子组，所以必须用 isLGraphNode 过滤。
 */
function groupNodes(group) {
    const out = [];
    if (!group) return out;

    // 先让组自己算一遍成员（boundingRect 的 getter 会顺带同步布局）
    try {
        void group.boundingRect;
    } catch (_) {
        /* 布局未就绪时忽略 */
    }
    try {
        group.recomputeInsideNodes();
    } catch (_) {
        /* 组刚创建 / 已移除时 graph 为空会抛，忽略即可 */
    }

    const kids = group._children ?? group.nodes;
    if (kids && typeof kids[Symbol.iterator] === "function") {
        for (const c of kids) if (isLGraphNode(c)) out.push(c);
    }
    return out;
}

/** 组框内的嵌套子组（group._children 里除节点外混着的就是它们）。 */
function nestedGroups(group) {
    const out = [];
    const kids = group?._children;
    if (!kids || typeof kids[Symbol.iterator] !== "function") return out;
    for (const c of kids) {
        if (c === group) continue;
        // 子组也实现了 recomputeInsideNodes，而节点没有
        if (c && typeof c.recomputeInsideNodes === "function") out.push(c);
    }
    return out;
}

/**
 * 递归收集组内节点（含嵌套子组里的节点）。
 * 只装子组的「大组」也应该能整体忽略——直接子节点为空不代表组是空的。
 */
function collectGroupNodesDeep(group, seen) {
    const out = [];
    if (!group) return out;
    const vis = seen || new Set();
    if (vis.has(group)) return out;
    vis.add(group);

    for (const n of groupNodes(group)) out.push(n);
    for (const sub of nestedGroups(group)) {
        for (const n of collectGroupNodesDeep(sub, vis)) out.push(n);
    }
    return out;
}

/**
 * 遍历节点集合（去重）。
 *
 * ⚠️ 默认**不进入子图内部**，故意如此：
 *   1. 原生「Bypass Group Nodes / Set Group Nodes to Never」只改组的直接子节点，
 *      子图节点自身的 mode 已经是整块生效（bypass 它 = 整块跳过）；
 *   2. 子图内部节点的 mode 在组面板上根本看不见，顺手改掉会悄悄覆盖
 *      用户自己在子图里设的 NEVER / BYPASS。
 * 确有需要穿透时，显式传 enterSubgraph = true。
 */
function walkNodes(nodeOrNodes, visit, enterSubgraph = false) {
    const stack = Array.isArray(nodeOrNodes) ? [...nodeOrNodes] : [nodeOrNodes];
    const seen = new Set();
    while (stack.length > 0) {
        const n = stack.pop();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        visit(n);
        if (
            enterSubgraph &&
            typeof n.isSubgraphNode === "function" &&
            n.isSubgraphNode() &&
            n.subgraph
        ) {
            const children = n.subgraph.nodes || [];
            for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
    }
}

/** 批量改 mode，返回真正被改动的节点数（0 表示本来就一致）。 */
function setNodesMode(nodeOrNodes, mode) {
    let changed = 0;
    walkNodes(nodeOrNodes, (n) => {
        if (n.mode !== mode) {
            n.mode = mode;
            changed++;
        }
    });
    return changed;
}

/** 给定节点集合，是否有任意一个是 ALWAYS。 */
function nodesHaveActive(nodes) {
    let anyActive = false;
    walkNodes(nodes, (n) => {
        if (n.mode === MODE_ALWAYS) anyActive = true;
    });
    return anyActive;
}

/** 组是否处于「开启」状态：组内只要有任意节点是 ALWAYS 即视为开启。 */
function isGroupEnabled(group) {
    const nodes = collectGroupNodesDeep(group);
    // 空组没有任何可忽略的对象，视为开启，避免一上来就显示成灰的
    if (nodes.length === 0) return true;
    return nodesHaveActive(nodes);
}

function allGroups() {
    const g = app.graph?._groups;
    return Array.isArray(g) ? g.filter((x) => x && typeof x.title === "string") : [];
}

function findGroup(name) {
    return allGroups().find((g) => g.title === name) || null;
}

function groupColor(group) {
    const c = group?.color;
    return typeof c === "string" && c ? c : "";
}

function uniqueColors() {
    const set = new Set();
    for (const g of allGroups()) {
        const c = groupColor(g);
        if (c) set.add(c);
    }
    return [...set];
}

// ---------- 名称排序 / 检索 ----------

/** 组名比较器：字母 / 拼音序，数字按数值算（「第2组」排在「第10组」前面）。 */
const NAME_COLLATOR = (() => {
    try {
        return new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
    } catch (_) {
        return null;
    }
})();

function compareNames(a, b) {
    const x = String(a ?? "");
    const y = String(b ?? "");
    if (NAME_COLLATOR) return NAME_COLLATOR.compare(x, y);
    try {
        return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
    } catch (_) {
        return x < y ? -1 : x > y ? 1 : 0;
    }
}

/** 返回按字母序排好的新数组（不改原数组） */
function sortNames(names) {
    return [...names].sort(compareNames);
}

/**
 * 合并「添加组」的结果列表。
 * 保留用户既有的顺序（可能拖过），本次新加入的按字母序补在后面。
 *
 * ⚠️ 旧版这里是 `allGroups().map(title).filter(keep)`（按图中顺序重排），
 *    会把用户拖拽出来的顺序冲掉 —— 这是个老 bug，已改。
 */
function mergeOrder(prevOrder, keepSet, existSet) {
    const order = [];
    for (const n of prevOrder) {
        if (keepSet.has(n) && existSet.has(n)) order.push(n);
    }
    for (const n of sortNames([...keepSet])) {
        if (!order.includes(n) && existSet.has(n)) order.push(n);
    }
    return order;
}

/**
 * 组名是否命中搜索词。
 * 规则：空格拆成多个关键词，**全部**命中才算匹配（AND）；大小写不敏感；任意位置子串。
 *   输入「图」   → 命中「图像加载区」「图像合并加载」「最终帧提取1」里带"图"的…（凡是含"图"的）
 *   输入「图像」 → 只命中含「图像」的
 *   输入「图像 加载」→ 只命中同时含「图像」和「加载」的，即各种「图像加载区」
 */
function matchQuery(name, query) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return true;
    const hay = String(name).toLowerCase();
    return q.split(/\s+/).every((tk) => tk && hay.includes(tk));
}

function refreshCanvas() {
    app.graph?.setDirtyCanvas?.(true, true);
}

/**
 * 提交一次真实的图变更。
 * 对齐原生「组模式」的实现（canvas.setDirty + graph.change），
 * 少了 graph.change() 会出现：mode 改了但节点外观/工作流脏标记不更新。
 */
function commitGraphChange() {
    try {
        app.canvas?.setDirty?.(true, true);
    } catch (_) {
        /* 画布未就绪 */
    }
    refreshCanvas();
    try {
        app.graph?.change?.();
    } catch (_) {
        /* 忽略 */
    }
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

// ============================================================
// 二、状态：只往 node.properties 写纯 JSON
// ============================================================

function defaultState() {
    return {
        version: 1,
        stateVersion: STATE_VERSION,
        initialized: false,
        mode: "custom", // "custom" | "color"
        restriction: RESTRICT_DEFAULT, // "default" | "onlyOne"（只开启一个）
        colorFilter: "all", // "all" | 具体颜色
        // 自定义模式下由用户挑出来的组（**默认为空**，必须点「+ 添加组」才会进这里）
        order: [],
        // 用户是否手动拖拽过排序。false = 显示时按字母序（默认）；
        // true = 完全按 order 里的顺序（用户拖出来的），点顶栏排序按钮可切回字母序。
        orderManual: false,
        groups: {}, // 组名 -> { enabled, linkage:{onEnable:[],onDisable:[]} }
    };
}

/** 把外部（含旧插件）的规则数组归一成 [{target, action}] */
function normalizeRules(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
        if (!r || typeof r !== "object") continue;
        const target = r.target ?? r.target_group ?? r.group_name ?? r.group ?? r.name;
        let action = r.action ?? r.state ?? r.enabled;
        if (action === true || action === "enable" || action === "on" || action === "开启") {
            action = "enable";
        } else if (
            action === false ||
            action === "disable" ||
            action === "off" ||
            action === "关闭"
        ) {
            action = "disable";
        } else {
            continue;
        }
        if (typeof target !== "string" || !target) continue;
        out.push({ target, action });
    }
    return out;
}

function readState(node) {
    const props = (node.properties ||= {});
    const raw = props[PROPS_KEY];

    const st = defaultState();
    if (raw && typeof raw === "object") {
        st.initialized = raw.initialized === true;
        st.stateVersion = Number(raw.stateVersion) || 1;
        st.mode = raw.mode === "color" ? "color" : "custom";
        st.restriction = raw.restriction === RESTRICT_ONLY_ONE ? RESTRICT_ONLY_ONE : RESTRICT_DEFAULT;
        st.colorFilter = typeof raw.colorFilter === "string" ? raw.colorFilter : "all";
        st.order = Array.isArray(raw.order)
            ? raw.order.filter((x) => typeof x === "string")
            : [];
        st.orderManual = raw.orderManual === true;
        st.groups = raw.groups && typeof raw.groups === "object" ? raw.groups : {};
        return st; // 注意：读取时不回写，避免轮询把工作流标记成已修改
    }

    // 首次使用：尝试从旧版 GroupIgnoreManager 节点搬运配置
    const rt = RUNTIME.get(node);
    if (!rt?.migrated) {
        if (rt) rt.migrated = true;
        migrateFromLegacy(st);
    }
    props[PROPS_KEY] = st;
    return st;
}

function migrateFromLegacy(st) {
    let legacy = null;
    for (const n of app.graph?._nodes || []) {
        if (n.type !== "GroupIgnoreManager") continue;
        const p = n.properties;
        if (p && Array.isArray(p.groups) && p.groups.length) {
            legacy = p;
            break;
        }
    }
    if (!legacy) return false;

    for (const g of legacy.groups) {
        const name = g.group_name ?? g.name;
        if (typeof name !== "string" || !name) continue;
        st.groups[name] = {
            enabled: g.enabled !== false,
            linkage: {
                onEnable: normalizeRules(g.linkage?.on_enable),
                onDisable: normalizeRules(g.linkage?.on_disable),
            },
        };
    }
    if (Array.isArray(legacy.customManagedGroups) && legacy.customManagedGroups.length) {
        st.order = legacy.customManagedGroups.slice();
        st.initialized = true;
    }
    if (legacy.managerMode === "color" || legacy.managerMode === "custom") {
        st.mode = legacy.managerMode;
    }
    if (legacy.customManagedGroups?.length) st.initialized = true;
    return true;
}

function writeState(node, st) {
    // 深拷贝一次，确保任何意外对象都不会泄进 properties
    node.properties[PROPS_KEY] = JSON.parse(JSON.stringify(st));
}

function ensureEntry(st, name) {
    if (!st.groups[name]) {
        st.groups[name] = { enabled: true, linkage: { onEnable: [], onDisable: [] } };
    }
    const e = st.groups[name];
    if (!e.linkage || typeof e.linkage !== "object") {
        e.linkage = { onEnable: [], onDisable: [] };
    }
    e.linkage.onEnable = normalizeRules(e.linkage.onEnable);
    e.linkage.onDisable = normalizeRules(e.linkage.onDisable);
    return e;
}

/**
 * 当前实际应显示的组名列表。
 *
 * 排序规则：
 *   · 按颜色模式 —— 永远按字母序（这个模式本来就没有手动排序）
 *   · 自定义模式 —— 默认按字母序；用户拖拽过（orderManual）就完全按用户顺序
 */
function managedGroupNames(st) {
    const groups = allGroups();
    if (st.mode === "color") {
        return sortNames(
            groups
                .filter((g) => st.colorFilter === "all" || groupColor(g) === st.colorFilter)
                .map((g) => g.title)
        );
    }
    const exist = new Set(groups.map((g) => g.title));
    const list = st.order.filter((n) => exist.has(n));
    return st.orderManual ? list : sortNames(list);
}

/** 与真实图同步：清死名、刷新启用状态，必要时做一次性迁移 */
function syncWithGraph(st) {
    const groups = allGroups();
    const exist = new Set(groups.map((g) => g.title));
    const titles = groups.map((g) => g.title);

    // ---- 一次性迁移（STATE_VERSION 1 → 2）----
    // 旧版在「自定义」模式下会自动把图里**所有**组填进 order，用户没挑过。
    // 新版语义改为：自定义模式默认空列表，完全由用户点「+ 添加组」决定。
    // 只在 order **覆盖了图里全部组**时才判定为旧版自动填充并清空，
    // 用户真挑过的列表（真子集）保持不变。
    if (st.stateVersion !== STATE_VERSION) {
        st.stateVersion = STATE_VERSION;
        // 判据：图里的每一个组都在 order 里 → 一定是旧版自动填的（用户不可能手动全勾一遍还这么巧）
        if (
            st.mode === "custom" &&
            st.order.length > 0 &&
            titles.length > 0 &&
            titles.every((n) => st.order.includes(n))
        ) {
            st.order = [];
            st.initialized = false;
        }
    }

    if (st.mode === "custom") {
        // 自定义：只保留用户挑过的组，默认什么都不管
        st.order = st.order.filter((n) => exist.has(n));
    } else {
        // 按颜色：规则保持不变 —— 自动纳入当前颜色过滤命中的全部组
        for (const g of groups) {
            if (st.colorFilter === "all" || groupColor(g) === st.colorFilter) {
                ensureEntry(st, g.title);
            }
        }
    }

    for (const g of groups) {
        const e = st.groups[g.title];
        if (e) e.enabled = isGroupEnabled(g);
    }
    return st;
}

// ============================================================
// 三、组开关与联动
// ============================================================

/**
 * 只改 mode，不改 state、不触发联动。
 * 用于「只开启一个」的清扫，避免连锁触发各组的 onDisable 规则。
 * 返回真正被改动的节点数。
 */
function setGroupEnabledRaw(groupName, enabled) {
    const group = findGroup(groupName);
    if (!group) return 0;
    return setNodesMode(collectGroupNodesDeep(group), enabled ? MODE_ALWAYS : MODE_BYPASS);
}

/**
 * 「只开启一个」清扫：把除 keepName 之外的所有受管组全部忽略。
 * 作用范围 = 面板当前显示的组（即 managedGroupNames），不动用户没纳入管理的组。
 */
function sweepOthersOff(node, keepName) {
    let changed = 0;
    const st = readState(node);
    for (const name of managedGroupNames(st)) {
        if (name === keepName) continue;
        if (findGroup(name) === null) continue;
        changed += setGroupEnabledRaw(name, false);
    }
    return changed;
}

/**
 * 打开 / 忽略一个组。
 *
 * @param outermost 是否为本次用户操作的**最外层**调用。
 *   「只开启一个」的清扫只在最外层做一次：
 *   若每次递归都清扫，组 A 的联动刚打开组 D，D 的清扫就会把刚点开的 A 又关掉 —— 互相打架。
 *   所以语义定为：
 *     ① 先清扫掉其它受管组（不触发它们的联动，避免连锁）
 *     ② 再打开被点的组，并正常执行 **该组自己的** 联动规则
 *     ③ 联动规则里被显式打开的组保留 —— 那是用户自己配的规则，不算冲突
 */
function setGroupEnabled(node, groupName, enabled, rt, outermost) {
    const group = findGroup(groupName);
    if (!group) return false;

    const ctx = rt || RUNTIME.get(node);
    const isOutermost = outermost === undefined ? true : outermost;

    let changed = 0;

    const st = readState(node);
    if (enabled && isOutermost && st.restriction === RESTRICT_ONLY_ONE) {
        changed += sweepOthersOff(node, groupName);
    }

    changed += setNodesMode(collectGroupNodesDeep(group), enabled ? MODE_ALWAYS : MODE_BYPASS);
    if (changed > 0) commitGraphChange();

    ensureEntry(st, groupName).enabled = !!enabled;
    writeState(node, st);

    if (ctx) {
        if (!ctx.linking) ctx.linking = new Set();
        // 循环联动保护
        if (!ctx.linking.has(groupName)) {
            ctx.linking.add(groupName);
            try {
                applyLinkage(node, groupName, enabled, ctx);
            } finally {
                ctx.linking.delete(groupName);
            }
        }
    }
    return true;
}

function applyLinkage(node, groupName, enabled, rt) {
    const st = readState(node);
    const entry = st.groups[groupName];
    if (!entry) return;
    const rules = enabled ? entry.linkage.onEnable : entry.linkage.onDisable;
    for (const rule of rules) {
        if (!rule?.target || rule.target === groupName) continue;
        // outermost = false：联动引发的开关不再重复做「只开启一个」清扫
        setGroupEnabled(node, rule.target, rule.action === "enable", rt, false);
    }
}

// ============================================================
// 四、样式
// ============================================================

const CSS = `
.ygim-root{display:flex;flex-direction:column;width:100%;height:100%;box-sizing:border-box;
  font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  color:#e6e6ea;background:#1e1e24;border-radius:6px;overflow:hidden}
.ygim-bar{display:flex;align-items:center;gap:6px;row-gap:6px;flex-wrap:wrap;
  padding:8px;border-bottom:1px solid #33333d;flex:0 0 auto}
.ygim-bar2{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #33333d;
  background:#23232b;flex:0 0 auto}
.ygim-title{font-size:12px;font-weight:500;flex:0 0 auto}
.ygim-grow{flex:1 1 auto}
/* 顶栏放了三件控件，标题允许收缩，避免把按钮挤出节点 */
.ygim-bar .ygim-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.ygim-sel{background:#2b2b35;color:#e6e6ea;border:1px solid #3d3d49;border-radius:5px;
  padding:3px 6px;font-size:11px;outline:none;cursor:pointer;max-width:100%}
/* 「只开启一个」生效时给选择框一个视觉提示 */
.ygim-sel-restrict-on{background:#4c2f7a;border-color:#7c3aed;color:#f0e7ff}
.ygim-btn{background:#2b2b35;color:#d8d8e0;border:1px solid #3d3d49;border-radius:5px;
  padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
.ygim-btn:hover{background:#353541;border-color:#4d4d5b}
.ygim-btn-primary{background:#3b7d4f;border-color:#4a9660;color:#eafff0}
.ygim-btn-primary:hover{background:#46905b}
.ygim-icon{width:26px;height:24px;display:grid;place-items:center;padding:0}
.ygim-list{flex:1 1 auto;overflow-y:auto;padding:6px;min-height:0}
.ygim-list::-webkit-scrollbar{width:8px}
.ygim-list::-webkit-scrollbar-thumb{background:#3d3d49;border-radius:4px}
.ygim-row{display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;
  background:#2a2a33;border:1px solid #35353f;border-radius:6px}
.ygim-row.ygim-off{background:#26262d;border-color:#31313a}
.ygim-row.ygim-drag{opacity:.45}
.ygim-row.ygim-over{border-color:#8b5cf6}
.ygim-handle{cursor:grab;color:#6a6a78;flex:0 0 auto;user-select:none;letter-spacing:1px}
.ygim-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ygim-row.ygim-off .ygim-name{color:#8a8a96}
.ygim-badge{font-size:10px;padding:1px 5px;border-radius:4px;background:#3a3a46;color:#9a9aa8;flex:0 0 auto}
.ygim-round{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;
  border:1px solid transparent;cursor:pointer;flex:0 0 auto;transition:background .12s}
.ygim-power-on{background:#7c3aed;color:#fff}
.ygim-power-on:hover{background:#8b5cf6}
.ygim-power-off{background:transparent;color:#7a7a88;border-color:#3d3d49}
.ygim-power-off:hover{background:#33333d;color:#c8c8d2}
.ygim-ghost{background:transparent;color:#9aa0b5;border-color:#3d3d49}
.ygim-ghost:hover{background:#33333d;color:#e6e6ea}
.ygim-ghost.ygim-has{border-color:#8b5cf6;color:#b794f6}
.ygim-empty{padding:20px 10px;text-align:center;color:#70707e;font-size:11px}
.ygim-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:10000}
.ygim-dialog{background:#22222a;border:1px solid #3d3d49;border-radius:8px;width:420px;max-width:92vw;
  max-height:76vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.ygim-dialog h4{margin:0;padding:10px 12px;font-size:12px;font-weight:500;border-bottom:1px solid #33333d}
.ygim-dbody{padding:10px 12px;overflow-y:auto;min-height:0}
.ygim-dfoot{padding:8px 12px;border-top:1px solid #33333d;display:flex;justify-content:flex-end;gap:6px}
.ygim-sec{font-size:11px;color:#9a9aa8;margin:10px 0 6px;display:flex;align-items:center;gap:6px}
.ygim-sec:first-child{margin-top:0}
/* flex-start：目标下拉展开时会变高，动作/删除按钮要留在顶部而不是被垂直居中 */
.ygim-rule{display:flex;align-items:flex-start;gap:6px;margin-bottom:6px}
.ygim-rule .ygim-sel{flex:1 1 auto;min-width:0}
.ygim-rule .ygim-act{flex:0 0 auto;width:64px}
.ygim-del{width:22px;height:22px;border-radius:4px;background:#a32d2d;border:none;color:#fff;
  cursor:pointer;font-size:12px;line-height:1;flex:0 0 auto}
.ygim-del:hover{background:#c53030}
.ygim-pick{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:5px;cursor:pointer}
.ygim-pick:hover{background:#2b2b35}
.ygim-pick input{accent-color:#8b5cf6;flex:0 0 auto}
.ygim-hint{font-size:11px;color:#70707e;margin-top:6px;line-height:1.5}
/* ---- 搜索框 ---- */
.ygim-input{background:#2b2b35;color:#e6e6ea;border:1px solid #3d3d49;border-radius:5px;
  padding:4px 7px;font-size:11px;outline:none;width:100%;box-sizing:border-box;
  font-family:inherit}
.ygim-input:focus{border-color:#7c3aed}
.ygim-input::placeholder{color:#6a6a78}
/* 让弹窗主体在「固定头部 + 滚动列表」模式下工作 */
.ygim-dbody.ygim-flexcol{display:flex;flex-direction:column;overflow:hidden}
.ygim-fixed{flex:0 0 auto}
.ygim-scroll{flex:1 1 auto;overflow-y:auto;min-height:120px;max-height:46vh}
.ygim-scroll::-webkit-scrollbar{width:8px}
.ygim-scroll::-webkit-scrollbar-thumb{background:#3d3d49;border-radius:4px}
.ygim-count{font-size:11px;color:#70707e;padding:6px 2px 0}
/* 底部左侧「全选」 */
.ygim-allwrap{display:flex;align-items:center;gap:6px;margin-right:auto;
  font-size:11px;color:#c8c8d2;cursor:pointer;user-select:none;white-space:nowrap}
.ygim-allwrap input{accent-color:#8b5cf6;cursor:pointer}
/* ---- 可搜索下拉（combobox） ---- */
.ygim-combo{flex:1 1 auto;min-width:0}
.ygim-combo-btn{width:100%;display:flex;align-items:center;gap:4px;box-sizing:border-box;
  background:#2b2b35;color:#e6e6ea;border:1px solid #3d3d49;border-radius:5px;
  padding:3px 6px;font-size:11px;cursor:pointer;text-align:left;font-family:inherit}
.ygim-combo-btn:hover{border-color:#4d4d5b}
.ygim-combo-cur{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ygim-combo-cur.ygim-ph{color:#7a7a88}
.ygim-combo-caret{flex:0 0 auto;opacity:.55}
.ygim-combo-pop{margin-top:4px;padding:5px;border:1px solid #3d3d49;border-radius:5px;
  background:#25252d;display:flex;flex-direction:column;gap:4px}
.ygim-combo-opts{max-height:176px;overflow-y:auto}
.ygim-combo-opts::-webkit-scrollbar{width:7px}
.ygim-combo-opts::-webkit-scrollbar-thumb{background:#3d3d49;border-radius:4px}
.ygim-combo-opt{padding:4px 7px;border-radius:4px;cursor:pointer;font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ygim-combo-opt:hover{background:#33333d}
.ygim-combo-opt.on{background:#4c2f7a;color:#f0e7ff}
.ygim-combo-empty{padding:7px;font-size:11px;color:#70707e;text-align:center}
`;

let styleInjected = false;
function injectStyle() {
    if (styleInjected) return;
    const s = document.createElement("style");
    s.dataset.ygim = "1";
    s.textContent = CSS;
    document.head.appendChild(s);
    styleInjected = true;
}

// ============================================================
// 五、图标
// ============================================================

const ICON = {
    power: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>`,
    gear: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
    go: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="m12 5 7 7-7 7"/></svg>`,
    refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
    sortAz: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11"/><path d="M3 12h8"/><path d="M3 18h5"/><path d="M19 7v10"/><path d="m16 14 3 3 3-3"/></svg>`,
};

// ============================================================
// 六、弹窗骨架
// ============================================================

function makeModal(title) {
    injectStyle();
    const mask = el("div", "ygim-mask");
    const dlg = el("div", "ygim-dialog");
    const body = el("div", "ygim-dbody");
    const foot = el("div", "ygim-dfoot");
    dlg.appendChild(el("h4", null, title));
    dlg.appendChild(body);
    dlg.appendChild(foot);
    mask.appendChild(dlg);
    document.body.appendChild(mask);

    const onKey = (e) => {
        if (e.key === "Escape") api.close();
    };
    const api = {
        body,
        foot,
        button(label, handler, primary) {
            const b = el("button", "ygim-btn" + (primary ? " ygim-btn-primary" : ""), label);
            b.addEventListener("click", handler);
            foot.appendChild(b);
            return b;
        },
        close() {
            mask.remove();
            document.removeEventListener("keydown", onKey);
        },
    };
    document.addEventListener("keydown", onKey);
    mask.addEventListener("mousedown", (e) => {
        if (e.target === mask) api.close();
    });
    return api;
}

// ---------- 可搜索下拉（联动配置里选目标组） ----------

/** 同一时刻只允许展开一个下拉 */
let closeActiveCombo = null;

/**
 * 带搜索框的下拉选择器。
 * 选项面板是**行内展开**（不是 absolute 浮层）——弹窗主体是 overflow:auto 的，
 * 浮层会被裁掉，行内展开永远安全。
 *
 * @param names   候选项（内部会按字母序排）
 * @param value   当前值，"" 表示未选择
 * @param onPick  选中回调
 * @returns {{ el: HTMLElement, close: Function, getValue: Function }}
 */
function makeSearchCombo(names, value, onPick) {
    const sorted = sortNames(names);

    const wrap = el("div", "ygim-combo");
    const btn = el("button", "ygim-combo-btn");
    btn.type = "button";
    const cur = el("span", "ygim-combo-cur");
    const caret = el("span", "ygim-combo-caret", "▾");
    btn.appendChild(cur);
    btn.appendChild(caret);
    wrap.appendChild(btn);

    let pop = null;
    let val = value || "";

    const paintCur = () => {
        cur.textContent = val || "选择组";
        cur.classList.toggle("ygim-ph", !val);
        btn.title = val || "选择组";
    };
    paintCur();

    const close = () => {
        if (!pop) return;
        pop.remove();
        pop = null;
        if (closeActiveCombo === close) closeActiveCombo = null;
    };

    const open = () => {
        if (pop) {
            close();
            return;
        }
        if (closeActiveCombo) closeActiveCombo();
        closeActiveCombo = close;

        pop = el("div", "ygim-combo-pop");
        const input = el("input", "ygim-input");
        input.type = "text";
        input.placeholder = "搜索组名…";
        const opts = el("div", "ygim-combo-opts");
        pop.appendChild(input);
        pop.appendChild(opts);
        wrap.appendChild(pop);

        const paintList = () => {
            opts.innerHTML = "";
            const hits = sorted.filter((n) => matchQuery(n, input.value));
            if (hits.length === 0) {
                opts.appendChild(el("div", "ygim-combo-empty", "没有匹配的组"));
                return;
            }
            for (const n of hits) {
                const o = el("div", "ygim-combo-opt" + (n === val ? " on" : ""), n);
                o.title = n;
                // 用 mousedown 而不是 click：避免 blur / 重绘把点击吃掉
                o.addEventListener("mousedown", (ev) => {
                    ev.preventDefault();
                    val = n;
                    paintCur();
                    if (typeof onPick === "function") onPick(n);
                    close();
                });
                opts.appendChild(o);
            }
        };
        paintList();
        input.addEventListener("input", paintList);
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
                ev.stopPropagation(); // 别让 Esc 顺带把整个弹窗关了
                close();
            }
        });
        setTimeout(() => {
            try {
                // 展开后可能落在弹窗可视区之外（弹窗主体是滚动的），滚进来再聚焦
                input.focus({ preventScroll: true });
            } catch (_) {
                /* ignore */
            }
            try {
                pop.scrollIntoView({ block: "nearest" });
            } catch (_) {
                /* ignore */
            }
        }, 0);
    };

    btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        open();
    });

    return {
        el: wrap,
        close,
        getValue: () => val,
        setValue: (v) => {
            val = v || "";
            paintCur();
        },
    };
}

// ---------- 添加组 ----------

function openAddDialog(node) {
    const modal = makeModal("添加要管理的组");
    // 「固定搜索行 + 滚动列表」布局
    modal.body.classList.add("ygim-flexcol");

    // 组列表按字母序排列（长列表才找得到东西）
    const groups = [...allGroups()].sort((a, b) => compareNames(a.title, b.title));

    // ---- 顶部搜索行（不随列表滚动） ----
    const searchRow = el("div", "ygim-fixed");
    searchRow.style.paddingBottom = "6px";
    const search = el("input", "ygim-input");
    search.type = "text";
    search.placeholder = "搜索组名…（空格分隔多个关键词，如「图像 加载」）";
    searchRow.appendChild(search);
    modal.body.appendChild(searchRow);

    // ---- 滚动列表 ----
    const listBox = el("div", "ygim-scroll");
    modal.body.appendChild(listBox);

    const picks = []; // { cb, name, row }
    const emptyHint = el("div", "ygim-combo-empty", "没有匹配的组");

    if (groups.length === 0) {
        listBox.appendChild(el("div", "ygim-hint", "当前工作流里还没有任何组。"));
    } else {
        const st = readState(node);
        const managed = new Set(managedGroupNames(st));
        for (const g of groups) {
            const label = el("label", "ygim-pick");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = managed.has(g.title);
            const color = groupColor(g);
            const dot = el("span", "ygim-badge", color || "无色");
            if (color) dot.style.background = color;
            const txt = el("div", "ygim-name", g.title);
            txt.title = g.title;
            label.appendChild(cb);
            label.appendChild(dot);
            label.appendChild(txt);
            listBox.appendChild(label);
            picks.push({ cb, name: g.title, row: label });
        }
        listBox.appendChild(emptyHint);
    }

    // ---- 固定提示行 ----
    const footHint = el(
        "div",
        "ygim-hint ygim-fixed",
        "勾选后点「确定」加入管理列表；取消勾选会从列表移除（联动配置会保留）。"
    );
    footHint.style.marginTop = "6px";
    modal.body.appendChild(footHint);

    // ---- 底部左侧「全选」 ----
    const allWrap = el("label", "ygim-allwrap");
    const allCb = document.createElement("input");
    allCb.type = "checkbox";
    const allTxt = el("span", null, "全选");
    allWrap.appendChild(allCb);
    allWrap.appendChild(allTxt);
    allWrap.title = "只作用于当前搜索结果";
    modal.foot.insertBefore(allWrap, modal.foot.firstChild);

    /** 当前可见（命中搜索）的选项 */
    const visiblePicks = () => picks.filter((p) => p.row.style.display !== "none");

    const syncAll = () => {
        const vis = visiblePicks();
        const checked = vis.filter((p) => p.cb.checked).length;
        allCb.checked = vis.length > 0 && checked === vis.length;
        allCb.indeterminate = checked > 0 && checked < vis.length;
        allCb.disabled = vis.length === 0;
        allTxt.textContent = vis.length ? `全选（当前 ${vis.length} 项）` : "全选";
    };

    const repaint = () => {
        let shown = 0;
        for (const p of picks) {
            const hit = matchQuery(p.name, search.value);
            p.row.style.display = hit ? "" : "none";
            if (hit) shown++;
        }
        emptyHint.style.display = shown === 0 && picks.length > 0 ? "" : "none";
        syncAll();
    };

    allCb.addEventListener("change", () => {
        const on = allCb.checked;
        // 只动筛选出来的，没搜到的不受影响（这样「搜索+全选」能精确批量加）
        for (const p of visiblePicks()) p.cb.checked = on;
        syncAll();
    });

    for (const p of picks) p.cb.addEventListener("change", syncAll);

    search.addEventListener("input", repaint);
    search.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") ev.stopPropagation(); // 别顺带关掉弹窗
    });

    repaint();
    setTimeout(() => {
        try {
            search.focus();
        } catch (_) {
            /* ignore */
        }
    }, 0);

    modal.button("取消", () => modal.close());
    modal.button(
        "确定",
        () => {
            const cur = readState(node);
            if (cur.mode === "color") cur.mode = "custom";
            const keep = new Set(cur.order);
            for (const p of picks) {
                if (p.cb.checked) {
                    keep.add(p.name);
                    ensureEntry(cur, p.name);
                } else {
                    keep.delete(p.name);
                }
            }
            const existNow = new Set(allGroups().map((g) => g.title));
            cur.order = mergeOrder(cur.order, keep, existNow);
            cur.initialized = true;
            writeState(node, cur);
            renderAll(node);
            modal.close();
        },
        true
    );
}

// ---------- 联动配置 ----------

function openLinkageDialog(node, groupName) {
    const st = readState(node);
    const base = ensureEntry(st, groupName);
    // 用副本编辑，取消则不落盘
    const draft = JSON.parse(JSON.stringify(base.linkage));
    // 候选目标组按字母序（联动面板里组很多时，靠搜索 + 字母序才找得动）
    const allNames = sortNames(allGroups().map((g) => g.title).filter((n) => n !== groupName));

    const modal = makeModal(`联动配置：${groupName}`);

    const buildSection = (key, titleText) => {
        const sec = el("div", "ygim-sec");
        sec.appendChild(el("span", null, titleText));
        sec.appendChild(el("span", "ygim-grow"));
        const add = el("button", "ygim-btn", "+");
        add.title = "新增一条规则";
        sec.appendChild(add);
        modal.body.appendChild(sec);

        const box = el("div");
        modal.body.appendChild(box);

        const paint = () => {
            box.innerHTML = "";
            const rules = draft[key];
            if (!rules.length) {
                box.appendChild(el("div", "ygim-hint", "暂无规则"));
                return;
            }
            rules.forEach((rule, i) => {
                const line = el("div", "ygim-rule");

                // 可搜索下拉：顶部搜索框，选项按字母序
                const targetCombo = makeSearchCombo(allNames, rule.target || "", (n) => {
                    rule.target = n;
                });

                const actSel = el("select", "ygim-sel ygim-act");
                for (const [v, t] of [
                    ["enable", "开启"],
                    ["disable", "关闭"],
                ]) {
                    const o = el("option", null, t);
                    o.value = v;
                    actSel.appendChild(o);
                }
                actSel.value = rule.action === "disable" ? "disable" : "enable";
                actSel.addEventListener("change", () => {
                    rule.action = actSel.value;
                });

                const del = el("button", "ygim-del", "×");
                del.title = "删除这条规则";
                del.addEventListener("click", () => {
                    draft[key].splice(i, 1);
                    paint();
                });

                line.appendChild(targetCombo.el);
                line.appendChild(actSel);
                line.appendChild(del);
                box.appendChild(line);
            });
        };

        add.addEventListener("click", () => {
            draft[key].push({ target: allNames[0] || "", action: "disable" });
            paint();
        });

        paint();
    };

    buildSection("onEnable", "组开启时");
    buildSection("onDisable", "组关闭时");
    modal.body.appendChild(
        el("div", "ygim-hint", "点击该组开关时自动执行；循环联动已做保护，不会死循环。")
    );

    modal.button("取消", () => modal.close());
    modal.button(
        "保存",
        () => {
            const cur = readState(node);
            const e = ensureEntry(cur, groupName);
            e.linkage.onEnable = normalizeRules(draft.onEnable);
            e.linkage.onDisable = normalizeRules(draft.onDisable);
            writeState(node, cur);
            renderAll(node);
            modal.close();
        },
        true
    );
}

// ============================================================
// 七、列表渲染
// ============================================================

function buildRow(node, st, name) {
    const group = findGroup(name);

    // 一次取全（含嵌套子组），后面 badge / 开关 / 状态都用这一份，避免重复 recompute
    const inner = group ? collectGroupNodesDeep(group) : [];
    const isEmpty = !!group && inner.length === 0;
    const enabled = group
        ? isEmpty || nodesHaveActive(inner)
        : ensureEntry(st, name).enabled !== false;

    const row = el("div", "ygim-row" + (enabled ? "" : " ygim-off"));
    row.draggable = true;
    row.dataset.name = name;

    const handle = el("span", "ygim-handle", "⠿");
    handle.title = "拖拽排序";
    row.appendChild(handle);

    const nameEl = el("div", "ygim-name", name);
    nameEl.title = name;
    row.appendChild(nameEl);

    if (isEmpty) {
        row.appendChild(el("span", "ygim-badge", "空组"));
    }

    // 电源：开启 / 忽略
    const power = el("button", "ygim-round " + (enabled ? "ygim-power-on" : "ygim-power-off"));
    power.innerHTML = ICON.power;
    if (isEmpty) {
        power.disabled = true;
        power.style.opacity = "0.35";
        power.style.cursor = "not-allowed";
        power.title = "该组内还没有节点：把节点拖进组框范围内即可";
    } else {
        power.title = enabled ? "点击忽略该组" : "点击开启该组";
    }
    power.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isEmpty) return;
        const g = findGroup(name);
        if (!g) return;
        setGroupEnabled(node, name, !isGroupEnabled(g));
        renderAll(node);
    });
    row.appendChild(power);

    // 联动配置
    const entry = ensureEntry(st, name);
    const nRules = entry.linkage.onEnable.length + entry.linkage.onDisable.length;
    const gear = el("button", "ygim-round ygim-ghost" + (nRules ? " ygim-has" : ""));
    gear.innerHTML = ICON.gear;
    gear.title = nRules ? `联动配置（已有 ${nRules} 条规则）` : "联动配置";
    gear.addEventListener("click", (e) => {
        e.stopPropagation();
        openLinkageDialog(node, name);
    });
    row.appendChild(gear);

    // 定位
    const go = el("button", "ygim-round ygim-ghost");
    go.innerHTML = ICON.go;
    go.title = "定位到该组";
    go.addEventListener("click", (e) => {
        e.stopPropagation();
        focusGroup(name);
    });
    row.appendChild(go);

    // 拖拽排序（仅自定义模式）
    if (st.mode === "custom") {
        row.addEventListener("dragstart", (ev) => {
            const rt = RUNTIME.get(node);
            if (rt) rt.dragFrom = name;
            row.classList.add("ygim-drag");
            try {
                ev.dataTransfer.setData("text/plain", name);
                ev.dataTransfer.effectAllowed = "move";
            } catch (_) {
                /* 某些环境禁止 setData，忽略 */
            }
        });
        row.addEventListener("dragend", () => row.classList.remove("ygim-drag"));
        row.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            row.classList.add("ygim-over");
        });
        row.addEventListener("dragleave", () => row.classList.remove("ygim-over"));
        row.addEventListener("drop", (ev) => {
            ev.preventDefault();
            row.classList.remove("ygim-over");
            const rt = RUNTIME.get(node);
            const from = rt?.dragFrom;
            if (!from || from === name) return;
            const cur = readState(node);
            // 基准用「当前显示顺序」：默认是字母序，用户没拖过时 cur.order 里可能是旧顺序，
            // 直接拿它算落点会错位。
            const arr = managedGroupNames(cur).filter((x) => x !== from);
            const idx = arr.indexOf(name);
            arr.splice(idx < 0 ? arr.length : idx, 0, from);
            cur.order = arr;
            cur.orderManual = true; // 一旦拖过，就完全按用户顺序显示
            writeState(node, cur);
            if (rt) rt.dragFrom = null;
            renderAll(node);
        });
    }

    return row;
}

function renderAll(node) {
    const rt = RUNTIME.get(node);
    if (!rt) return;

    const st = syncWithGraph(readState(node));

    try {
        rt.modeSel.value = st.mode;

        // 排序按钮：只在自定义模式下有意义（按颜色模式永远字母序）
        rt.sortBtn.style.display = st.mode === "custom" ? "" : "none";
        rt.sortBtn.title = st.orderManual
            ? "当前按你拖拽的顺序显示 — 点这里恢复按名称排序"
            : "当前按名称排序（拖拽某一行可改回自定义顺序）";

        // 切换限制
        rt.restrictionSel.value = st.restriction;
        rt.restrictionSel.classList.toggle(
            "ygim-sel-restrict-on",
            st.restriction === RESTRICT_ONLY_ONE
        );
        rt.restrictionSel.title =
            "切换限制\n" +
            "默认：各组的开/关互不影响，可同时开启多个\n" +
            "只开启一个：打开某个组时，其余受管组自动忽略（类似 max one）。\n" +
            "切换此项本身不改动画布，下次点击组开关时才生效。" +
            (st.restriction === RESTRICT_ONLY_ONE ? "\n\n当前生效：只开启一个" : "");

        // 颜色过滤行
        const colors = uniqueColors();
        rt.bar2.style.display = st.mode === "color" ? "" : "none";
        rt.colorSel.innerHTML = "";
        const allOpt = el("option", null, "所有颜色");
        allOpt.value = "all";
        rt.colorSel.appendChild(allOpt);
        for (const c of colors) {
            const o = el("option", null, c);
            o.value = c;
            rt.colorSel.appendChild(o);
        }
        let keep = st.colorFilter;
        if (keep !== "all" && !colors.includes(keep)) keep = "all";
        st.colorFilter = keep;
        rt.colorSel.value = keep;

        // 列表
        const names = managedGroupNames(st);
        rt.list.innerHTML = "";
        if (names.length === 0) {
            rt.list.appendChild(
                el(
                    "div",
                    "ygim-empty",
                    st.mode === "custom"
                        ? "自定义模式默认不管理任何组，点上方「+ 添加组」自行挑选"
                        : "当前颜色下没有匹配的组"
                )
            );
            return;
        }
        for (const name of names) {
            rt.list.appendChild(buildRow(node, st, name));
        }
    } finally {
        // 统一落盘：buildRow 里可能对 linkage 做过规范化
        writeState(node, st);
    }
}

/** 取组框矩形 [x,y,w,h]。新版是 Rectangle(Float64Array)，旧版可能是 _bounding / bounding。 */
function groupRect(group) {
    const tries = [];
    try {
        if (group.boundingRect) tries.push(group.boundingRect); // 新版 getter，会顺带同步布局
    } catch (_) {
        /* ignore */
    }
    try {
        if (group.bounds) tries.push(group.bounds);
    } catch (_) {
        /* ignore */
    }
    try {
        if (group._bounding) tries.push(group._bounding);
    } catch (_) {
        /* ignore */
    }
    try {
        if (group.bounding) tries.push(group.bounding);
    } catch (_) {
        /* ignore */
    }

    for (const r of tries) {
        if (!r) continue;
        const x = Number(r[0]);
        const y = Number(r[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            return [x, y, Number(r[2]) || 0, Number(r[3]) || 0];
        }
    }

    // 兜底：pos + size
    try {
        const p = group.pos;
        const s = group.size;
        const x = Number(p?.[0]);
        const y = Number(p?.[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            return [x, y, Number(s?.[0]) || 0, Number(s?.[1]) || 0];
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

function focusGroup(name) {
    const group = findGroup(name);
    const canvas = app.canvas;
    if (!group || !canvas?.ds) return;
    const r = groupRect(group);
    if (!r) return;
    try {
        const cx = r[0] + r[2] / 2;
        const cy = r[1] + r[3] / 2;
        const el = canvas.canvasEl || canvas.canvas || canvas.ds?.canvas;
        const vw = el?.width || el?.clientWidth || 1200;
        const vh = el?.height || el?.clientHeight || 800;
        const scale = canvas.ds.scale || 1;
        canvas.ds.offset[0] = -cx * scale + vw / 2;
        canvas.ds.offset[1] = -cy * scale + vh / 2;
        canvas.setDirty(true, true);
    } catch (_) {
        /* 跳转失败不影响其它功能 */
    }
}

// ============================================================
// 八、UI 骨架
// ============================================================

function buildUI(node, rt) {
    injectStyle();
    const root = el("div", "ygim-root");

    // 顶栏
    const bar = el("div", "ygim-bar");
    bar.appendChild(el("div", "ygim-title", "组忽略管理器"));

    const modeSel = el("select", "ygim-sel");
    modeSel.title = "自定义：只管理手动添加的组；按颜色：管理同色组";
    for (const [v, t] of [
        ["custom", "自定义"],
        ["color", "按颜色"],
    ]) {
        const o = el("option", null, t);
        o.value = v;
        modeSel.appendChild(o);
    }
    bar.appendChild(modeSel);

    // 切换限制：放在「自定义/按颜色」与「+ 添加组」中间
    const restrictionSel = el("select", "ygim-sel");
    restrictionSel.title =
        "切换限制\n" +
        "默认：各组的开/关互不影响，可同时开启多个\n" +
        "只开启一个：打开某个组时，其余受管组自动忽略（类似 max one）。\n" +
        "切换此项本身不改动画布，下次点击组开关时才生效。";
    for (const [v, t] of [
        [RESTRICT_DEFAULT, "默认"],
        [RESTRICT_ONLY_ONE, "只开启一个"],
    ]) {
        const o = el("option", null, t);
        o.value = v;
        restrictionSel.appendChild(o);
    }
    bar.appendChild(restrictionSel);

    const addBtn = el("button", "ygim-btn ygim-btn-primary", "+ 添加组");
    bar.appendChild(addBtn);

    const refreshBtn = el("button", "ygim-btn ygim-icon");
    refreshBtn.innerHTML = ICON.refresh;
    refreshBtn.title = "刷新列表";
    bar.appendChild(refreshBtn);

    // 排序：自定义模式下默认就是字母序，拖拽过之后用它切回字母序
    const sortBtn = el("button", "ygim-btn ygim-icon");
    sortBtn.innerHTML = ICON.sortAz;
    sortBtn.title = "按名称排序（清除手动拖拽顺序）";
    bar.appendChild(sortBtn);

    root.appendChild(bar);

    // 颜色过滤行
    const bar2 = el("div", "ygim-bar2");
    bar2.appendChild(el("span", "ygim-title", "颜色过滤"));
    const colorSel = el("select", "ygim-sel");
    bar2.appendChild(colorSel);
    root.appendChild(bar2);

    // 列表
    const list = el("div", "ygim-list");
    root.appendChild(list);

    Object.assign(rt, {
        root,
        modeSel,
        restrictionSel,
        addBtn,
        refreshBtn,
        sortBtn,
        bar2,
        colorSel,
        list,
    });

    sortBtn.addEventListener("click", () => {
        const st = readState(node);
        const existNow = new Set(allGroups().map((g) => g.title));
        st.order = sortNames(st.order.filter((n) => existNow.has(n)));
        st.orderManual = false;
        writeState(node, st);
        renderAll(node);
    });

    modeSel.addEventListener("change", () => {
        const st = readState(node);
        st.mode = modeSel.value === "color" ? "color" : "custom";
        writeState(node, st);
        renderAll(node);
    });

    restrictionSel.addEventListener("change", () => {
        const st = readState(node);
        // 只记录设置，**不立刻改动画布**。
        // 「只开启一个」在用户下一次点击组开关时才生效 —— 纯粹由点击驱动，
        // 避免只是切了个下拉框就把用户当前开着的多个组静默 bypass 掉。
        st.restriction =
            restrictionSel.value === RESTRICT_ONLY_ONE ? RESTRICT_ONLY_ONE : RESTRICT_DEFAULT;
        writeState(node, st);
        renderAll(node);
    });

    colorSel.addEventListener("change", () => {
        const st = readState(node);
        st.colorFilter = colorSel.value || "all";
        writeState(node, st);
        renderAll(node);
    });

    addBtn.addEventListener("click", () => openAddDialog(node));

    refreshBtn.addEventListener("click", () => renderAll(node));

    return root;
}

// ============================================================
// 九、同步（图里的组增删、手动改了 mode 后自动反映）
// ============================================================

function startWatcher(node) {
    stopWatcher(node);
    const handle = setInterval(() => {
        const rt = RUNTIME.get(node);
        if (!rt) {
            stopWatcher(node);
            return;
        }
        try {
            const st = readState(node);
            const names = managedGroupNames(st);
            const shown = [...rt.list.querySelectorAll(".ygim-row")].map((r) => r.dataset.name);
            if (names.length !== shown.length || names.some((n, i) => n !== shown[i])) {
                renderAll(node);
                return;
            }
            // 同步开关外观（用户可能直接在画布上改节点的 bypass 状态）
            for (const row of rt.list.querySelectorAll(".ygim-row")) {
                const g = findGroup(row.dataset.name);
                if (!g) continue;
                const inner = collectGroupNodesDeep(g);
                const isEmpty = inner.length === 0;
                const on = isEmpty || nodesHaveActive(inner);

                // 空组状态变了（节点被拖进 / 拖出组框）→ 整表重绘，把徽标也刷新掉
                if (isEmpty !== !!row.querySelector(".ygim-badge")) {
                    renderAll(node);
                    return;
                }

                const showingOn = row.classList.contains("ygim-power-on");
                if (on === showingOn) continue;
                row.classList.toggle("ygim-off", !on);
                const btn = row.querySelector(".ygim-round");
                if (btn) {
                    btn.classList.toggle("ygim-power-on", on);
                    btn.classList.toggle("ygim-power-off", !on);
                    btn.disabled = isEmpty;
                    btn.style.opacity = isEmpty ? "0.35" : "";
                    btn.style.cursor = isEmpty ? "not-allowed" : "";
                    btn.title = isEmpty
                        ? "该组内还没有节点：把节点拖进组框范围内即可"
                        : on
                          ? "点击忽略该组"
                          : "点击开启该组";
                }
            }
        } catch (err) {
            console.warn("[yanhuo-GIM] 同步失败:", err);
        }
    }, 1200);
    TIMERS.set(node, handle);
}

function stopWatcher(node) {
    const t = TIMERS.get(node);
    if (t) {
        clearInterval(t);
        TIMERS.delete(node);
    }
}

// ============================================================
// 十、注册
// ============================================================

console.log(`[yanhuo-GIM] 组忽略管理器扩展已加载，build=${BUILD}`);

app.registerExtension({
    name: "yanhuo.easy.use.GroupIgnoreManager",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.size = [DEFAULT_W, DEFAULT_H];

            const rt = { migrated: false, dragFrom: null, linking: new Set() };
            RUNTIME.set(node, rt);

            const root = buildUI(node, rt);

            // R3：DOM widget 一律不序列化，且不交出任何值
            try {
                root.style.height = "100%";
                const widget = node.addDOMWidget("ygim_ui", "div", root, {
                    serialize: false,
                    hideOnZoom: false,
                });
                if (widget) {
                    widget.serialize = false;
                    widget.serializeValue = () => undefined;
                    // 让面板高度跟随节点尺寸
                    widget.computeSize = (w) =>
                        [w, Math.max(160, (node.size?.[1] ?? DEFAULT_H) - 44)];
                }
            } catch (err) {
                console.warn("[yanhuo-GIM] DOM 面板挂载失败，节点将以普通节点形式存在:", err);
            }

            // 下一帧再渲染，确保图里的组已就绪
            setTimeout(() => {
                if (!RUNTIME.has(node)) return;
                renderAll(node);
                startWatcher(node);
            }, 0);

            // 节点移除时清理
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                stopWatcher(node);
                RUNTIME.delete(node);
                return onRemoved?.apply(this, arguments);
            };

            return r;
        };
    },
});
