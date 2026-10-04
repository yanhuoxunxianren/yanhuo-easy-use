import json
import os
import random
import re

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

import folder_paths
import comfy.utils

try:
    import av
except ImportError:
    av = None

INT_MIN = -9223372036854775807
INT_MAX = 9223372036854775807


class AnyType(str):
    """万用类型：与任何类型比较都相等，用于接受任意输入的端口。"""

    def __ne__(self, __value):
        return False


# ==== 台词保护：引号对常量与掩码构建（文本批量替换共用） ====

# opening, closing, rank（秩：同秩才能配成一对，避免不同引号互配）
# 包含 ASCII 半角引号、中文弯引号（“”/‘’）、中文直角引号「」/『』
QUOTE_PAIRS = [
    ('"', '"', 1),
    ("'", "'", 2),
    ("“", "”", 3),
    ("‘", "’", 4),
    ("「", "」", 5),
    ("『", "』", 6),
]


def _build_quote_protect_mask(text):
    """返回与 text 等长的 bool 列表：True 表示该位置在引号对内部（台词保护，不替换）；False 表示可替换。"""
    n = len(text)
    mask = [False] * n
    if n == 0:
        return mask

    opening_map = {}
    closing_map = {}
    for op, cl, rk in QUOTE_PAIRS:
        opening_map.setdefault(op, []).append((cl, rk))
        closing_map.setdefault(cl, []).append((op, rk))

    # 栈：存 (rank, closing_char, start_idx)
    stack = []
    i = 0
    while i < n:
        ch = text[i]
        # 尝试作为 opening：半角引号 " / ' 既可开也可关，同 rank 未闭合栈顶在则作 closing（优先关闭）
        if ch in opening_map:
            if ch in ('"', "'"):
                expected_rank = 1 if ch == '"' else 2
                if stack and stack[-1][0] == expected_rank:
                    _rank, _cl, start = stack.pop()
                    # 把 [start, i] 全部标记为台词内部（含引号自身）
                    for k in range(start, i + 1):
                        mask[k] = True
                    i += 1
                    continue
            (closing_char, rank) = opening_map[ch][0]
            stack.append((rank, closing_char, i))
            i += 1
            continue
        # 尝试作为 closing：匹配最近未闭合、同 rank 的 opening
        if ch in closing_map:
            found = None
            for si in range(len(stack) - 1, -1, -1):
                if stack[si][1] == ch:
                    found = si
                    break
            if found is not None:
                _rank, _cl, start = stack.pop(found)
                for k in range(start, i + 1):
                    mask[k] = True
                i += 1
                continue
        # 普通字符或找不到对应开引号的闭引号：跳过
        i += 1
    # 文本结束后仍留在栈中的未闭合开引号：不标记（按正常文本处理）
    return mask


