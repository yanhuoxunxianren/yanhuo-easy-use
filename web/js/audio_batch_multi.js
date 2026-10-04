import { app } from "../../../scripts/app.js";

/**
 * 音频批次合并节点前端：
 * - 「输入数量」控件 + 「更新输入」按钮管理 audio_1..audio_N 动态端口。
 * - 加载工作流时按控件数值恢复端口，并保留已连接端口防止断链。
 */
app.registerExtension({
    name: "yanhuo.easy.use.AudioBatchMulti",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "YanhuoAudioBatchMulti") return;

        const TYPE = "AUDIO";
        const PREFIX = "audio_";
        const MAX_INPUTS = 50;
        const INITIAL_INPUTS = 2;

        /** 计算目标端口数：取控件值与「已连接的最大端口序号」的较大者，避免断开已有连线 */
        function targetCount(node) {
            const countW = node.widgets?.find(w => w.name === "输入数量");
            let fromWidget = INITIAL_INPUTS;
            if (countW && Number.isFinite(countW.value)) {
                fromWidget = Math.max(2, Math.min(MAX_INPUTS, Math.round(countW.value)));
            }
            let maxConnected = 0;
            for (const inp of node.inputs || []) {
                const m = /^audio_(\d+)$/.exec(inp.name || "");
                if (m && inp.link !== null && inp.link !== undefined) {
                    maxConnected = Math.max(maxConnected, parseInt(m[1], 10));
                }
            }
            return Math.min(MAX_INPUTS, Math.max(fromWidget, maxConnected));
        }

        function rebuild(node) {
            if (!node.inputs) node.inputs = [];
            const target = targetCount(node);
            const current = node.inputs.filter(i => i.name?.startsWith(PREFIX)).length;
            if (target < current) {
                for (let i = 0; i < current - target; i++) {
                    node.removeInput(node.inputs.length - 1);
                }
            } else if (target > current) {
                for (let i = current + 1; i <= target; i++) {
                    node.addInput(`${PREFIX}${i}`, TYPE, { shape: 7 });
                }
            }
            node.setSize(node.computeSize());
            node.setDirtyCanvas(true, true);
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;
            node.addWidget("button", "更新输入", null, () => rebuild(node));
            setTimeout(() => rebuild(node), 0);
        };

        // 加载工作流后按保存的控件数值恢复端口
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const node = this;
            setTimeout(() => rebuild(node), 0);
        };
    },
});
