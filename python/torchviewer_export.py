#!/usr/bin/env python3
# TorchViewer 导出器：把 PyTorch 模型结构导出为 JSON，供 VSCode 扩展 webview 渲染
#
# 统一导出格式（kind=graph）：
# {
#   ok, kind, model, total_params, warning?,
#   inputs:  [{name, shape}],
#   outputs: [{name, shape}],
#   nodes:   [{id, name, kind, target, cls?, params?, out_shape?, dtype?, attrs?,
#              group?, group_cls?}],   # group = 所属模块容器路径（来自 nn_module_stack）
#   edges:   [{src, dst}],
#   tree:    {id, name, cls, params, children: [...]}   # 模块层级树
# }
import argparse
import importlib.util
import itertools
import json
import os
import re
import sys
import traceback

_ID = itertools.count()

# 界面语言：由扩展通过 --lang 传入（zh/en），错误与警告文案随之切换
_LANG = "en"


def T(en, zh):
    """按当前语言返回文案：T('English', '中文')"""
    return zh if _LANG.startswith("zh") else en


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def import_from_file(path):
    # 加载目标 .py 文件为模块
    # 提前布置搜索路径：脚本目录 → （相对导入时的）父目录 → 当前工作目录，
    # 确保脚本内 import 同目录模块/子包时能正常解析
    path = os.path.abspath(path)
    d = os.path.dirname(path)
    # 含相对导入（from .xxx import）时按包内模块加载：父目录加入 sys.path，
    # 模块名用 "目录名.文件名"，让相对导入能解析到同目录的兄弟模块
    try:
        with open(path, "r", encoding="utf-8") as f:
            has_relative = re.search(r"^\s*from\s+\.", f.read(), re.M) is not None
    except Exception:
        has_relative = False
    pkg = os.path.basename(d)
    stem = os.path.splitext(os.path.basename(path))[0]
    paths = [d]
    # 源码里 import 的顶层包名：d/<top> 已覆盖的不处理；顶层包实际位于 d 的父目录时补加父目录
    # （如脚本在 models/ 下却写 `from models.xxx import`，包根是 models 的父目录）
    try:
        with open(path, "r", encoding="utf-8") as f:
            src_head = f.read()
        tops = set(re.findall(r"^\s*(?:from|import)\s+(\w+)", src_head, re.M))
        parent = os.path.dirname(d)
        for top in tops:
            if top in ("torch", "os", "sys", "re", "json"):
                continue
            in_d = os.path.isdir(os.path.join(d, top)) or os.path.isfile(os.path.join(d, top + ".py"))
            in_parent = os.path.isdir(os.path.join(parent, top)) or os.path.isfile(os.path.join(parent, top + ".py"))
            if not in_d and in_parent and parent not in paths:
                paths.append(parent)
    except Exception:
        pass
    if has_relative and pkg.isidentifier() and stem.isidentifier():
        paths.append(os.path.dirname(d))
        name = f"{pkg}.{stem}"
    else:
        name = "torchviewer_target_" + str(abs(hash(path)) % 10 ** 8)
    cwd = os.getcwd()
    if cwd not in paths:
        paths.append(cwd)
    for p in paths:
        if p not in sys.path:
            sys.path.insert(0, p)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(T(f"Cannot load file: {path}", f"无法加载文件: {path}"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def find_module_classes(mod):
    # 找出该文件中定义的 nn.Module 子类
    import torch.nn as nn

    out = []
    for name in dir(mod):
        obj = getattr(mod, name)
        if isinstance(obj, type) and issubclass(obj, nn.Module) and obj.__module__ == mod.__name__:
            out.append(name)
    return sorted(out)


def class_params(cls):
    # 构造参数表（名称 / 是否必填 / 默认值 repr，Python 字面量可直接回填表单）
    # 注意：inspect.signature(类) 返回的参数已自动去掉 self，不能再 [1:] 跳第一个，
    # 否则会把首个真实参数（如 channels）误跳过
    import inspect

    try:
        sig = inspect.signature(cls)
    except (TypeError, ValueError):
        return []
    out = []
    plist = list(sig.parameters.values())
    # 防御：极少数情况下签名仍带 self/cls，按名跳过
    if plist and plist[0].name in ("self", "cls"):
        plist = plist[1:]
    for p in plist:
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        item = {"name": p.name, "required": p.default is p.empty}
        if p.default is not p.empty:
            try:
                item["default"] = repr(p.default)
            except Exception:
                pass
        if p.annotation is not p.empty:
            try:
                s = str(p.annotation)
                if s:
                    item["annotation"] = s
            except Exception:
                pass
        out.append(item)
    return out


def build_model(mod, cls_name, expr, args_json=""):
    # 字典方式实例化优先：--args 传 JSON 字典（表单 值为 Python 字面量字符串，逐个 ast.literal_eval 还原类型）
    # --build 仅作为自由表达式兜底
    import ast

    import torch.nn as nn

    cls = getattr(mod, cls_name)
    if args_json:
        try:
            raw = json.loads(args_json)
        except Exception as e:
            raise RuntimeError(T(f"--args is not valid JSON: {e}", f"--args 不是合法 JSON：{e}"))
        if not isinstance(raw, dict):
            raise RuntimeError(T("--args must be a JSON object (dict of arg name → value)", "--args 必须是 JSON 对象（参数名 → 值 的字典）"))
        kwargs = {}
        for k, v in raw.items():
            if isinstance(v, str):
                try:
                    kwargs[k] = ast.literal_eval(v)
                except Exception:
                    kwargs[k] = v
            else:
                kwargs[k] = v
        return cls(**kwargs)
    if expr:
        model = eval(expr, vars(mod))
        if not isinstance(model, nn.Module):
            raise RuntimeError(T(f"{expr} is not an nn.Module", f"{expr} 不是 nn.Module"))
        return model
    try:
        return cls()
    except TypeError as e:
        raise RuntimeError(
            T(
                f"Cannot instantiate {cls_name}() ({e}). Pass constructor args via --build \"Model(args...)\".",
                f"无法实例化 {cls_name}()（{e}）。可用 --build \"Model(args...)\" 传入构造参数。",
            )
        )


def count_params(m):
    try:
        return sum(p.numel() for p in m.parameters())
    except Exception:
        return 0


# ---------- 属性提取 ----------

_ATTR_PREFIXES = [
    ("Conv", ["in_channels", "out_channels", "kernel_size", "stride", "padding", "dilation", "groups", "bias", "padding_mode", "output_padding"]),
    ("Linear", ["in_features", "out_features", "bias"]),
    ("BatchNorm", ["num_features", "eps", "momentum", "affine", "track_running_stats"]),
    ("LayerNorm", ["normalized_shape", "eps", "elementwise_affine"]),
    ("GroupNorm", ["num_groups", "num_channels", "eps", "affine"]),
    ("InstanceNorm", ["num_features", "eps", "momentum", "affine", "track_running_stats"]),
    ("Embedding", ["num_embeddings", "embedding_dim", "padding_idx"]),
    ("RNN", ["input_size", "hidden_size", "num_layers", "bias", "batch_first", "dropout", "bidirectional"]),
    ("LSTM", ["input_size", "hidden_size", "num_layers", "bias", "batch_first", "dropout", "bidirectional"]),
    ("GRU", ["input_size", "hidden_size", "num_layers", "bias", "batch_first", "dropout", "bidirectional"]),
    ("Dropout", ["p", "inplace"]),
    ("MaxPool", ["kernel_size", "stride", "padding", "dilation", "ceil_mode"]),
    ("AvgPool", ["kernel_size", "stride", "padding", "ceil_mode", "count_include_pad"]),
    ("AdaptiveMaxPool", ["output_size"]),
    ("AdaptiveAvgPool", ["output_size"]),
    ("Upsample", ["size", "scale_factor", "mode", "align_corners"]),
    ("ZeroPad", ["padding"]),
    ("ConstantPad", ["padding", "value"]),
    ("ReflectionPad", ["padding"]),
    ("ReplicationPad", ["padding"]),
    ("Flatten", ["start_dim", "end_dim"]),
    ("Unfold", ["kernel_size", "stride", "padding", "dilation"]),
    ("Fold", ["output_size", "kernel_size", "stride", "padding", "dilation"]),
    ("MultiheadAttention", ["embed_dim", "num_heads", "dropout", "bias", "batch_first"]),
    ("TransformerEncoderLayer", ["d_model", "nhead", "dim_feedforward", "dropout", "activation"]),
    ("TransformerDecoderLayer", ["d_model", "nhead", "dim_feedforward", "dropout", "activation"]),
]


def _to_jsonable(v, depth=0):
    # 把属性值转成可 JSON 序列化的对象；未知对象返回 None（跳过）
    import torch

    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        if depth > 2:
            return str(v)[:80]
        return [_to_jsonable(x, depth + 1) for x in v]
    if isinstance(v, torch.dtype):
        return str(v).replace("torch.", "")
    if isinstance(v, torch.device):
        return str(v)
    if isinstance(v, torch.Tensor):
        return {"shape": list(v.shape), "dtype": str(v.dtype)}
    if isinstance(v, torch.nn.Module):
        return f"<{type(v).__name__}>"
    if depth > 0:
        return str(v)[:80]
    return None


def module_attrs(m):
    # 提取常见模块的关键属性；未知模块回退为 __dict__ 中的标量
    cls = type(m).__name__
    keys = None
    for prefix, ks in _ATTR_PREFIXES:
        if cls.startswith(prefix):
            keys = ks
            break
    attrs = {}
    if keys is not None:
        for k in keys:
            if hasattr(m, k):
                v = _to_jsonable(getattr(m, k))
                if v is not None:
                    attrs[k] = v
    else:
        for k, v in vars(m).items():
            if k.startswith("_") or callable(v):
                continue
            s = _to_jsonable(v)
            if s is not None:
                attrs[k] = s
            if len(attrs) >= 12:
                break
    return attrs


# ---------- 形状传播 ----------

def _node_shape(n):
    tm = n.meta.get("tensor_meta")
    if tm is not None and hasattr(tm, "shape"):
        try:
            return list(tm.shape)
        except Exception:
            pass
    v = n.meta.get("val")
    if v is not None and hasattr(v, "shape"):
        try:
            return list(v.shape)
        except Exception:
            pass
    return None


def propagate_shapes(gm, input_shapes):
    # 形状传播：优先 FakeTensorProp（允许非 fake 输入，自动转换参数），其次真实张量，最后 meta 张量；失败则返回空表
    # 注意：ShapeProp 失败信息含整个 GraphModule dump，只保留首行
    import torch

    errors = []

    def _err(tag, e):
        first = str(e).strip().splitlines()[0] if str(e).strip() else ""
        errors.append(f"{tag}: {first}"[:300])
    try:
        from torch._subclasses.fake_tensor import FakeTensorMode
        from torch.fx.passes.fake_tensor_prop import FakeTensorProp

        mode = FakeTensorMode(allow_non_fake_inputs=True)
        with mode:
            args = [torch.empty(s) for s in input_shapes]
            FakeTensorProp(gm, mode).run(*args)
        shapes = {n.name: _node_shape(n) for n in gm.graph.nodes}
        shapes = {k: v for k, v in shapes.items() if v is not None}
        if shapes:
            return shapes, errors
    except Exception as e:
        _err("FakeTensorProp", e)
    try:
        from torch.fx.passes.shape_prop import ShapeProp

        args = [torch.empty(s) for s in input_shapes]
        ShapeProp(gm).run(*args)
        shapes = {n.name: _node_shape(n) for n in gm.graph.nodes}
        shapes = {k: v for k, v in shapes.items() if v is not None}
        if shapes:
            return shapes, errors
    except Exception as e:
        _err("ShapeProp(real)", e)
    try:
        from torch.fx.passes.shape_prop import ShapeProp

        args = [torch.empty(s, device="meta") for s in input_shapes]
        ShapeProp(gm).run(*args)
        shapes = {n.name: _node_shape(n) for n in gm.graph.nodes}
        shapes = {k: v for k, v in shapes.items() if v is not None}
        if shapes:
            return shapes, errors
    except Exception as e:
        _err("ShapeProp(meta)", e)
    return {}, errors

# ---------- 计算图导出 ----------

def _iter_nodes(v):
    # 递归展平参数中的 fx Node（兼容 list/tuple/dict）
    from torch.fx import Node

    if isinstance(v, Node):
        yield v
    elif isinstance(v, (list, tuple)):
        for x in v:
            yield from _iter_nodes(x)
    elif isinstance(v, dict):
        for x in v.values():
            yield from _iter_nodes(x)


def _fn_name(fn):
    try:
        mod = getattr(fn, "__module__", "") or ""
        name = getattr(fn, "__name__", str(fn))
        if "functional" in mod:
            return f"F.{name}"
        return name
    except Exception:
        return str(fn)


def _node_group(n):
    # 从 fx 节点 meta 的 nn_module_stack 取所属模块分组（父容器路径与类名）
    stack = n.meta.get("nn_module_stack")
    if not stack:
        return None, None
    items = list(stack.items())
    if not items:
        return None, None
    if n.op == "call_module" and len(items) >= 1:
        # 栈的最深层就是该节点对应的模块本身 → 分组取其父容器
        top_path = str(items[-1][0])
        if top_path == str(n.target) and len(items) >= 2:
            items = items[:-1]
    path, (name, cls) = items[-1]
    return str(path), type(cls).__name__ if isinstance(cls, type) else str(cls)


def _fmt_tuple(v):
    # 元组/列表 → 紧凑表示，如 (1, 3) → "1×3"；全同元素折叠为单值，如 (1, 1) → "1"
    if isinstance(v, (list, tuple)):
        if len(v) and all(x == v[0] for x in v):
            return str(v[0])
        return "×".join(str(x) for x in v)
    return str(v)


def node_summary(cls, attrs):
    # 按模块类别生成节点内摘要（Netron 风格的关键属性）
    if not isinstance(attrs, dict):
        return None
    a = attrs

    def get(k, d=None):
        v = a.get(k, d)
        return _fmt_tuple(v) if isinstance(v, (list, tuple)) else v

    try:
        c = (cls or "").lower()
        if "conv" in c:
            parts = [f"{get('in_channels')}→{get('out_channels')}"]
            if a.get("kernel_size") is not None:
                parts.append(f"k={get('kernel_size')}")
            if a.get("stride") is not None and get("stride") != "1":
                parts.append(f"s={get('stride')}")
            if a.get("padding") is not None and get("padding") != "0":
                parts.append(f"p={get('padding')}")
            if a.get("groups") is not None and a.get("groups") != 1:
                parts.append(f"g={a['groups']}")
            return ", ".join(parts)
        if "linear" in c:
            return f"{get('in_features')}→{get('out_features')}"
        if "norm" in c:
            if a.get("normalized_shape") is not None:
                return f"shape={get('normalized_shape')}, eps={a.get('eps')}"
            if a.get("num_features") is not None:
                return f"feat={a['num_features']}, eps={a.get('eps')}"
            return None
        if "pool" in c or "pad" in c:
            parts = []
            for k, label in (("kernel_size", "k"), ("stride", "s"), ("padding", "p"), ("output_size", "out"), ("padding", "pad")):
                if a.get(k) is not None:
                    parts.append(f"{label}={get(k)}")
            return ", ".join(parts[:3]) or None
        if "embedding" in c:
            return f"({a.get('num_embeddings')}, {a.get('embedding_dim')})"
        if "dropout" in c:
            return f"p={a.get('p')}" if a.get("p") is not None else None
        if ("rnn" in c or "lstm" in c or "gru" in c) and a.get("input_size") is not None:
            return f"{a['input_size']}→{a.get('hidden_size')}, layers={a.get('num_layers')}"
        if "upsample" in c:
            parts = []
            if a.get("scale_factor") is not None:
                parts.append(f"scale={get('scale_factor')}")
            if a.get("size") is not None:
                parts.append(f"size={get('size')}")
            if a.get("mode"):
                parts.append(str(a["mode"]))
            return ", ".join(parts) or None
        # 兜底：取前 3 个标量属性（过滤 training 等运行状态噪声）
        pairs = [
            f"{k}={_fmt_tuple(v)}"
            for k, v in list(a.items())[:4]
            if k != "training" and isinstance(v, (bool, int, float, str, list, tuple))
        ][:3]
        return ", ".join(pairs) or None
    except Exception:
        return None


# ---------- 计算量估算 ----------

def _prod(xs):
    r = 1
    for x in xs:
        r *= x
    return r


def _arg_shapes(n, shapes):
    # 节点参数中 fx Node 的输出形状列表
    return [shapes.get(a.name) for a in _iter_nodes(list(n.args) + list(n.kwargs.values()))]


def _node_macs(n, shapes, modules):
    # 常见算子的 MACs（乘加次数）估算；无法识别返回 0
    import torch.nn as nn

    out = shapes.get(n.name)
    if not out:
        return 0
    try:
        if n.op == "call_module":
            m = modules.get(n.target)
            if isinstance(m, (nn.Conv1d, nn.Conv2d, nn.Conv3d)):
                k = _prod(m.kernel_size)
                return _prod(out) * (m.in_channels // m.groups) * k
            if isinstance(m, nn.Linear):
                return _prod(out[:-1]) * m.in_features * m.out_features
            return 0
        if n.op == "call_function":
            fn = getattr(n.target, "__name__", str(n.target))
            a = _arg_shapes(n, shapes)
            if fn in ("conv1d", "conv2d", "conv3d") and len(a) >= 2 and a[1]:
                w = a[1]
                groups = n.kwargs.get("groups", 1) or 1
                return _prod(out) * (w[1] // groups) * _prod(w[2:])
            if fn == "linear" and len(a) >= 2 and a[1]:
                return _prod(out) * a[1][-1]
            if fn in ("matmul", "bmm", "addmm") and len(a) >= 2 and a[0] and a[1] and len(a[0]) >= 2 and len(a[1]) >= 2:
                return _prod(out) * a[0][-1]
            return 0
        if n.op == "call_method" and n.target in ("matmul", "bmm"):
            a = _arg_shapes(n, shapes)
            if len(a) >= 2 and a[0] and a[1] and len(a[0]) >= 2 and len(a[1]) >= 2:
                return _prod(out) * a[0][-1]
        return 0
    except Exception:
        return 0


def export_graph(model, input_shapes, model_name):
    import torch
    import torch.fx as fx

    try:
        model = model.cpu()
    except Exception:
        pass
    try:
        model.eval()
    except Exception:
        pass
    try:
        gm = fx.symbolic_trace(model)
    except Exception as te:
        # 控制流等无法符号追踪 → 回退为模块树视图
        return {
            "ok": True,
            "kind": "tree",
            "model": model_name,
            "root": build_tree(model, model_name),
            "total_params": count_params(model),
            "warning": T(
                f"Symbolic trace failed, fell back to module tree view: {te}",
                f"符号追踪失败，已回退为模块树视图：{te}",
            ),
        }

    # 未提供输入形状时跳过形状传播（节点无 out_shape，MACs/FLOPs 不计算）
    if input_shapes:
        shapes, errors = propagate_shapes(gm, input_shapes)
    else:
        shapes, errors = {}, []
    modules = dict(model.named_modules())

    nodes = []
    edges = []
    name2id = {}
    placeholders = []
    for n in gm.graph.nodes:
        nid = len(nodes)
        name2id[n.name] = nid
        rec = {"id": nid, "name": n.name, "kind": n.op, "target": str(n.target)}
        group, group_cls = _node_group(n)
        if group:
            rec["group"] = group
            rec["group_cls"] = group_cls
        shp = shapes.get(n.name)
        if shp is not None:
            rec["out_shape"] = shp
        macs = _node_macs(n, shapes, modules)
        if macs > 0:
            rec["macs"] = macs
        if n.op == "placeholder":
            placeholders.append(rec)
        if n.op == "call_module":
            m = modules.get(n.target)
            if m is not None:
                rec["cls"] = type(m).__name__
                rec["params"] = count_params(m)
                rec["attrs"] = module_attrs(m)
                summary = node_summary(rec["cls"], rec["attrs"])
                if summary:
                    rec["summary"] = summary
        elif n.op == "call_function":
            rec["cls"] = _fn_name(n.target)
        elif n.op == "call_method":
            rec["cls"] = str(n.target)
        elif n.op == "get_attr":
            try:
                t = gm
                for part in str(n.target).split("."):
                    t = getattr(t, part)
            except Exception:
                t = None
            if isinstance(t, torch.Tensor):
                rec["cls"] = "get_attr"
                rec["out_shape"] = list(t.shape)
                rec["dtype"] = str(t.dtype)
                rec["params"] = t.numel()
        nodes.append(rec)

    for n in gm.graph.nodes:
        dst = name2id[n.name]
        seen = set()
        for arg in _iter_nodes(list(n.args) + list(n.kwargs.values())):
            src = name2id.get(arg.name)
            if src is not None and (src, dst) not in seen:
                seen.add((src, dst))
                edges.append({"src": src, "dst": dst})

    # 输入：形状缺失时用用户提供的形状兜底
    for i, rec in enumerate(placeholders):
        if rec.get("out_shape") is None and input_shapes and i < len(input_shapes):
            rec["out_shape"] = list(input_shapes[i])
    inputs = [{"name": r["name"], "shape": r.get("out_shape")} for r in placeholders]

    # 输出：展平 output 节点的返回值
    outputs = []
    seen = set()
    for n in gm.graph.nodes:
        if n.op != "output":
            continue
        for arg in _iter_nodes(list(n.args) + list(n.kwargs.values())):
            if arg.name in seen:
                continue
            seen.add(arg.name)
            rec = {"name": arg.name}
            src = name2id.get(arg.name)
            if src is not None and nodes[src].get("out_shape") is not None:
                rec["shape"] = nodes[src]["out_shape"]
            outputs.append(rec)

    total_macs = sum(r.get("macs", 0) for r in nodes)
    data = {
        "ok": True,
        "kind": "graph",
        "model": model_name,
        "nodes": nodes,
        "edges": edges,
        "inputs": inputs,
        "outputs": outputs,
        "tree": build_tree(model, model_name),
        "total_params": count_params(model),
        "total_macs": total_macs,
        "total_flops": total_macs * 2,
    }
    if errors:
        data["warning"] = T("Some shape inference failed: ", "部分形状推断失败：") + T("; ", "；").join(errors[:2])
    return data


# ---------- 模块树导出 ----------

def build_tree(m, name):
    # 递归构建模块树（模块节点 + 参数/缓冲叶子）
    node = {"id": next(_ID), "name": name, "cls": type(m).__name__, "params": count_params(m), "children": []}
    try:
        direct_params = dict(m.named_parameters(recurse=False))
        param_names = set(direct_params.keys())
        for pn, p in direct_params.items():
            node["children"].append({"id": next(_ID), "name": pn, "cls": "Parameter", "shape": list(p.shape), "dtype": str(p.dtype), "params": p.numel()})
        try:
            direct_buffers = dict(m.named_buffers(recurse=False))
        except Exception:
            direct_buffers = {}
        for bn, b in direct_buffers.items():
            if bn in param_names or b.numel() > 10_000_000:
                continue
            node["children"].append({"id": next(_ID), "name": bn, "cls": "Buffer", "shape": list(b.shape), "dtype": str(b.dtype), "params": b.numel()})
    except Exception:
        pass
    try:
        for cn, child in m.named_children():
            node["children"].append(build_tree(child, cn))
    except Exception:
        pass
    return node


# ---------- 输入形状解析 ----------

def parse_input(s):
    # 解析输入形状："1,3,224,224" 或多输入 "1,3,224,224;1,10"
    shapes = []
    for part in s.split(";"):
        part = part.strip().strip("[]()").strip()
        if not part:
            continue
        dims = [int(x) for x in part.replace(" ", "").split(",") if x != ""]
        if not dims:
            raise RuntimeError(T(f"Invalid input shape: {part}", f"无效的输入形状: {part}"))
        shapes.append(dims)
    return shapes or [[1, 3, 224, 224]]


def main():
    ap = argparse.ArgumentParser(description="TorchViewer exporter")
    ap.add_argument("--file", help=T("Target .py file", "目标 .py 文件"))
    ap.add_argument("--model", help=T("nn.Module class name", "nn.Module 类名"))
    ap.add_argument("--build", help=T('Constructor expression, e.g. "Model(num_classes=10)"', '构造表达式，如 "Model(num_classes=10)"'))
    ap.add_argument("--args", default="", help=T(
        'Constructor args as a JSON dict, e.g. \'{"channels": 8}\' (recommended, instantiated via cls(**args))',
        '构造参数 JSON 字典，如 \'{"channels": 8}\'（推荐，cls(**args) 字典方式实例化）'
    ))
    ap.add_argument("--input", default="", help=T("Input shape(s), multiple inputs separated by ;; leave empty to skip shapes", "输入形状，多输入用 ; 分隔；留空则不计算形状"))
    ap.add_argument("--list", action="store_true", help=T("List candidate model classes", "列出候选模型类"))
    ap.add_argument("--out", required=True, help=T("Output JSON path", "输出 JSON 路径"))
    ap.add_argument("--lang", default="en", help=T("UI language for messages (en/zh)", "提示信息语言（en/zh）"))
    a = ap.parse_args()
    global _LANG
    _LANG = a.lang

    try:
        if a.list:
            if not a.file:
                raise RuntimeError(T("--list requires --file", "--list 需要 --file"))
            mod = import_from_file(a.file)
            classes = find_module_classes(mod)
            infos = []
            for c in classes:
                inst = True
                try:
                    getattr(mod, c)()
                except Exception:
                    inst = False
                try:
                    params = class_params(getattr(mod, c))
                except Exception:
                    params = []
                infos.append({"name": c, "instantiable": inst, "params": params})
            _write(a.out, {"ok": True, "classes": infos})
            sys.exit(0)
        if a.file:
            mod = import_from_file(a.file)
            classes = find_module_classes(mod)
            if not classes:
                raise RuntimeError(T("No nn.Module subclass found in the file", "文件中未找到 nn.Module 子类"))
            if a.model and a.model not in classes:
                raise RuntimeError(
                    T(
                        f"{a.model} is not an nn.Module subclass defined in this file (candidates: {', '.join(classes)})",
                        f"{a.model} 不是该文件中定义的 nn.Module 子类（候选：{'、'.join(classes)}）",
                    )
                )
            model_name = a.model or classes[0]
            model = build_model(mod, model_name, a.build, a.args)
            data = export_graph(model, parse_input(a.input) if a.input.strip() else None, model_name)
            _write(a.out, data)
            sys.exit(0)
        raise RuntimeError(T("Please specify --file", "请指定 --file"))
    except SystemExit:
        raise
    except Exception as e:
        msg = str(e)
        if "No module named" in msg and "torch" in msg:
            msg = T(
                f"torch not found. Install it in the selected Python environment: pip install torch ({msg})",
                f"未找到 torch，请在所选 Python 环境安装：pip install torch（{msg}）",
            )
        _write(a.out, {"ok": False, "error": msg, "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