class YanhuoIntegerControl:
    """
    整数控制节点
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "数值": ("INT", {"default": 0, "min": INT_MIN, "max": INT_MAX, "step": 1, "display": "number"}),
                "生成后控制": (["固定", "增加", "减少", "随机"], {"default": "固定"}),
                "增加数值": ("INT", {"default": 0, "min": INT_MIN, "max": INT_MAX, "step": 1, "display": "number"}),
                "减少数值": ("INT", {"default": 0, "min": INT_MIN, "max": INT_MAX, "step": 1, "display": "number"}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("整数",)
    FUNCTION = "run"
    CATEGORY = "yanhuo"
    DESCRIPTION = "整数控制节点：生成后支持 固定/增加/减少/随机，增加与减少的步长可由用户自定义。"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def run(self, 数值, 生成后控制, 增加数值, 减少数值):
        current = int(数值)
        result = current
        next_value = current

        if 生成后控制 == "增加":
            next_value = current + int(增加数值)
        elif 生成后控制 == "减少":
            next_value = current - int(减少数值)
        elif 生成后控制 == "随机":
            result = random.randint(INT_MIN, INT_MAX)

        return {"ui": {"next_value": [next_value]}, "result": (result,)}


class YanhuoAudioConcat:
    """
    音频拼接节点（动态扩展版）
    """
    @classmethod
    def INPUT_TYPES(cls):
        optional_inputs = {f"音频{i}": ("AUDIO",) for i in range(1, 10)}
        return {
            "required": {"方向": (["之后", "之前"], {"default": "之后"})},
            "optional": optional_inputs,
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("音频",)
    FUNCTION = "concat"
    CATEGORY = "yanhuo"
    DESCRIPTION = "音频拼接节点：支持最多9段音频拼接，自动扩展输入端口，方向支持中文。"

    def concat(self, 方向, **kwargs):
        audios = []
        for i in range(1, 10):
            key = f"音频{i}"
            if key in kwargs and kwargs[key] is not None:
                audios.append(kwargs[key])

        if len(audios) == 0:
            raise ValueError("至少需要连接一个音频输入。")
        if len(audios) == 1:
            return (audios[0],)

        if 方向 == "之前":
            audios = audios[::-1]

        sample_rate = audios[0]["sample_rate"]
        for a in audios:
            if a["sample_rate"] != sample_rate:
                print(f"[yanhuo] 警告: 音频采样率不一致。")

        waveforms = [a["waveform"] for a in audios]

        try:
            concatenated = torch.cat(waveforms, dim=-1)
        except Exception as e:
            raise RuntimeError(f"音频拼接失败，请检查音频通道数和形状是否一致。错误详情: {e}")

        return ({"waveform": concatenated, "sample_rate": sample_rate},)


class YanhuoImageBatchMulti:
    """
    图像批次合并节点（动态端口 + 跳过空输入 + 尺寸不一致自动对齐，不中断）
    - 通过「输入数量」+「更新输入」按钮管理 image_1..image_N 输入端口（最多 50）。
    - 按端口序号顺序把多个图像/图像列表合并为一个图像列表（batch）输出。
    - 【核心特性 1】自动跳过空输入：未连接（None）、非张量、batch 为 0（连接了但实际
      输入 0 张图像）的端口一律跳过，不生成黑色占位图，并用下一路的有效图像继续合并。
      例：图像_1 输入 3 张、图像_2 输入 0 张、图像_3 输入 1 张 →
      输出 3 + 1 = 4 张图像的合并列表，图像_2 被直接跳过。
    - 【核心特性 2】（默认开启）跳过黑色占位图：上游「筛选图像」等节点在无有效结果时会
      输出 1 张 64×64 全黑兜底图，这类输入视为空，同样跳过（可用开关关掉）。
    - 【核心特性 3】尺寸不一致不再报错：默认按「缩放到第一张」自动对齐，
      也可选「缩放到最大」（拉伸）、「填充到最大」（保比例居中补黑）、
      「按原像素（图像列表）」（不缩放，输出图像列表，允许每张图尺寸不同），
      只有显式选「严格」才会报错。
    - 【核心特性 4】输出为图像列表（OUTPUT_IS_LIST）：普通模式下列表里只有 1 个
      合并 batch（对下游无感）；「按原像素」模式下列表里每张图一个元素、尺寸可不同。
    - 输入端口支持图像列表（INPUT_IS_LIST）：上游图像列表会按顺序展开后再合并。
    - 全部端口都为空时输出 1 张 64×64 黑图兜底（与筛选图像约定一致），不抛异常、不中断执行。
    """

    MAX_INPUTS = 50

    @classmethod
    def INPUT_TYPES(cls):
        optional_inputs = {f"image_{i}": ("IMAGE",) for i in range(1, cls.MAX_INPUTS + 1)}
        return {
            "required": {
                "输入数量": ("INT", {"default": 3, "min": 2, "max": cls.MAX_INPUTS, "step": 1}),
                "尺寸处理": ([
                    "缩放到第一张", "缩放到最大", "中心缩放裁切到最大", "填充到最大",
                    "按原像素（图像列表）", "严格",
                ], {
                    "default": "缩放到第一张",
                    "tooltip": "各路分辨率不一致时的处理方式：\n"
                               "● 缩放到第一张（默认）：全部拉伸到第 1 路有效输入的尺寸，自动对齐、不报错。\n"
                               "● 缩放到最大：全部拉伸到所有输入中最大的宽高（不等比，画面会变形）。\n"
                               "● 中心缩放裁切到最大：等比缩放到覆盖最大宽高后居中裁切，不拉伸变形、无黑边（会裁掉边缘）。\n"
                               "● 填充到最大：保持各自比例居中放置，四周补黑到最大宽高（不变形、有黑边）。\n"
                               "● 按原像素（图像列表）：完全不缩放，输出为图像列表，列表中每张图保持原始分辨率（可各不相同）。\n"
                               "● 严格：尺寸必须完全一致，否则报错中断。",
                }),
                "跳过黑色占位图": ("BOOLEAN", {
                    "default": True,
                    "label_on": "跳过",
                    "label_off": "保留",
                    "tooltip": "上游筛选类节点在无结果时会输出 1 张 64×64 全黑兜底图。"
                               "开启时把这类输入视为空输入并跳过，不参与合并。",
                }),
            },
            "optional": optional_inputs,
            # 输入端口接受图像列表：上游图像列表按顺序展开后参与合并
            "INPUT_IS_LIST": {f"image_{i}": True for i in range(1, cls.MAX_INPUTS + 1)},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    # 输出为图像列表：普通模式下仅 1 个元素（合并 batch）；按原像素模式下每张图一个元素
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "batch"
    CATEGORY = "yanhuo"
    DESCRIPTION = (
        "图像批次合并节点：合并多个图像/图像列表为一个图像列表，按端口顺序拼接。"
        "通过「输入数量」设置输入接口数量，点击「更新输入」刷新接口。"
        "自动跳过所有空输入（未连接 / 实际 0 张 / 64×64 全黑兜底图），用后续有效输入继续合并；"
        "分辨率不一致时自动对齐不报错，「按原像素（图像列表）」模式可保持各图原始分辨率输出。"
    )

    @staticmethod
    def _is_placeholder_black(img):
        """判断是否为 1 张 64×64 全黑兜底图（筛选类节点无结果时的约定输出）。"""
        try:
            if img.ndim == 4 and img.shape[0] == 1 and img.shape[1] == 64 and img.shape[2] == 64:
                return bool(torch.all(img <= 1e-6))
        except Exception:
            return False
        return False

    @staticmethod
    def _resize_to(img, target_h, target_w):
        """[B,H,W,C] 缩放到目标宽高（双线性插值，拉伸填充）。"""
        x = img.permute(0, 3, 1, 2).float()
        x = F.interpolate(x, size=(target_h, target_w), mode="bilinear", align_corners=False)
        return x.permute(0, 2, 3, 1).to(img.dtype)

    @staticmethod
    def _cover_crop_to(img, target_h, target_w):
        """[B,H,W,C] 等比缩放到覆盖目标宽高（短边对齐）后中心裁切：不变形、无黑边、裁掉边缘。"""
        _, h, w, _ = img.shape
        scale = max(target_w / w, target_h / h)
        nw = max(target_w, round(w * scale))
        nh = max(target_h, round(h * scale))
        img = YanhuoImageBatchMulti._resize_to(img, nh, nw)
        _, sh, sw, _ = img.shape
        x1 = (sw - target_w) // 2
        y1 = (sh - target_h) // 2
        return img[:, y1:y1 + target_h, x1:x1 + target_w, :]

    @staticmethod
    def _pad_to(img, target_h, target_w):
        """[B,H,W,C] 保持比例居中放置到目标宽高，四周补黑（不拉伸）。"""
        _, h, w, c = img.shape
        if w >= target_w or h >= target_h:
            # 比目标大：先等比缩到能放进目标框，再居中放置
            scale = min(target_w / w, target_h / h)
            nw = max(1, min(target_w, round(w * scale)))
            nh = max(1, min(target_h, round(h * scale)))
            img = YanhuoImageBatchMulti._resize_to(img, nh, nw)
            _, h, w, c = img.shape
        out = torch.zeros((img.shape[0], target_h, target_w, img.shape[3]),
                          dtype=img.dtype, device=img.device)
        y1 = (target_h - h) // 2
        x1 = (target_w - w) // 2
        out[:, y1:y1 + h, x1:x1 + w, :] = img
        return out

    def batch(self, 输入数量=3, 尺寸处理="缩放到第一张", 跳过黑色占位图=True, **kwargs):
        # INPUT_IS_LIST 模式下 widget 值也会被包成单元素列表，先取回标量
        尺寸处理 = _unwrap_list_input(尺寸处理)
        跳过黑色占位图 = _unwrap_list_input(跳过黑色占位图)
        # 1) 收集所有 image_N 端口（按序号排序）；输入数量仅控制前端端口数量，
        #    后端以实际接入的有效输入为准，避免 UI 与实际连接不同步时丢数据。
        #    端口声明了 INPUT_IS_LIST：上游图像列表（list of tensor）按顺序展开。
        items = []
        for key, val in kwargs.items():
            m = re.fullmatch(r"image_(\d+)", str(key))
            if m and val is not None:
                items.append((int(m.group(1)), val))
        items.sort(key=lambda x: x[0])

        images = []
        for port_no, val in items:
            sub_items = val if isinstance(val, (list, tuple)) else [val]
            if len(sub_items) == 0:
                # 空图像列表（连接了但实际 0 张）：直接跳过，继续合并后续输入
                print(f"[yanhuo] 图像批次合并：image_{port_no} 输入为空（0 张图像），已跳过，继续合并后续输入。")
                continue
            for v in sub_items:
                if v is None:
                    continue
                if not isinstance(v, torch.Tensor) or v.ndim != 4:
                    print(f"[yanhuo] 图像批次合并：image_{port_no} 含无效图像数据，已跳过。")
                    continue
                if v.shape[0] == 0:
                    print(f"[yanhuo] 图像批次合并：image_{port_no} 含空 batch，已跳过。")
                    continue
                if 跳过黑色占位图 and self._is_placeholder_black(v):
                    print(f"[yanhuo] 图像批次合并：image_{port_no} 含 64×64 全黑兜底图，视为空输入，已跳过。")
                    continue
                images.append(v)

        if len(images) == 0:
            # 全部为空：输出 64×64 黑图兜底，不抛异常中断执行
            print("[yanhuo] 图像批次合并：所有输入均为空，输出 1 张 64×64 黑图兜底。")
            return ([torch.zeros((1, 64, 64, 3), dtype=torch.float32)],)
        if len(images) == 1:
            return ([images[0]],)

        # 2) 按原像素（图像列表）：不缩放、不填充，逐张输出，允许尺寸各不相同
        if 尺寸处理 == "按原像素（图像列表）":
            out = []
            for img in images:
                for i in range(img.shape[0]):
                    out.append(img[i:i + 1])
            return (out,)

        # 3) 通道数不一致：以第 1 路为准，多的通道裁掉、少的用 1.0 补齐（不报错）
        first_c = images[0].shape[-1]
        normalized = []
        for idx, img in enumerate(images):
            c = img.shape[-1]
            if c == first_c:
                normalized.append(img)
            elif c > first_c:
                print(f"[yanhuo] 图像批次合并：第{idx + 1}路通道数 {c} → 裁切到 {first_c}。")
                normalized.append(img[..., :first_c])
            else:
                print(f"[yanhuo] 图像批次合并：第{idx + 1}路通道数 {c} → 补到 {first_c}。")
                pad = torch.ones((*img.shape[:-1], first_c - c), dtype=img.dtype, device=img.device)
                normalized.append(torch.cat([img, pad], dim=-1))
        images = normalized

        # 4) 按模式决定目标尺寸并执行对齐
        first_tail = tuple(images[0].shape[1:])
        if 尺寸处理 == "严格":
            for idx, img in enumerate(images):
                tail = tuple(img.shape[1:])
                if tail != first_tail:
                    raise ValueError(
                        f"图像分辨率不一致，无法合并！\n"
                        f"  第1路：H,W,C = {first_tail}\n"
                        f"  第{idx + 1}路：H,W,C = {tail}\n"
                        f"提示：『尺寸处理』选『缩放到第一张』/『缩放到最大』/『填充到最大』/『按原像素（图像列表）』即可不报错。"
                    )
        elif all(tuple(img.shape[1:]) == first_tail for img in images):
            pass  # 尺寸已一致，无需处理
        else:
            if 尺寸处理 == "缩放到最大":
                target_h = max(img.shape[1] for img in images)
                target_w = max(img.shape[2] for img in images)
                align = lambda img: self._resize_to(img, target_h, target_w)
            elif 尺寸处理 == "中心缩放裁切到最大":
                target_h = max(img.shape[1] for img in images)
                target_w = max(img.shape[2] for img in images)
                align = lambda img: self._cover_crop_to(img, target_h, target_w)
            elif 尺寸处理 == "填充到最大":
                target_h = max(img.shape[1] for img in images)
                target_w = max(img.shape[2] for img in images)
                align = lambda img: self._pad_to(img, target_h, target_w)
            else:  # 缩放到第一张（默认）
                target_h = images[0].shape[1]
                target_w = images[0].shape[2]
                align = lambda img: self._resize_to(img, target_h, target_w)

            aligned = []
            for idx, img in enumerate(images):
                if img.shape[1] == target_h and img.shape[2] == target_w:
                    aligned.append(img)
                    continue
                print(
                    f"[yanhuo] 图像批次合并：第{idx + 1}路 {tuple(img.shape[1:3])} → "
                    f"({target_h}, {target_w})（{尺寸处理}）"
                )
                aligned.append(align(img))
            images = aligned

        # 5) 沿 batch 维拼接（保持端口顺序）；输出为单元素图像列表，对下游普通 IMAGE 输入无感
        try:
            concatenated = torch.cat(images, dim=0)
        except Exception as e:
            raise RuntimeError(f"图像批次合并失败。错误详情: {e}")

        return ([concatenated],)


class YanhuoFormatConvert:
    """格式转换：接受任意类型输入，转换为 string / int / float / boolean 输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "*": (AnyType("*"), {
                    "tooltip": "接受任何类型的输入。"
                }),
                "格式类型": (["string", "int", "float", "boolean"], {
                    "default": "string",
                    "tooltip": "选择要将输入转换成的目标类型。"
                }),
            }
        }

    RETURN_TYPES = (AnyType("*"),)
    RETURN_NAMES = ("输出",)
    FUNCTION = "convert_any"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = True
    DESCRIPTION = "格式转换：把任意输入转换为 string / int / float / boolean。"

    def convert_any(self, **kwargs):
        anything = kwargs['*']
        output_type = kwargs['格式类型']
        if output_type == 'string':
            result = str(anything)
        elif output_type == 'int':
            result = int(anything)
        elif output_type == 'float':
            result = float(anything)
        elif output_type == 'boolean':
            result = bool(anything)
        else:
            result = anything
        return (result,)


