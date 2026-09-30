import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "yanhuo.easy.use.IntegerControl",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "YanhuoIntegerControl") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            const findWidget = (name) =>
                node.widgets?.find((w) => w.name === name);

            const valueWidget   = findWidget("数值");
            const controlWidget = findWidget("生成后控制");
            const incWidget     = findWidget("增加数值");
            const decWidget     = findWidget("减少数值");

            if (!valueWidget || !controlWidget || !incWidget || !decWidget) {
                return;
            }

            // ---- 保存每个控件的原始方法，方便恢复 ----
            const origIncSize = incWidget.computeSize;
            const origDecSize = decWidget.computeSize;
            const origIncDraw = incWidget.draw;
            const origDecDraw = decWidget.draw;

            // 默认 computeSize（当 widget 本身没定义时用）
            const defaultSize = function (width) {
                return [width, 20];
            };

            // ---- 隐藏控件：高度归零 + 不绘制 ----
            const hideWidget = (widget) => {
                widget.computeSize = () => [0, -4];
                widget.draw = () => {};
            };

            // ---- 恢复控件 ----
            const showWidget = (widget, origSize, origDraw) => {
                widget.computeSize = origSize || defaultSize;
                if (origDraw) {
                    widget.draw = origDraw;
                } else {
                    // 原始没有自定义 draw，就删掉覆盖，回到原型方法
                    delete widget.draw;
                }
            };

            const applyVisibility = () => {
                const mode = controlWidget.value;
                const showInc = mode === "增加";
                const showDec = mode === "减少";

                if (showInc) {
                    showWidget(incWidget, origIncSize, origIncDraw);
                } else {
                    hideWidget(incWidget);
                }

                if (showDec) {
                    showWidget(decWidget, origDecSize, origDecDraw);
                } else {
                    hideWidget(decWidget);
                }

                // 关键：用 requestAnimationFrame 让 ComfyUI 先完成本轮布局，
                // 然后直接 setSize 到 computeSize 的高度（不再用 Math.max）
                requestAnimationFrame(() => {
                    const computed = node.computeSize();
                    node.setSize([node.size[0], computed[1]]);
                    node.setDirtyCanvas(true, true);
                });
            };

            // ---- 下拉菜单变化时刷新 ----
            const origCallback = controlWidget.callback;
            controlWidget.callback = function () {
                const r = origCallback?.apply(this, arguments);
                applyVisibility();
                return r;
            };

            // ---- 加载旧工作流时也应用一次 ----
            const origConfigure = node.onConfigure;
            node.onConfigure = function () {
                const r = origConfigure?.apply(this, arguments);
                setTimeout(applyVisibility, 0);
                return r;
            };

            // 初次应用（延迟两拍，等控件完全建好）
            applyVisibility();
            setTimeout(applyVisibility, 10);
        };

        // ========== 执行结束后：把 next_value 写回"数值"输入框 ==========
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (!message || !message.next_value) return;

            const newVal = message.next_value[0];
            if (newVal === undefined || newVal === null) return;

            const vw = this.widgets?.find((w) => w.name === "数值");
            if (vw) {
                vw.value = Number(newVal);
                this.setDirtyCanvas(true, true);
            }
        };
    },
});