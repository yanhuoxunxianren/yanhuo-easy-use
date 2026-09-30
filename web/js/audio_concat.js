import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "yanhuo.easy.use.AudioConcat",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "YanhuoAudioConcat") return;

        const MAX_INPUTS = 9;      // 最大输入端口数（你可以改成 19）
        const INITIAL_INPUTS = 2;  // 初始显示数量

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            // 动态更新输入端口可见性
            const updateVisibility = () => {
                let maxConnected = 0;

                // 找出当前连接的最大的音频序号
                for (let i = 1; i <= MAX_INPUTS; i++) {
                    const inputName = `音频${i}`;
                    const input = node.inputs?.find(inp => inp.name === inputName);
                    if (input && input.link !== null) {
                        maxConnected = Math.max(maxConnected, i);
                    }
                }

                // 计算需要显示的端口数量：至少显示 INITIAL_INPUTS 个，最多 MAX_INPUTS 个
                // 如果连接了第 i 个，则显示到 i+1 个（为了能继续扩展）
                const visibleCount = Math.min(MAX_INPUTS, Math.max(INITIAL_INPUTS, maxConnected + 1));

                // 设置每个输入端口的 hidden 属性
                for (let i = 1; i <= MAX_INPUTS; i++) {
                    const inputName = `音频${i}`;
                    const input = node.inputs?.find(inp => inp.name === inputName);
                    if (input) {
                        input.hidden = i > visibleCount;
                    }
                }

                // 重新计算节点大小并重绘
                node.setSize(node.computeSize());
                node.setDirtyCanvas(true, true);
            };

            // 监听连接变化
            const origOnConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, index, connected, link_info, ioSlot) {
                origOnConnectionsChange?.apply(this, arguments);
                // 延迟一帧，等待 ComfyUI 更新内部的连接状态
                requestAnimationFrame(() => {
                    updateVisibility();
                });
            };

            // 初始延迟一帧执行，确保 INPUT_TYPES 中的端口已经全部建立
            setTimeout(updateVisibility, 0);
        };
    },
});