class YanhuoImageFilter:
    """筛选图像：按索引从批量图像中筛选一张或多张，顺序保持。"""

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("筛选图像",)
    OUTPUT_TOOLTIPS = ("按指定索引从批量图像中筛选出的帧（顺序保持）。",)
    FUNCTION = "indexedimagesfrombatch"
    CATEGORY = "yanhuo"
    DESCRIPTION = "从批量中筛选一张或者多张图像。用逗号分隔索引（从 0 起），支持多行；无效索引会被自动忽略，全无效时回退到第 0 张。"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE", {"display_name": "输入图像", "tooltip": "要筛选的图像批次（batch）"}),
                "indexes": ("STRING", {"default": "0, 1, 2", "multiline": True, "display_name": "索引列表", "tooltip": "逗号分隔的索引（从 0 起），如 0,2,5；也支持多行。超出范围的索引会被忽略。"}),
            },
        }

    def indexedimagesfrombatch(self, images, indexes):
        batch_size = images.shape[0] if images is not None and images.ndim >= 1 else 0

        valid_indices = []
        if batch_size > 0:
            for token in indexes.split(','):
                token = token.strip()
                if not token:
                    continue
                try:
                    idx = int(token)
                except ValueError:
                    continue
                if 0 <= idx < batch_size:
                    valid_indices.append(idx)

        if valid_indices:
            indices_tensor = torch.tensor(valid_indices, dtype=torch.long)
            chosen_images = images[indices_tensor]
        else:
            chosen_images = torch.zeros((1, 64, 64, 3), dtype=torch.float32)

        return (chosen_images,)


