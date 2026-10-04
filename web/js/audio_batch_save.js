/** yanhuo-easy-use · 音频批次预览/保存 结果面板（运行后逐段列出，每段一行） */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const ROW_H = 32;
const HEADER_H = 22;
const GAP = 4;
const PADDING = 6;
const MAX_ROWS_STORED = 200; // 持久化上限，防止工作流 JSON 膨胀

function viewUrl(entry) {
    const base = api.apiURL ? api.apiURL("/view") : "/view";
    return `${base}?filename=${encodeURIComponent(entry.filename)}` +
           `&type=${encodeURIComponent(entry.type || "output")}` +
           `&subfolder=${encodeURIComponent(entry.subfolder || "")}`;
}

// 预览并保存模式下同一段会出现 output+temp 两条，优先展示保存件，避免重复行
function dedupe(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
        if (e.type === "temp" && seen.has(e.filename)) continue;
        seen.add(e.filename);
        out.push(e);
    }
    return out;
}

app.registerExtension({
    name: "yanhuo.easy.use.AudioBatchSave",
    nodeCreated(node) {
        if (node.comfyClass !== "YanhuoAudioBatchSave") return;

        let results = []; // [{filename, subfolder, type}]

        // --- 容器 ---
        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%; background: #1e1e2a; border: 1px solid #353545;
            border-radius: 4px; margin-top: 5px; padding: ${PADDING}px;
            box-sizing: border-box; display: flex; flex-direction: column;
            pointer-events: auto; overflow: hidden;
        `;

        // --- 头部：统计 + 清空 ---
        const header = document.createElement("div");
        header.style.cssText = `
            display: flex; align-items: center; justify-content: space-between;
            height: ${HEADER_H}px; padding: 0 2px; flex-shrink: 0;
        `;
        const title = document.createElement("span");
        title.style.cssText = "color:#8a97b8; font-size:10px;";
        header.appendChild(title);

        const clearBtn = document.createElement("button");
        clearBtn.innerText = "清空";
        clearBtn.style.cssText = `
            background:#5a2a2a; border:1px solid #7f3a3a; color:#eee;
            border-radius:3px; padding:1px 8px; font-size:10px; cursor:pointer;
        `;
        clearBtn.onclick = () => {
            results = [];
            render();
            saveResults();
            updateHeight();
        };
        header.appendChild(clearBtn);
        container.appendChild(header);

        const listEl = document.createElement("div");
        listEl.style.cssText = "display:flex; flex-direction:column; gap:3px; overflow-y:auto;";
        container.appendChild(listEl);

        const widget = node.addDOMWidget("AudioBatchResults", "html_audio_results", container, { serialize: false });

        // --- 渲染 ---
        function render() {
            listEl.innerHTML = "";
            title.textContent = results.length ? `批次结果：${results.length} 段` : "批次结果";
            clearBtn.style.display = results.length ? "" : "none";

            if (results.length === 0) {
                const empty = document.createElement("div");
                empty.style.cssText = "color:#555; font-size:10px; padding:4px 2px;";
                empty.innerText = "运行后在此逐段显示批次结果（每段一行）";
                listEl.appendChild(empty);
                return;
            }

            results.forEach((entry, i) => {
                const row = document.createElement("div");
                row.style.cssText = `
                    display:flex; align-items:center; gap:5px; height:${ROW_H}px;
                    background:#20283a; border:1px solid #3a4a6a; border-radius:3px;
                    padding:0 6px; box-sizing:border-box;
                `;

                const idx = document.createElement("span");
                idx.innerText = String(i + 1);
                idx.style.cssText = "color:#6a7a9a; font-size:10px; min-width:18px; text-align:right; flex-shrink:0;";
                row.appendChild(idx);

                const badge = document.createElement("span");
                badge.innerText = entry.type === "temp" ? "预览" : "保存";
                const isTemp = entry.type === "temp";
                badge.style.cssText = `
                    font-size:9px; padding:1px 5px; border-radius:2px; flex-shrink:0;
                    background:${isTemp ? "#2e4a3a" : "#3a3a5c"}; color:#cfe; border:1px solid ${isTemp ? "#4a7f5a" : "#5a5f8a"};
                `;
                row.appendChild(badge);

                const name = document.createElement("span");
                name.innerText = entry.filename;
                name.title = (entry.subfolder ? entry.subfolder + "/" : "") + entry.filename;
                name.style.cssText = `
                    color:#9fb4d8; font-size:10px; overflow:hidden;
                    text-overflow:ellipsis; white-space:nowrap; flex-shrink:1;
                    min-width:0; max-width:40%;
                `;
                row.appendChild(name);

                const player = document.createElement("audio");
                player.controls = true;
                player.src = viewUrl(entry);
                player.preload = "none";
                player.style.cssText = "flex-grow:1; height:24px; min-width:60px;";
                row.appendChild(player);

                listEl.appendChild(row);
            });
        }

        // --- 尺寸 ---
        const MAX_VISIBLE_ROWS = 100; // 超过后内部滚动，节点高度封顶
        function containerHeight() {
            const bodyH = results.length === 0
                ? 24
                : Math.min(results.length, MAX_VISIBLE_ROWS) * (ROW_H + 3);
            return PADDING * 2 + HEADER_H + 4 + bodyH;
        }
        function minHeight() {
            return (widget.last_y || 40) + containerHeight() + 10;
        }
        function updateHeight(force) {
            container.style.height = containerHeight() + "px";
            node.min_size = [300, minHeight()];
            const h = force ? minHeight() : Math.max(node.size[1], minHeight());
            if (node.size[1] !== h || node.size[0] < 300) {
                node.setSize([Math.max(node.size[0], 300), h]);
            }
            app.graph?.setDirtyCanvas(true, true);
        }
        widget.computeSize = function () {
            return [Math.max(10, (node.size?.[0] || 300) - 30), containerHeight()];
        };
        const origComputeSize = node.computeSize;
        node.computeSize = function () {
            let res = origComputeSize ? origComputeSize.apply(this, arguments) : [300, 200];
            res[0] = Math.max(res[0], 300);
            res[1] = Math.max(res[1], minHeight());
            node.min_size = [300, minHeight()];
            return res;
        };
        const origSetSize = node.setSize;
        node.setSize = function (size) {
            size[0] = Math.max(size[0], 300);
            size[1] = Math.max(size[1], minHeight());
            if (origSetSize) origSetSize.call(this, size); else this.size = size;
        };

        // --- 结果持久化（工作流里保留上次结果，重开页面不丢） ---
        function saveResults() {
            try {
                node.properties.yanhuoSaveResults = JSON.stringify(results.slice(0, MAX_ROWS_STORED));
            } catch (_) {}
        }
        function loadResults() {
            try {
                const raw = node.properties?.yanhuoSaveResults;
                const arr = raw ? JSON.parse(raw) : [];
                results = Array.isArray(arr) ? arr.filter(e => e && e.filename) : [];
            } catch (_) { results = []; }
        }

        // --- 执行结果回调 ---
        const origOnExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            const out = origOnExecuted ? origOnExecuted.apply(this, arguments) : undefined;
            const entries = (message && Array.isArray(message.audio)) ? message.audio : [];
            if (entries.length > 0) {
                results = dedupe(entries.filter(e => e && e.filename)).slice(0, MAX_ROWS_STORED);
                render();
                saveResults();
                updateHeight(true);
            }
            return out;
        };

        // --- 初始化 ---
        loadResults();
        render();
        const origOnConfigure = node.onConfigure;
        node.onConfigure = function () {
            const out = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
            loadResults();
            render();
            requestAnimationFrame(() => updateHeight(true));
            return out;
        };
        const origOnAdded = node.onAdded;
        node.onAdded = function () {
            if (origOnAdded) origOnAdded.apply(this, arguments);
            requestAnimationFrame(() => updateHeight(true));
        };
        setTimeout(() => updateHeight(true), 100);
    },
});
