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


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def import_from_file(path):
    # 加载目标 .py 文件为模块
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
    if has_relative and pkg.isidentifier() and stem.isidentifier():
        parent = os.path.dirname(d)
        if parent not in sys.path:
            sys.path.insert(0, parent)
        name = f"{pkg}.{stem}"
    else:
        # 普通脚本：把文件目录加入 sys.path，便于绝对导入同目录模块
        if d not in sys.path:
            sys.path.insert(0, d)
        name = "torchviewer_target_" + str(abs(hash(path)) % 10 ** 8)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载文件: {path}")
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


def build_model(mod, cls_name, expr):
    import torch.nn as nn

    if expr:
        model = eval(expr, vars(mod))
        if not isinstance(model, nn.Module):
            raise RuntimeError(f"{expr} 不是 nn.Module")
        return model
    cls = getattr(mod, cls_name)
    try:
        return cls()
    except TypeError as e:
        raise RuntimeError(f"无法实例化 {cls_name}()（{e}）。可用 --build \"Model(args...)\" 传入构造参数。")


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
    import torch

    errors = []
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
        errors.append(f"FakeTensorProp: {e}")
    try:
        from torch.fx.passes.shape_prop import ShapeProp

        args = [torch.empty(s) for s in input_shapes]
        ShapeProp(gm).run(*args)
        shapes = {n.name: _node_shape(n) for n in gm.graph.nodes}
        shapes = {k: v for k, v in shapes.items() if v is not None}
        if shapes:
            return shapes, errors
    except Exception as e:
        errors.append(f"ShapeProp(real): {e}")
    try:
        from torch.fx.passes.shape_prop import ShapeProp

        args = [torch.empty(s, device="meta") for s in input_shapes]
        ShapeProp(gm).run(*args)
        shapes = {n.name: _node_shape(n) for n in gm.graph.nodes}
        shapes = {k: v for k, v in shapes.items() if v is not None}
        if shapes:
            return shapes, errors
    except Exception as e:
        errors.append(f"ShapeProp(meta): {e}")
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
            "warning": f"符号追踪失败，已回退为模块树视图：{te}",
        }

    shapes, errors = propagate_shapes(gm, input_shapes)
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
        if rec.get("out_shape") is None and i < len(input_shapes):
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
        data["warning"] = "部分形状推断失败：" + "；".join(errors[:2])
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


def _count_state_dict_total(sd):
    t = 0
    for v in sd.values():
        if hasattr(v, "numel"):
            try:
                t += v.numel()
            except Exception:
                pass
    return t


def tree_from_state_dict(sd):
    # 从 state_dict 重建模块层级（叶子为参数张量）
    mods = {}
    root_params = []
    for k, v in sd.items():
        if not hasattr(v, "shape"):
            continue
        parts = k.split(".")
        entry = {"id": next(_ID), "name": parts[-1], "cls": "Parameter", "shape": list(v.shape), "dtype": str(getattr(v, "dtype", "")), "params": v.numel()}
        if len(parts) == 1:
            root_params.append(entry)
        else:
            mods.setdefault(".".join(parts[:-1]), []).append(entry)

    tree = {}
    for path in mods:
        cur = tree
        for part in path.split("."):
            cur = cur.setdefault(part, {})

    def _sum_params(nd):
        t = 0
        for c in nd["children"]:
            if c.get("children") is not None:
                t += _sum_params(c)
            else:
                t += c.get("params", 0)
        return t

    def convert(d, path):
        name = path.rpartition(".")[2] if path else "state_dict"
        node = {"id": next(_ID), "name": name, "cls": "Module", "params": 0, "children": []}
        for cname, csub in d.items():
            node["children"].append(convert(csub, f"{path}.{cname}" if path else cname))
        node["children"].extend(mods.get(path, []))
        node["params"] = _sum_params(node)
        return node

    root = convert(tree, "")
    root["children"].extend(root_params)
    root["params"] += sum(p["params"] for p in root_params)
    return root


# ---------- 权重文件加载 ----------

def load_ckpt(path):
    # 兼容 torch>=2.6 默认 weights_only 的变化；失败再尝试 TorchScript
    import torch

    try:
        try:
            return torch.load(path, map_location="cpu", weights_only=False)
        except TypeError:
            return torch.load(path, map_location="cpu")
    except Exception as e:
        try:
            return torch.jit.load(path, map_location="cpu")
        except Exception:
            raise RuntimeError(f"加载权重失败：{e}")


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
            raise RuntimeError(f"无效的输入形状: {part}")
        shapes.append(dims)
    return shapes or [[1, 3, 224, 224]]


def main():
    ap = argparse.ArgumentParser(description="TorchViewer 导出器")
    ap.add_argument("--file", help="目标 .py 文件")
    ap.add_argument("--ckpt", help="模型权重文件")
    ap.add_argument("--model", help="nn.Module 类名")
    ap.add_argument("--build", help='构造表达式，如 "Model(num_classes=10)"')
    ap.add_argument("--input", default="1,3,224,224", help="输入形状，多输入用 ; 分隔")
    ap.add_argument("--list", action="store_true", help="列出候选模型类")
    ap.add_argument("--out", required=True, help="输出 JSON 路径")
    a = ap.parse_args()

    try:
        if a.list:
            if not a.file:
                raise RuntimeError("--list 需要 --file")
            mod = import_from_file(a.file)
            classes = find_module_classes(mod)
            infos = []
            for c in classes:
                inst = True
                try:
                    getattr(mod, c)()
                except Exception:
                    inst = False
                infos.append({"name": c, "instantiable": inst})
            _write(a.out, {"ok": True, "classes": infos})
            sys.exit(0)
        if a.ckpt:
            import torch

            obj = load_ckpt(a.ckpt)
            if isinstance(obj, torch.nn.Module):
                data = export_graph(obj, parse_input(a.input), type(obj).__name__)
            elif isinstance(obj, dict):
                sd = obj.get("state_dict", obj)
                data = {
                    "ok": True,
                    "kind": "tree",
                    "model": os.path.basename(a.ckpt),
                    "root": tree_from_state_dict(sd),
                    "total_params": _count_state_dict_total(sd),
                }
            else:
                raise RuntimeError(f"不识别的模型对象类型：{type(obj).__name__}")
            _write(a.out, data)
            sys.exit(0)
        if a.file:
            mod = import_from_file(a.file)
            classes = find_module_classes(mod)
            if not classes:
                raise RuntimeError("文件中未找到 nn.Module 子类")
            if a.model and a.model not in classes:
                raise RuntimeError(f"{a.model} 不是该文件中定义的 nn.Module 子类（候选：{'、'.join(classes)}）")
            model_name = a.model or classes[0]
            model = build_model(mod, model_name, a.build)
            data = export_graph(model, parse_input(a.input), model_name)
            _write(a.out, data)
            sys.exit(0)
        raise RuntimeError("请指定 --file 或 --ckpt")
    except SystemExit:
        raise
    except Exception as e:
        msg = str(e)
        if "No module named" in msg and "torch" in msg:
            msg = f"未找到 torch，请在所选 Python 环境安装：pip install torch（{msg}）"
        _write(a.out, {"ok": False, "error": msg, "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