class YanhuoListNumber:
    """列表编号：对多行文本逐行编号，支持前缀/后缀/起始编号，可输出列表或合并文本。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {
                    "multiline": True,
                    "placeholder": "输入需要编号的文本，每行一组...",
                    "tooltip": "输入待编号的文本列表。每行作为一组，从第一组到最后一组依次编号。"
                }),
                "起始编号": ("INT", {
                    "default": 1,
                    "min": 0,
                    "step": 1,
                    "tooltip": "编号起始值，从该数字开始递增编号。"
                }),
                "编号前缀": ("STRING", {
                    "default": "",
                    "placeholder": "编号前添加的文本，如\"第\"",
                    "tooltip": "每个编号前添加的自定义文本前缀。"
                }),
                "编号后缀": ("STRING", {
                    "default": "",
                    "placeholder": "编号后添加的文本，如\"项\"",
                    "tooltip": "每个编号后添加的自定义文本后缀。"
                }),
                "输出模式": (["列表", "合并文本"], {
                    "default": "列表",
                    "tooltip": "● 列表：输出为包含所有编号文本的字符串列表。\n● 合并文本：将所有带编号的文本合并成一个字符串。"
                }),
                "合并间隔符": ("STRING", {
                    "default": "\\n",
                    "placeholder": "合并文本的分隔符，如\\n",
                    "tooltip": "仅在输出模式为\"合并文本\"时生效，用于分隔各条带编号的文本。"
                }),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("输出", "接续编号")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "number_list"
    CATEGORY = "yanhuo"
    DESCRIPTION = "列表编号：每行一组依次编号，输出编号后的列表或合并文本，并提供接续编号供多个节点串联。"

    def number_list(self, 文本, 起始编号, 编号前缀, 编号后缀, 输出模式, 合并间隔符):
        if not 文本 or not 文本.strip():
            # OUTPUT_IS_LIST=True 必须返回长度 ≥1 的列表，否则空列表会中断下游执行；统一返回 [""] 保链路不断
            return ([""], 起始编号)

        lines = [line for line in 文本.split('\n') if line.strip()]
        count = len(lines)
        next_num = 起始编号 + count

        results = []
        for i, line in enumerate(lines):
            num = 起始编号 + i
            numbered = f"{编号前缀}{num}{编号后缀}{line}"
            results.append(numbered)

        if 输出模式 == "合并文本":
            separator = 合并间隔符.replace("\\n", "\n")
            merged = separator.join(results)
            return ([merged], next_num)

        return (results, next_num)


class YanhuoTextReplace:
    """文本批量替换：按行配对查找/替换文本，支持台词保护（引号对内不替换）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "placeholder": "输入需要替换的文本...",
                    "tooltip": "输入要进行替换操作的原始文本。"
                }),
                "查找文本": ("STRING", {
                    "multiline": True,
                    "placeholder": "每行一个要查找的文本...",
                    "tooltip": "要查找的文本列表，每行对应一组。\n第1行对应替换文本第1行，第2行对应替换文本第2行，以此类推。"
                }),
                "替换文本": ("STRING", {
                    "multiline": True,
                    "placeholder": "每行一个要替换的文本...",
                    "tooltip": "要替换的文本列表，每行对应一组。\n第1行对应查找文本第1行，第2行对应查找文本第2行，以此类推。"
                }),
                "台词开关": ("BOOLEAN", {
                    "default": False,
                    "label_on": "保护台词",
                    "label_off": "正常替换",
                    "display_name": "台词保护",
                    "tooltip": "【台词保护】\n开启后，被以下引号包裹的「人物说话内容」不进行替换，原文保留：\n"
                               "● 半角双引号 / 单引号：\"...\"  '...'\n"
                               "● 中文弯引号：“...”  ‘...’\n"
                               "● 中文直角引号：「...」 『...』\n"
                               "关闭时，整段文本正常执行批量替换。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "replace_text"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = True
    DESCRIPTION = "文本批量替换：每行一组查找/替换配对，最长匹配优先；台词保护开启时引号对内的内容不替换。"

    @staticmethod
    def _replace_with_protect(text, find_str, replace_str, mask):
        """仅在 mask[i]==False 的位置允许替换 find_str -> replace_str；find_str 任一字符被保护则整段跳过。"""
        if not find_str:
            return text
        m = len(find_str)
        n = len(text)
        if m == 0 or m > n:
            return text
        out = []
        i = 0
        while i <= n - m:
            # 先快速判断窗口内是否存在任何被保护字符；无则再做字符串全等比较（避免含中文大窗口时重复切片）
            window_protected = False
            for k in range(m):
                if mask[i + k]:
                    window_protected = True
                    break
            if not window_protected and text[i:i + m] == find_str:
                out.append(replace_str)
                i += m
                continue
            out.append(text[i])
            i += 1
        # 末尾剩余字符
        while i < n:
            out.append(text[i])
            i += 1
        return "".join(out)

    def replace_text(self, text, 查找文本, 替换文本, 台词开关):
        find_lines = 查找文本.split("\n")
        replace_lines = 替换文本.split("\n")

        # 台词开关：开启时逐轮以当前文本重建保护掩码进行保护替换
        protect = bool(台词开关)

        # 配对查找/替换，过滤空查找串
        pairs = []
        count = min(len(find_lines), len(replace_lines))
        for i in range(count):
            find_str = find_lines[i]
            replace_str = replace_lines[i] if i < len(replace_lines) else ""
            if find_str:
                pairs.append((find_str, replace_str))

        # 按查找文本长度降序排序（最长匹配优先，避免短名误替换长名中的子串）
        pairs.sort(key=lambda x: -len(x[0]))

        result = text
        for find_str, replace_str in pairs:
            if protect:
                result = YanhuoTextReplace._replace_with_protect(result, find_str, replace_str,
                                                                 _build_quote_protect_mask(result))
            else:
                result = result.replace(find_str, replace_str)

        return (result,)


class YanhuoTextSortVerify:
    """文本排序验证：按验证对象在文本中的首次出现位置排序输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "placeholder": "输入需要排序的文本...",
                    "tooltip": "输入要检查的原始文本。"
                }),
                "验证对象": ("STRING", {
                    "multiline": True,
                    "placeholder": "每行一个验证对象...",
                    "tooltip": "需要验证的对象列表，每行一个。"
                }),
                "分隔符": ("STRING", {
                    "multiline": False,
                    "default": ",",
                    "placeholder": "排序输出的分隔符...",
                    "tooltip": "输出排序结果时使用的分隔符。"
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "appearance_order"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = True
    DESCRIPTION = "文本排序验证：按每个验证对象在文本中首次出现的位置先后排序，以分隔符拼接输出；未出现的对象被跳过。"

    def appearance_order(self, text, 验证对象, 分隔符):
        # 按行解析验证对象，去空白、去空行、去重（保持首次出现顺序）
        targets = []
        seen = set()
        for line in 验证对象.split("\n"):
            name = line.strip()
            if name and name not in seen:
                targets.append(name)
                seen.add(name)

        if not targets or not text:
            return ("",)

        # 记录每个对象在文本中第一次出现的位置；未出现则跳过
        found = []  # (first_pos, name)
        for name in targets:
            pos = text.find(name)
            if pos >= 0:
                found.append((pos, name))

        # 按首次出现位置升序排序，输出对象名称（不重复）
        found.sort(key=lambda x: x[0])
        result = 分隔符.join(name for _, name in found)

        return (result,)


class YanhuoTextProcess:
    """文本处理：多端口文本拼接后按多种方式分段，支持段落选取与动态输入/输出端口。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "placeholder": "输入需要分割的文本...",
                    "tooltip": "基础文本输入框。\n如果您使用[输入端口]功能连接了其他节点，此处的文本将作为第1部分，其他端口(any_xx)的内容会按顺序拼接在其后。"
                }),
                "输出模式": ("BOOLEAN", {
                    "default": False,
                    "label_on": "输出分段列表",
                    "label_off": "输出原始文本",
                    "tooltip": "控制端口输出的内容：\n● 输出原始文本（执行分段方式、段落优化、选取段落等所有处理规则，最终合并为一段文本输出）。\n● 输出分段列表（输出分割处理后的内容，按分段方式进行分割，以列表形式输出）。"
                }),
                "段落优化": ("BOOLEAN", {
                    "default": True,
                    "label_on": "去除首尾空格",
                    "label_off": "保留原始空格",
                    "tooltip": "优化文本空格\n● 去除首尾空格（自动删除首尾空格、换行符。无论输出原文还是分段均有效）。\n● 保留原始空格（完全保留原始文本的格式和缩进）。"
                }),
                "分段方式": (["端口", "空行", "序号", "段落", "标题", "数字", "地址", "手动"], {
                    "default": "空行",
                    "tooltip": "【核心分割逻辑】\n● 端口：严格按输入端口(any_x)分割。\n● 空行：识别双换行符。\n● 序号：识别 1. / (1) / A. 等列表标记。\n● 段落：每一行算一段。\n● 标题：智能识别章节标题。\n● 数字：仅提取纯数字。\n● 地址：智能从乱码、列表、对象字符串中提取 Windows 文件路径 (如 D:\\Data\\img.png)，并自动清洗格式。\n● 手动：识别 ||| 分隔符进行自定义分割。"
                }),
                "输出段落": ("INT", {
                    "default": 0,
                    "min": 0,
                    "step": 1,
                    "display": "number",
                    "tooltip": "【动态扩展输出】\n设置节点右侧[段落x]输出端口的数量。\n例如设为 3，右侧会出现 段落1, 段落2, 段落3。\n(需点击节点上的「更新端口」按钮生效)"
                }),
                "输入端口": ("INT", {
                    "default": 1,
                    "min": 1,
                    "step": 1,
                    "display": "number",
                    "tooltip": "【动态扩展输入】\n设置节点左侧[any_x]输入端口的数量。\n用于将多个文本源（如多个加载文本节点）按顺序拼合在一起进行统一分段处理。\n(注意：修改数值后需点击节点上的「更新端口」按钮生效)"}),
                "选取段落": ("STRING", {
                    "default": "-1",
                    "placeholder": "输入要选取的段落，用逗号分隔，如0,2,4；填 -1 输出所有；留空总段输出为空",
                    "tooltip": "【分割后段落选取】\n决定选取哪些段落输出。\n● -1（默认）：输出所有段落。\n● 留空：不选取任何段落，总段输出为空。\n● 0 为第一段、1 为第二段，以此类推。\n● 输入 0,2,4：输出第1、3、5段，丢弃其他。\n此设置会改变[总段]和[段落x]端口的内容。"
                }),
            },
            "optional": {
                **{f"any_{i}": (AnyType("*"),) for i in range(1, 65)}
            }
        }

    MAX_OUTPUTS = 100
    RETURN_TYPES = ("INT", "STRING") + ("STRING",) * MAX_OUTPUTS
    RETURN_NAMES = ("数:", "总段:") + tuple(f"段落{i + 1}" for i in range(MAX_OUTPUTS))
    OUTPUT_IS_LIST = (False, True) + (False,) * MAX_OUTPUTS
    FUNCTION = "split_paragraphs"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = True
    DESCRIPTION = "文本处理：将基础文本与多个输入端口内容按顺序拼合，按空行/序号/段落/标题等方式分段，支持段落选取，可输出原始文本或分段列表。"

    def is_title_content(self, processed_line, 段落优化):
        line_stripped = processed_line.strip() if 段落优化 else processed_line
        if not line_stripped: return False
        if len(line_stripped) > 20: return False
        last_char = line_stripped[-1] if line_stripped else ''
        forbidden_punctuation = (
            ',', '，', '.', '。', '!', '！', '?', '？', ';', '；',
            '"', "'", '（', '）', '、', '…', '—')
        if last_char in forbidden_punctuation: return False
        bracket_patterns = [r'^【.+】$', r'^《.+》$', r'^<.+>$']
        for pattern in bracket_patterns:
            if re.match(pattern, line_stripped): return True
        num_title_pattern = r'^(?:[一二三四五六七八九十百千万]+、|\d+\. |[a-zA-Z]+\. )'
        if re.match(num_title_pattern, line_stripped): return True
        if last_char in (':', '：'): return len(line_stripped) > 1
        if not re.search(r'[^\u4e00-\u9fa5a-zA-Z0-9]', last_char): return True
        return False

    def _convert_to_str(self, val):
        """把任意 ComfyUI 输入统一转成纯字符串：None→""、容器逐元素换行拼接、bytes 先 utf-8 再 latin-1 解码、其余直接 str()（异常返回 ""）。"""
        if val is None:
            return ""
        if isinstance(val, bool):
            # bool 是 int 的子类，需要先判断
            return str(val)
        if isinstance(val, (int, float, str)):
            return str(val)
        if isinstance(val, bytes):
            try:
                return val.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    return val.decode("latin-1")
                except Exception:
                    return ""
        if isinstance(val, (list, tuple, set, frozenset)):
            parts = []
            for x in val:
                if x is None:
                    continue
                try:
                    s = str(x)
                except Exception:
                    continue
                if s:
                    parts.append(s)
            return "\n".join(parts)
        if isinstance(val, dict):
            try:
                return str(val)
            except Exception:
                return ""
        try:
            return str(val)
        except Exception:
            return ""

    def split_paragraphs(self, text, 分段方式, 段落优化, 输出模式, 输出段落, 选取段落, 输入端口,
                         **kwargs):
        input_count = 输入端口
        collected_texts = []
        for i in range(1, input_count + 1):
            key = f"any_{i}"
            val = kwargs.get(key, None)
            if val is not None:
                val_str = self._convert_to_str(val)
                if val_str.strip():
                    collected_texts.append(val_str)
        if collected_texts:
            if input_count >= 2:
                text = "\n\n\n".join(collected_texts)
            else:
                text = collected_texts[0]
        if not text:
            return (0, "",) + ("",) * self.MAX_OUTPUTS

        if 分段方式 == "端口":
            if collected_texts:
                # 端口模式下每个 any_x 端口对应一个段落位置：即使端口为空也保留占位，
                # 保证选取段落索引与端口序号一一对应（如 any2 未接入时索引1应输出空文本）
                paras = []
                for i in range(1, input_count + 1):
                    val = kwargs.get(f"any_{i}", None)
                    if val is None:
                        paras.append("")
                    else:
                        s = self._convert_to_str(val)
                        paras.append(s.strip() if 段落优化 else s)
            else:
                paras = [text.strip() if 段落优化 else text] if text else []
        elif 分段方式 == "空行":
            lines, paras, curr_para = text.split('\n'), [], []
            for line in lines:
                pl = line.strip() if 段落优化 else line
                if not pl:
                    if curr_para:
                        paras.append(' '.join(curr_para) if 段落优化 else '\n'.join(curr_para))
                        curr_para = []
                else:
                    curr_para.append(pl)
            if curr_para: paras.append(' '.join(curr_para) if 段落优化 else '\n'.join(curr_para))
        elif 分段方式 == "序号":
            lines = text.split('\n')
            paras, current_para = [], []
            p_standalone = r'(?:【\d+】|\*?[\u2460-\u24FF]|\*?[\u3200-\u32FF]|[•▪*])'
            p_counters = r'(?:\d+|[IVXLCDMivxlcdm]+|[A-Za-z]|[一二三四五六七八九十百千万]+|[壹贰叁肆伍陆柒捌玖拾]+)'
            p_seps = r'(?:[,，、.·:：\-\*•▪])'
            pattern = r'^\s*(?:' + p_standalone + r'|' + p_counters + p_seps + r')'
            for line in lines:
                processed_line = line.strip() if 段落优化 else line
                if re.match(pattern, processed_line):
                    if current_para:
                        paras.append(' '.join(current_para) if 段落优化 else '\n'.join(current_para))
                        current_para = []
                    current_para.append(processed_line)
                else:
                    if current_para or processed_line.strip(): current_para.append(processed_line)
            if current_para: paras.append(' '.join(current_para) if 段落优化 else '\n'.join(current_para))
        elif 分段方式 == "段落":
            lines = text.split('\n')
            paras = []
            for line in lines:
                pl = line.strip() if 段落优化 else line
                if pl: paras.append(pl)
        elif 分段方式 == "标题":
            lines = text.split('\n')
            paras = []
            current_para = []
            line_info = []
            for line in lines:
                processed = line.strip() if 段落优化 else line
                is_blank = not processed.strip() if 段落优化 else not processed
                is_title = self.is_title_content(processed, 段落优化) and not is_blank
                line_info.append({'content': processed, 'is_blank': is_blank, 'is_title': is_title})
            n = len(line_info)
            i = 0
            while i < n and not line_info[i]['is_title'] and not line_info[i]['is_blank']:
                current_para.append(line_info[i]['content'])
                i += 1
            while i < n:
                while i < n and line_info[i]['is_blank']: i += 1
                if i >= n: break
                if line_info[i]['is_title']:
                    if current_para:
                        paras.append(' '.join(current_para) if 段落优化 else '\n'.join(current_para))
                        current_para = []
                    title_block = []
                    while i < n:
                        curr_info = line_info[i]
                        if curr_info['is_blank']:
                            i += 1
                            continue
                        if curr_info['is_title']:
                            title_block.append(curr_info['content'])
                            i += 1
                        else:
                            break
                    current_para.extend(title_block)
                    while i < n and not line_info[i]['is_title']:
                        if not line_info[i]['is_blank']: current_para.append(line_info[i]['content'])
                        i += 1
                else:
                    current_para.append(line_info[i]['content'])
                    i += 1
            if current_para: paras.append(' '.join(current_para) if 段落优化 else '\n'.join(current_para))
        elif 分段方式 == "数字":
            pattern = r'[ \t]*\d+(?:\.\d+)?[ \t]*'
            matches = re.findall(pattern, text)
            paras = []
            for m in matches:
                pl = m.strip() if 段落优化 else m
                if pl:
                    paras.append(pl)
        elif 分段方式 == "地址":
            pro_text = text.replace('\\\\', '\\')
            pattern = r'([a-zA-Z]:[\\/][^"\'<>,;\[\]\n\r]+)'
            matches = re.findall(pattern, pro_text)
            paras = []
            for m in matches:
                clean_path = m.strip()
                if " object" in clean_path:
                    clean_path = clean_path.split(" object")[0].strip()
                clean_path = clean_path.rstrip('.')
                if clean_path and len(clean_path) > 3:
                    paras.append(clean_path)
        elif 分段方式 == "手动":
            raw_paras = text.split('|||')
            paras = []
            for m in raw_paras:
                pl = m.strip() if 段落优化 else m
                if pl:
                    paras.append(pl)

        sel = 选取段落.strip() if 选取段落 is not None else ""
        selected_indices = []  # 被选取段落的原始索引（段落x端口按原始索引一一对应）
        if sel == "-1":
            # -1：输出所有段落（默认行为）
            to = paras.copy()
            selected_indices = list(range(len(paras)))
        elif sel == "":
            # 留空：总段输出为空（不选取任何段落）
            to = []
        else:
            # 数字索引组合：按 0/1/2... 索引选取，支持 。,，./\ 等分隔
            to = []
            si = re.split(r'[。,，./\\]', sel)
            for i in si:
                try:
                    idx = int(i.strip())
                    if 0 <= idx < len(paras):
                        to.append(paras[idx])
                        selected_indices.append(idx)
                except:
                    continue

        if not 输出模式:
            to = ["\n".join(to)] if to else [""]

        cnt = len(to)

        max_out = self.MAX_OUTPUTS
        po = [""] * max_out
        if 输出模式:
            # 分段列表模式：段落x端口按原始段落索引一一对应（选取段落=0→段落1、=1→段落2...，支持索引多端口）
            for idx in selected_indices:
                if idx < 输出段落:
                    po[idx] = paras[idx]
        else:
            # 原始文本模式：保持原行为，总段文本落到段落1端口
            for i in range(min(max_out, len(to), 输出段落)):
                po[i] = to[i]

        return (cnt, to,) + tuple(po)


