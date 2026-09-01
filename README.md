# TorchViewer

![TorchViewer Logo](media/logo.png)

像 Netron 一样可视化 PyTorch nn.Module 结构的 VSCode 扩展。

## 使用

1. 构建扩展：`npm install && npm run build`
2. 在 VSCode 中按 F5 启动调试窗口（或把本目录打包安装）
3. 打开一个包含 `nn.Module` 的 `.py` 文件（不含 `nn.Module` 的文件不会解析）
4. 命令面板执行 **TorchViewer: Visualize Model**，或点击编辑器右上角图标
5. 确认输入张量形状后即可查看计算图

## 设置

- `torchviewer.pythonPath`：Python 解释器（需已安装 torch）
- `torchviewer.defaultInputShape`：默认输入张量形状

## 交互

- 滚轮缩放（以光标为中心）、拖拽平移
- 点击节点查看属性详情（卷积核、通道数、参数量等），高亮前后连接
- 拖动节点调整布局；左侧模块树点击定位对应节点
- 顶部搜索框按名称/类型过滤节点

## 局限

- 仅支持包含 `nn.Module` 的 `.py` 文件，不支持权重文件（`.pt` / `.pth` 等）
- 需要目标 Python 环境已安装 torch
- 含动态控制流的模型展示模块树而非计算图
