/** yanhuo-easy-use · 视频对比前端：把 ui 的 a_images/b_images 映射到官方 imagecompare 滑轨组件 */
import { app } from "../../../scripts/app.js";

// 与官方 Comfy.ImageCompare 扩展同构，但作用于本包的「视频对比」节点。
// 官方扩展硬编码 comfyClass === "ImageCompare"，不会管我们的类名，所以这里镜像一份。
app.registerExtension({
    name: "yanhuo.easy.use.VideoCompare",
    nodeCreated(node) {
        if (node.comfyClass !== "YanhuoVideoCompare") return;

        const [w, h] = node.size;
        node.setSize([Math.max(w, 400), Math.max(h, 350)]);

        const findWidget = () => {
            const ws = node.widgets || [];
            return ws.find(w => (w.type || "").toLowerCase() === "imagecompare")
                || ws.find(w => (w.type || "").toLowerCase().includes("compare"))
                || ws.find(w => (w.name || "") === "compare_view");
        };

        const origOnExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            origOnExecuted?.call(this, message);
            const { a_images, b_images } = message || {};
            const rand = (typeof app.getRandParam === "function") ? app.getRandParam() : "";
            const toUrl = (e) => {
                const p = new URLSearchParams(e);
                return app.apiURL(`/view?${p}${rand}`);
            };
            const before = a_images && a_images.length > 0 ? a_images.map(toUrl) : [];
            const after = b_images && b_images.length > 0 ? b_images.map(toUrl) : [];

            const widget = findWidget();
            if (!widget) {
                console.warn("[yanhuo][视频对比] 未找到 imagecompare 组件，widgets 类型：",
                    (node.widgets || []).map(w => `${w.name}:${w.type}`));
                return;
            }
            widget.value = { beforeImages: before, afterImages: after };
            console.log("[yanhuo][视频对比] 已喂给滑轨组件：before", before.length, "帧 / after", after.length, "帧");
            app.graph?.setDirtyCanvas(true, true);
        };
    },
});