def _default_track_name(index):
    """生成默认滑轨名称：0→批量图像A, 1→批量图像B, 25→批量图像Z, 26→批量图像AA..."""
    name = ""
    n = index
    do = True
    while do or n >= 0:
        name = chr(65 + (n % 26)) + name
        n = n // 26 - 1
        do = False
    return "批量图像" + name


class YanhuoMultiImage:
    """加载批量图像节点（多滑轨版）：tracks_data 维护多个滑轨，每滑轨独立加载并输出一路 IMAGE batch。"""

    MAX_TRACKS = 20

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "tracks_data": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "滑轨数据",
                    "tooltip": "JSON 格式滑轨数据，由前端自动维护。格式：[{\"name\":\"批量图像A\",\"paths\":[\"img1.png\"]}]",
                }),
            },
        }

    # 20 路输出，每路对应一个滑轨
    RETURN_TYPES = ("IMAGE",) * MAX_TRACKS
    RETURN_NAMES = tuple(_default_track_name(i) for i in range(MAX_TRACKS))
    OUTPUT_TOOLTIPS = tuple(f"滑轨 {i+1} 的合并 batch。" for i in range(MAX_TRACKS))
    FUNCTION = "load_images"
    CATEGORY = "yanhuo"
    DESCRIPTION = (
        "加载批量图像（多滑轨版）：支持最多 20 个独立滑轨，每个滑轨单独上传/拖入/粘贴批量图像。"
        "使用 lanczos 插值将宽高向上取整到 16 的倍数；同滑轨内尺寸不一致时以第一张为基准中心裁切。"
        "每路输出对应一个滑轨的合并 batch。"
    )

    def resize_image(self, image, multiple_of=16):
        """将图像宽高向上取整到 multiple_of 的倍数，使用 lanczos 插值缩放。"""
        _, oh, ow, _ = image.shape

        if multiple_of > 1:
            new_w = ((ow + multiple_of - 1) // multiple_of) * multiple_of
            new_h = ((oh + multiple_of - 1) // multiple_of) * multiple_of
        else:
            new_w = ow
            new_h = oh

        if new_w == ow and new_h == oh:
            return torch.clamp(image, 0, 1)

        outputs = image.permute(0, 3, 1, 2)
        outputs = comfy.utils.lanczos(outputs, new_w, new_h)
        outputs = outputs.permute(0, 2, 3, 1)
        outputs = torch.clamp(outputs, 0, 1)
        return outputs

    def _load_track_images(self, paths):
        """加载单个滑轨的所有图像，返回合并后的 batch 张量。"""
        track_images = []

        for path in paths:
            path = path.strip() if isinstance(path, str) else ""
            if not path:
                continue
            try:
                full_path = self._resolve_image_path(path)
                if not os.path.exists(full_path):
                    continue

                image = Image.open(full_path)
                image = ImageOps.exif_transpose(image)
                image = image.convert("RGB")

                image_np = np.array(image).astype(np.float32) / 255.0
                image_tensor = torch.from_numpy(image_np)[None,]
                image_tensor = self.resize_image(image_tensor, 16)
                track_images.append(image_tensor)
            except Exception:
                pass

        if len(track_images) == 0:
            return torch.zeros((1, 64, 64, 3))

        # 检查所有图像尺寸是否一致
        first_shape = track_images[0].shape
        if all(t.shape == first_shape for t in track_images):
            return torch.cat(track_images, dim=0)

        # 尺寸不一致：以第一张尺寸为基准，对后续图像做中心裁切（防止失真）
        _, fh, fw, _ = first_shape
        normalized = [track_images[0]]
        for t in track_images[1:]:
            if t.shape != first_shape:
                t = self._center_crop(t, fw, fh)
            normalized.append(t)
        return torch.cat(normalized, dim=0)

    def _center_crop(self, image, target_w, target_h):
        """中心裁切到指定尺寸。图像小于目标尺寸时先按比例放大再裁切。"""
        _, src_h, src_w, _ = image.shape

        # 尺寸完全一致直接返回
        if src_w == target_w and src_h == target_h:
            return image

        # 若图像小于目标尺寸，先等比放大到能覆盖目标（短边对齐）
        if src_w < target_w or src_h < target_h:
            scale = max(target_w / src_w, target_h / src_h)
            new_w = max(target_w, round(src_w * scale))
            new_h = max(target_h, round(src_h * scale))
            outputs = image.permute(0, 3, 1, 2)
            outputs = comfy.utils.lanczos(outputs, new_w, new_h)
            outputs = outputs.permute(0, 2, 3, 1)
            image = torch.clamp(outputs, 0, 1)
            _, src_h, src_w, _ = image.shape

        # 中心裁切
        x1 = (src_w - target_w) // 2
        y1 = (src_h - target_h) // 2
        return image[:, y1:y1 + target_h, x1:x1 + target_w, :]

    def load_images(self, tracks_data):
        """解析 tracks_data JSON，为每个滑轨加载图像并返回 20 路 IMAGE。"""
        try:
            tracks = json.loads(tracks_data) if tracks_data and tracks_data.strip() else []
        except (json.JSONDecodeError, TypeError):
            tracks = []

        results = []
        for i in range(self.MAX_TRACKS):
            if i < len(tracks):
                track = tracks[i] if isinstance(tracks[i], dict) else {}
                paths = track.get("paths", [])
                if isinstance(paths, str):
                    paths = [p.strip() for p in paths.split("\n") if p.strip()]
                results.append(self._load_track_images(paths))
            else:
                results.append(torch.zeros((1, 64, 64, 3)))

        return tuple(results)

    @staticmethod
    def _resolve_image_path(path):
        """解析图像路径，支持 output:/input:/temp: 前缀及绝对/相对路径。"""
        if not path:
            return path
        if path.startswith("output:"):
            return os.path.join(folder_paths.get_output_directory(), path[len("output:"):])
        if path.startswith("input:"):
            return os.path.join(folder_paths.get_input_directory(), path[len("input:"):])
        if path.startswith("temp:"):
            return os.path.join(folder_paths.get_temp_directory(), path[len("temp:"):])
        if os.path.isabs(path) and os.path.exists(path):
            return path
        return os.path.join(folder_paths.get_input_directory(), path)


def _default_audio_track_name(index):
    """生成默认音频轨道名：0→音频A, 1→音频B, 25→音频Z, 26→音频AA..."""
    name = ""
    n = index
    do = True
    while do or n >= 0:
        name = chr(65 + (n % 26)) + name
        n = n // 26 - 1
        do = False
    return "音频" + name


def _to_float_pcm(wav: torch.Tensor) -> torch.Tensor:
    """把 int16/int32 PCM 转成 float32。"""
    if wav.dtype.is_floating_point:
        return wav
    if wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    if wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"不支持的音频数据类型: {wav.dtype}")


class YanhuoMultiAudio:
    """
    加载批量音频节点（多轨道版）：一个节点里加载多段互不相同的音频。
    - 最多 20 条音轨，每条音轨可容纳多段音频（像加载批量图像的画廊一样），
      音轨输出为音频批次（AUDIO 列表，列表内每段音频独立，保持各自采样率）。
    - 音轨可重命名，右侧输出端口名跟随音轨名变化。
    - 前端支持点击选择、拖入、粘贴多个音频文件。
    - 空音轨输出 1 秒静音兜底，不报错、不中断执行。
    """

    MAX_TRACKS = 20

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "tracks_data": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "音轨数据",
                    "tooltip": "JSON 格式音轨数据，由前端自动维护。格式：[{\"name\":\"音频A\",\"paths\":[\"a.mp3\",\"b.wav\"]}]",
                }),
            },
        }

    RETURN_TYPES = ("AUDIO",) * MAX_TRACKS
    RETURN_NAMES = tuple(_default_audio_track_name(i) for i in range(MAX_TRACKS))
    OUTPUT_IS_LIST = (True,) * MAX_TRACKS
    OUTPUT_TOOLTIPS = tuple(f"音轨 {i + 1} 的音频批次（列表，每段音频独立）。" for i in range(MAX_TRACKS))
    FUNCTION = "load_audios"
    CATEGORY = "yanhuo"
    DESCRIPTION = (
        "加载批量音频：一个节点内加载多段不同音频，每条音轨可容纳多段音频，"
        "输出为音频批次（列表）。支持点击选择 / 拖入 / 粘贴多个音频文件，端口名跟随音轨名。"
    )

    @staticmethod
    def _resolve_audio_path(path):
        """解析音频路径，支持 output:/input:/temp: 前缀及绝对/相对路径。"""
        if not path:
            return path
        path = path.strip()
        if path.startswith("output:"):
            return os.path.join(folder_paths.get_output_directory(), path[len("output:"):])
        if path.startswith("input:"):
            return os.path.join(folder_paths.get_input_directory(), path[len("input:"):])
        if path.startswith("temp:"):
            return os.path.join(folder_paths.get_temp_directory(), path[len("temp:"):])
        if os.path.isabs(path) and os.path.exists(path):
            return path
        return os.path.join(folder_paths.get_input_directory(), path)

    @staticmethod
    def empty_audio(duration=1.0, sample_rate=44100, channels=1):
        """静音兜底音频。"""
        n = max(1, int(round(duration * sample_rate)))
        return {"waveform": torch.zeros((1, channels, n), dtype=torch.float32), "sample_rate": sample_rate}

    @classmethod
    def load_audio_file(cls, path):
        """用 pyav 加载单个音频文件，返回 {"waveform": [1,C,T], "sample_rate": sr}。"""
        if av is None:
            raise RuntimeError("未安装 av（pyav），无法加载音频文件。")
        full_path = cls._resolve_audio_path(path)
        if not os.path.exists(full_path):
            raise FileNotFoundError(f"音频文件不存在: {full_path}")

        with av.open(full_path) as af:
            if not af.streams.audio:
                raise ValueError("文件中没有音频流。")
            stream = af.streams.audio[0]
            sample_rate = stream.codec_context.sample_rate
            n_channels = stream.channels

            frames = []
            for frame in af.decode(streams=stream.index):
                buf = torch.from_numpy(frame.to_ndarray())
                if buf.shape[0] != n_channels:
                    buf = buf.view(-1, n_channels).t()
                frames.append(buf)

            if not frames:
                raise ValueError("未解码出任何音频帧。")

            wav = torch.cat(frames, dim=1)
            wav = _to_float_pcm(wav)

        return {"waveform": wav.unsqueeze(0), "sample_rate": sample_rate}

    def load_audios(self, tracks_data):
        try:
            tracks = json.loads(tracks_data) if tracks_data and tracks_data.strip() else []
        except (json.JSONDecodeError, TypeError):
            tracks = []

        results = []
        for i in range(self.MAX_TRACKS):
            paths = []
            name = _default_audio_track_name(i)
            if i < len(tracks) and isinstance(tracks[i], dict):
                track = tracks[i]
                name = track.get("name", "") or name
                raw = track.get("paths", None)
                if raw is None:
                    # 兼容旧版单文件格式 {"path": "..."}
                    raw = track.get("path", "")
                if isinstance(raw, str):
                    paths = [p.strip() for p in raw.split("\n") if p.strip()]
                elif isinstance(raw, (list, tuple)):
                    paths = [p.strip() for p in raw if isinstance(p, str) and p.strip()]

            if not paths:
                # 空音轨：1 秒静音兜底（保持链路，下游可用「跳过静音占位」过滤）
                results.append([self.empty_audio()])
                continue

            track_items = []
            for path in paths:
                try:
                    track_items.append(self.load_audio_file(path))
                except Exception as e:
                    print(f"[yanhuo] 加载批量音频：音轨「{name}」的 {path} 加载失败（{e}），已跳过。")
            if not track_items:
                results.append([self.empty_audio()])
            else:
                results.append(track_items)

        return tuple(results)


