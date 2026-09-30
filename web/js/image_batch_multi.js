import { app } from "../../../scripts/app.js";

/**
 * 图像批次合并节点前端：
 * - 「输入数量」控件 + 「更新输入」按钮，动态增删 image_N 输入端口。
 * - 加载工作流时按保存的端口自动恢复（保持连接数优先于控件数值，避免断链）。
 * - 空输入（未连接或实际 0 张）由后端直接跳过，不生成黑色占位图。
 */
app.registerExtension({
    name: "yanhuo.easy.use.ImageBatchMulti",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "YanhuoImageBatchMulti") return;

        const TYPE = "IMAGE";
        const PREFIX = "image_";
        const MAX_INPUTS = 50;

        // 按目标数量增删 image_N 端口；keepConnected=true 时以当前最大已连接序号为下限，避免断链
        const rebuildInputs = (node, keepConnected) => {
            if (!node.widgets) return;
            const countW = node.widgets.find(w => w.name === "输入数量");
            if (!countW) return;

            node.inputs = node.inputs || [];
            let target = Math.max(2, Math.min(MAX_INPUTS, parseInt(countW.value) || 2));

            if (keepConnected) {
                let maxConnected = 0;
                for (const inp of node.inputs) {
                    const m = inp.name && inp.name.startsWith(PREFIX)
                        ? parseInt(inp.name.slice(PREFIX.length))
                        : NaN;
                    if (!isNaN(m) && inp.link != null) maxConnected = Math.max(maxConnected, m);
                }
                target = Math.max(target, maxConnected);
            }

            const dynamic = node.inputs.filter(i => i.name && i.name.startsWith(PREFIX));
            const current = dynamic.length;

            if (target < current) {
                // 从后往前删多余的 image_N 端口
                for (let i = node.inputs.length - 1; i >= 0 && current - target > 0; i--) {
                    const inp = node.inputs[i];
                    if (inp.name && inp.name.startsWith(PREFIX)) {
                        const idx = parseInt(inp.name.slice(PREFIX.length));
                        if (idx > target) {
                            node.removeInput(i);
                        }
                    }
                }
            } else if (target > current) {
                for (let i = current + 1; i <= target; i++) {
                    node.addInput(`${PREFIX}${i}`, TYPE, { shape: 7 });
                }
            }

            node.setSize(node.computeSize());
            node.setDirtyCanvas(true, true);
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            node.addWidget("button", "更新输入", null, () => rebuildInputs(node, false));

            // 初始裁剪到默认端口数（后端声明了全部 image_1..N，创建时裁掉多余端口）
            setTimeout(() => rebuildInputs(node, true), 0);
        };

        // 加载工作流后恢复端口（保留已连接的端口，避免旧工作流断链）
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const node = this;
            setTimeout(() => rebuildInputs(node, true), 0);
        };
    },
});