class YanhuoAudioBatchMulti:
    """
    音频批次合并节点：把多段音频打包为一个「音频批次」（AUDIO 列表）输出，
    与「图像批次合并」同理 —— 不是拼接成一段音频，而是多段音频各自独立成为一个批次。
    - 通过「输入数量」+「更新输入」按钮管理 audio_1..audio_N 输入端口（最多 50）。
    - 自动跳过空输入：未连接（None）、波形为空（0 采样）、以及纯静音占位音频。
    - 输入的 AUDIO 若本身是批次（waveform batch > 1），会按 batch 顺序逐条拆出。
    - 各段音频保持自己的采样率与声道数，不做重采样/拼接；采样率不一致时仅打印提示。
    - 输入端口也接受音频列表（INPUT_IS_LIST），上游列表会按顺序展开后再打包。
    """

    MAX_INPUTS = 50

    @classmethod
    def INPUT_TYPES(cls):
        optional_inputs = {f"audio_{i}": ("AUDIO",) for i in range(1, cls.MAX_INPUTS + 1)}
        return {
            "required": {
                "输入数量": ("INT", {"default": 3, "min": 2, "max": cls.MAX_INPUTS, "step": 1}),
                "跳过静音占位": ("BOOLEAN", {
                    "default": True,
                    "label_on": "跳过",
                    "label_off": "保留",
                    "tooltip": "上游节点无结果时常输出纯静音占位音频，开启时视为空输入跳过，不参与打包。",
                }),
            },
            "optional": optional_inputs,
            "INPUT_IS_LIST": {f"audio_{i}": True for i in range(1, cls.MAX_INPUTS + 1)},
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audios",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "batch"
    CATEGORY = "yanhuo"
    DESCRIPTION = (
        "音频批次合并：把多段音频打包为一个音频批次（列表）输出，各段音频互不拼接、独立保留。"
        "自动跳过空输入与静音占位；所有输入为空时输出 1 秒静音兜底，不报错。"
    )

    @staticmethod
    def _is_silent(item):
        """判断是否为纯静音占位音频。"""
        try:
            wav = item["waveform"]
            return bool(torch.all(torch.abs(wav) <= 1e-6))
        except Exception:
            return False

    def batch(self, 输入数量=3, 跳过静音占位=True, **kwargs):
        # INPUT_IS_LIST 模式下 widget 值也会被包成单元素列表，先取回标量
        跳过静音占位 = _unwrap_list_input(跳过静音占位)
        items = []
        for key, val in kwargs.items():
            m = re.fullmatch(r"audio_(\d+)", str(key))
            if m and val is not None:
                items.append((int(m.group(1)), val))
        items.sort(key=lambda x: x[0])

        audios = []
        for port_no, val in items:
            sub = val if isinstance(val, (list, tuple)) else [val]
            if len(sub) == 0:
                print(f"[yanhuo] 音频批次合并：audio_{port_no} 输入为空，已跳过，继续打包后续输入。")
                continue
            for v in sub:
                if v is None:
                    continue
                if not isinstance(v, dict) or "waveform" not in v or "sample_rate" not in v:
                    print(f"[yanhuo] 音频批次合并：audio_{port_no} 含无效音频数据，已跳过。")
                    continue
                wav = v["waveform"]
                sr = v["sample_rate"]
                if not isinstance(wav, torch.Tensor) or wav.ndim < 2 or wav.shape[0] == 0:
                    print(f"[yanhuo] 音频批次合并：audio_{port_no} 含空波形，已跳过。")
                    continue
                if wav.shape[-1] == 0:
                    print(f"[yanhuo] 音频批次合并：audio_{port_no} 含 0 采样音频，已跳过。")
                    continue
                # 把 multi-batch 波形逐条拆开，保证批次里每一项都是 [1,C,T]
                if wav.ndim == 2:
                    wav = wav.unsqueeze(0)
                for i in range(wav.shape[0]):
                    item = {"waveform": wav[i:i + 1], "sample_rate": sr}
                    if 跳过静音占位 and self._is_silent(item):
                        print(f"[yanhuo] 音频批次合并：audio_{port_no} 第{i + 1}段为纯静音占位，已跳过。")
                        continue
                    audios.append(item)

        if len(audios) == 0:
            print("[yanhuo] 音频批次合并：所有输入均为空，输出 1 段静音兜底。")
            return ([{"waveform": torch.zeros((1, 1, 44100), dtype=torch.float32), "sample_rate": 44100}],)

        # 采样率 / 声道不一致仅提示，不做重采样（批次中每段音频各自独立）
        rates = sorted({item["sample_rate"] for item in audios})
        if len(rates) > 1:
            print(f"[yanhuo] 音频批次合并：批次内采样率不一致 {rates}，各段保持原样不做重采样。")
        chans = sorted({item["waveform"].shape[1] for item in audios})
        if len(chans) > 1:
            print(f"[yanhuo] 音频批次合并：批次内声道数不一致 {chans}，各段保持原样。")

        return (audios,)


_OPUS_RATES = [8000, 12000, 16000, 24000, 48000]


def _unwrap_list_input(v):
    """ComfyUI 声明 INPUT_IS_LIST 后会把所有输入（包括 widget 下拉框/开关值）包成单元素列表，取回标量。"""
    if isinstance(v, (list, tuple)):
        return v[0] if len(v) > 0 else None
    return v


def _encode_audio_to_bytes(wav, sample_rate, fmt="flac", quality="192k"):
    """把 [C,T] float 波形编码为 flac/mp3/opus 字节流（编码方式与官方 SaveAudio 一致）。"""
    import io as _io
    if av is None:
        raise RuntimeError("未安装 av（pyav），无法编码音频。")

    sample_rate = int(sample_rate)

    # opus 只支持特定采样率
    if fmt == "opus":
        if sample_rate > 48000:
            sample_rate = 48000
        elif sample_rate not in _OPUS_RATES:
            for rate in sorted(_OPUS_RATES):
                if rate > sample_rate:
                    sample_rate = rate
                    break
            if sample_rate not in _OPUS_RATES:
                sample_rate = 48000

    layout = "mono" if wav.shape[0] == 1 else "stereo"
    output_buffer = _io.BytesIO()
    output_container = av.open(output_buffer, mode="w", format=fmt)

    if fmt == "opus":
        out_stream = output_container.add_stream("libopus", rate=sample_rate, layout=layout)
        if quality.endswith("k") and quality[:-1].isdigit():
            out_stream.bit_rate = int(quality[:-1]) * 1000
    elif fmt == "mp3":
        out_stream = output_container.add_stream("libmp3lame", rate=sample_rate, layout=layout)
        if quality == "V0":
            out_stream.codec_context.qscale = 1
        elif quality.endswith("k") and quality[:-1].isdigit():
            out_stream.bit_rate = int(quality[:-1]) * 1000
    else:  # flac
        out_stream = output_container.add_stream("flac", rate=sample_rate, layout=layout)

    frame = av.AudioFrame.from_ndarray(
        wav.movedim(0, 1).reshape(1, -1).float().numpy(),
        format="flt",
        layout=layout,
    )
    frame.sample_rate = sample_rate
    frame.pts = 0
    output_container.mux(out_stream.encode(frame))
    output_container.mux(out_stream.encode(None))
    output_container.close()

    output_buffer.seek(0)
    return output_buffer.getbuffer()


class YanhuoAudioBatchSave:
    """
    音频批次预览/保存节点：「音频批次合并」「加载批量音频」输出的接收端。
    - 接收音频批次（AUDIO 列表，可含多段不同音频），逐段预览和/或保存。
    - 预览：写入临时目录，在节点上直接逐段试听。
    - 保存：写入 output 目录（格式 flac/mp3/opus），文件名自动编号。
    - 音频原样透传，可继续串接下游节点。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audios": ("AUDIO", {"tooltip": "音频批次（列表），可包含多段不同的音频。"}),
                "输出模式": (["预览", "保存", "预览并保存"], {"default": "预览"}),
                "保存格式": (["flac", "mp3", "opus"], {"default": "flac"}),
                "音质": (["V0", "64k", "96k", "128k", "192k", "320k"], {"default": "192k"}),
                "文件名前缀": ("STRING", {"default": "audio/yanhuo"}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audios",)
    OUTPUT_IS_LIST = (True,)
    INPUT_IS_LIST = {"audios": True}
    FUNCTION = "save_preview"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "音频批次预览/保存：接收音频批次（多段音频），逐段预览试听和/或保存为 flac/mp3/opus 文件。"
    )

    def save_preview(self, audios, 输出模式="预览", 保存格式="flac", 音质="192k",
                     文件名前缀="audio/yanhuo"):
        # INPUT_IS_LIST 模式下 widget 值也会被包成单元素列表，先取回标量
        输出模式 = _unwrap_list_input(输出模式)
        保存格式 = _unwrap_list_input(保存格式)
        音质 = _unwrap_list_input(音质)
        文件名前缀 = _unwrap_list_input(文件名前缀)
        # 输入声明了 INPUT_IS_LIST：audios 一定是列表；兼容单个 dict 传入
        if isinstance(audios, dict):
            audios = [audios]
        audios = [a for a in (audios or []) if isinstance(a, dict) and "waveform" in a]

        ui_entries = []
        need_file = 输出模式 in ("保存", "预览并保存")
        need_preview = 输出模式 in ("预览", "预览并保存")

        # mp3 不支持 64k/96k/192k 这类码率时回退到 128k
        quality = 音质
        if 保存格式 == "mp3" and quality not in ("V0", "128k", "320k"):
            quality = "128k"
        if 保存格式 == "flac":
            quality = "192k"

        for item in audios:
            waveform = item["waveform"]
            sample_rate = item["sample_rate"]
            if not isinstance(waveform, torch.Tensor) or waveform.ndim < 2 or waveform.shape[-1] == 0:
                continue

            for batch_number, wav in enumerate(waveform.cpu()):
                data = _encode_audio_to_bytes(wav, sample_rate, 保存格式, quality)

                if need_file:
                    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                        文件名前缀, folder_paths.get_output_directory())
                    base = filename.replace("%batch_num%", str(batch_number))
                    file = f"{base}_{counter:05}.{保存格式}"
                    with open(os.path.join(full_output_folder, file), "wb") as f:
                        f.write(data)
                    if 输出模式 == "保存":
                        ui_entries.append({"filename": file, "subfolder": subfolder, "type": "output"})
                    else:
                        # 预览并保存：播放器直接读 output 里的文件
                        ui_entries.append({"filename": file, "subfolder": subfolder, "type": "output"})

                if need_preview:
                    temp_dir = folder_paths.get_temp_directory()
                    full_temp_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                        文件名前缀, temp_dir)
                    base = filename.replace("%batch_num%", str(batch_number))
                    file = f"{base}_{counter:05}.{保存格式}"
                    with open(os.path.join(full_temp_folder, file), "wb") as f:
                        f.write(data)
                    ui_entries.append({"filename": file, "subfolder": subfolder, "type": "temp"})

        if not ui_entries and len(audios) > 0:
            print("[yanhuo] 音频批次预览/保存：批次中没有有效音频。")

        return {"ui": {"audio": ui_entries}, "result": (audios,)}


class YanhuoAudioFilter:
    """
    筛选音频：按索引从音频批次（AUDIO 列表）中提取一段或多段，顺序保持。
    - 索引从 0 起，逗号分隔，支持多行（多行合并为一条序列）；
      输入 "5, 3, 0, 1" 表示依次提取第六、第四、第一、第二段。
    - 无效索引（越界 / 非数字）自动忽略；全无效时输出 1 秒静音兜底，不报错。
    - 输出为音频批次（列表），可直接接「音频批次预览/保存」或「音频批次合并」。
    """

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("筛选音频",)
    OUTPUT_IS_LIST = (True,)
    INPUT_IS_LIST = {"audios": True}
    FUNCTION = "filter_audios"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = False
    DESCRIPTION = (
        "从音频批次中筛选一段或多段音频，按索引顺序输出为新的音频批次。"
        "索引从 0 起，逗号分隔，支持多行；无效索引自动忽略，全无效时回退到第 0 段。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audios": ("AUDIO", {"display_name": "输入音频", "tooltip": "音频批次（列表），可来自音频批次合并或加载批量音频的某条轨道。"}),
                "indexes": ("STRING", {"default": "0, 1, 2", "multiline": True, "display_name": "索引列表", "tooltip": "逗号分隔的索引（从 0 起），按书写顺序提取对应音频段，如 5,3,0,1；也支持多行。超出范围的索引会被忽略。"}),
            },
        }

    @staticmethod
    def _parse_indexes(indexes, count):
        """解析索引字符串（支持中英文逗号/分号/空白/多行），返回范围内的有效索引列表（顺序保持）。"""
        valid = []
        for token in str(indexes or "").replace("，", ",").replace("、", ",").replace(";", ",").replace("；", ",").replace("\n", ",").replace(" ", ",").split(","):
            token = token.strip()
            if not token:
                continue
            try:
                idx = int(token)
            except ValueError:
                continue
            if 0 <= idx < count:
                valid.append(idx)
        return valid

    def filter_audios(self, audios, indexes):
        indexes = _unwrap_list_input(indexes)  # INPUT_IS_LIST 模式下 widget 值也是列表

        # 展开所有输入为独立的音频段（兼容单个 dict / 多 batch 波形）
        segments = []
        for a in (audios if isinstance(audios, (list, tuple)) else [audios]):
            if not isinstance(a, dict) or "waveform" not in a:
                continue
            wf, sr = a.get("waveform"), a.get("sample_rate")
            if not isinstance(wf, torch.Tensor) or wf.ndim < 2 or wf.shape[0] == 0:
                continue
            for i in range(wf.shape[0]):
                segments.append({"waveform": wf[i:i + 1], "sample_rate": sr})

        valid = self._parse_indexes(indexes, len(segments))
        if valid:
            chosen = [segments[i] for i in valid]
        elif segments:
            chosen = [segments[0]]  # 全无效：回退第 0 段
        else:
            chosen = [self._silent()]  # 输入为空：1 秒静音兜底
            print("[yanhuo] 筛选音频：输入音频批次为空，输出 1 秒静音兜底。")
        if not valid and segments:
            print("[yanhuo] 筛选音频：索引全部无效，回退输出第 0 段。")

        return (chosen,)

    @staticmethod
    def _silent(sr=44100):
        return {"waveform": torch.zeros((1, 1, sr)), "sample_rate": sr}


class YanhuoGroupIgnoreManager:
    """
    组忽略管理器（前端工具节点）

    节点本体不参与计算，只作为一个可持久化的面板载体。
    全部逻辑在前端 web/js/group_ignore_manager.js 中实现：
      - 列出工作流中的组，逐个开启 / 忽略（组内节点 mode 在 ALWAYS 与 BYPASS 间切换）
      - 自定义要管理的组、拖拽排序、按颜色筛选
      - 为每个组配置「组开启时 / 组关闭时」的联动规则
    配置数据以纯 JSON 存放在节点的 properties.yanhuoGroupIgnore 中。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "yanhuo"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "组忽略管理器：自由添加并管理图中的组，一键开启/忽略组，"
        "并可为每个组配置开启、关闭时的联动规则。纯前端工具节点，不参与计算。"
    )

    def noop(self):
        return {}


NODE_CLASS_MAPPINGS = {
    "YanhuoIntegerControl": YanhuoIntegerControl,
    "YanhuoAudioConcat": YanhuoAudioConcat,
    "YanhuoImageBatchMulti": YanhuoImageBatchMulti,
    "YanhuoFormatConvert": YanhuoFormatConvert,
    "YanhuoImageFilter": YanhuoImageFilter,
    "YanhuoListNumber": YanhuoListNumber,
    "YanhuoTextReplace": YanhuoTextReplace,
    "YanhuoTextSortVerify": YanhuoTextSortVerify,
    "YanhuoTextProcess": YanhuoTextProcess,
    "YanhuoMultiImage": YanhuoMultiImage,
    "YanhuoMultiAudio": YanhuoMultiAudio,
    "YanhuoAudioBatchMulti": YanhuoAudioBatchMulti,
    "YanhuoAudioBatchSave": YanhuoAudioBatchSave,
    "YanhuoAudioFilter": YanhuoAudioFilter,
    "YanhuoGroupIgnoreManager": YanhuoGroupIgnoreManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "YanhuoIntegerControl": "整数控制",
    "YanhuoAudioConcat": "音频拼接",
    "YanhuoImageBatchMulti": "图像批次合并",
    "YanhuoFormatConvert": "格式转换",
    "YanhuoImageFilter": "筛选图像",
    "YanhuoListNumber": "列表编号",
    "YanhuoTextReplace": "文本批量替换",
    "YanhuoTextSortVerify": "文本排序验证",
    "YanhuoTextProcess": "文本处理",
    "YanhuoMultiImage": "加载批量图像",
    "YanhuoMultiAudio": "加载批量音频",
    "YanhuoAudioBatchMulti": "音频批次合并",
    "YanhuoAudioBatchSave": "音频批次预览/保存",
    "YanhuoAudioFilter": "筛选音频",
    "YanhuoGroupIgnoreManager": "组忽略管理器",
}
