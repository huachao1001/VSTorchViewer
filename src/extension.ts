import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// 权重文件扩展名
const CKPT_EXTS = new Set(['.pt', '.pth', '.pkl', '.ckpt', '.bin']);

interface ClassInfo {
  name: string;
  instantiable: boolean;
}

interface PythonRunResult {
  started: boolean; // 解释器是否成功启动过
  errMsg: string;   // 失败原因（成功为空）
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('TorchViewer');
  context.subscriptions.push(
    out,
    vscode.commands.registerCommand('torchviewer.visualize', (uri?: vscode.Uri) => visualize(context, out, uri)),
    vscode.commands.registerCommand('torchviewer.visualizeFile', (uri?: vscode.Uri) => visualize(context, out, uri))
  );
}

export function deactivate() {}

function getPythonCandidates(): string[] {
  const cfg = vscode.workspace.getConfiguration('torchviewer');
  const v = (cfg.get<string>('pythonPath') || 'python').trim() || 'python';
  const cands = [v];
  if (v === 'python') {
    // 候选兜底：Python 扩展配置的解释器 → 常见解释器名
    const pyPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
    if (pyPath && pyPath.trim()) cands.unshift(pyPath.trim());
    cands.push('python3', 'py');
  }
  return [...new Set(cands)];
}

const PY_NAME = process.platform === 'win32' ? 'python.exe' : 'bin/python';

// 枚举 conda 环境对应的解释器路径
function getCondaEnvPythons(): Promise<string[]> {
  return new Promise(resolve => {
    cp.exec('conda env list', { encoding: 'utf-8', timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const pys: string[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/).filter(Boolean).filter(p => p !== '*');
        if (!parts.length || line.trim().startsWith('#')) continue;
        const envPath = parts[parts.length - 1]; // 末列是环境路径
        const py = process.platform === 'win32' ? path.join(envPath, 'python.exe') : path.join(envPath, 'bin', 'python');
        try {
          if (fs.statSync(py).isFile()) pys.push(py);
        } catch {}
      }
      resolve(pys);
    });
  });
}

// 检查解释器能否 import torch（用于候选排序）
function checkTorch(py: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = cp.spawn(py, ['-c', 'import torch'], { timeout: 60000 });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

// 解释器候选：显式配置 → Python 扩展解释器 → 当前激活 conda 环境 → conda 环境优先带 torch → 常见解释器名
async function buildPythonCandidates(): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration('torchviewer');
  const cands: string[] = [];
  const configured = (cfg.get<string>('pythonPath') || '').trim();
  if (configured) cands.push(configured);
  const pyExt = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
  if (pyExt && pyExt.trim()) cands.push(pyExt.trim());
  if (process.env.CONDA_PREFIX) cands.push(path.join(process.env.CONDA_PREFIX, PY_NAME));
  const withTorch: string[] = [];
  const noTorch: string[] = [];
  for (const py of await getCondaEnvPythons()) {
    if (cands.includes(py)) continue;
    ((await checkTorch(py)) ? withTorch : noTorch).push(py);
  }
  cands.push(...withTorch, ...noTorch, 'python', 'python3', 'py');
  return [...new Set(cands)];
}

// 单次运行导出器；不抛异常，把失败原因作为结果返回
function tryRunPython(py: string, args: string[], timeoutMs: number, cwd?: string): Promise<PythonRunResult> {
  return new Promise(resolve => {
    let stderr = '';
    let settled = false;
    const settle = (r: PythonRunResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = cp.spawn(py, args, { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const timer = setTimeout(() => {
      child.kill();
      settle({ started: true, errMsg: `导出超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', e => {
      clearTimeout(timer);
      // spawn 失败后 close 事件仍会触发，用 settled 标记防重入
      settle({ started: false, errMsg: `无法启动 Python（${py}）：${e.message}` });
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        settle({ started: true, errMsg: '' });
      } else {
        // 保留 stderr 末尾几行作为失败原因
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
        settle({ started: true, errMsg: tail || `Python（${py}）退出码 ${code}` });
      }
    });
  });
}

function readJson(outPath: string): any {
  try {
    return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

// 运行导出器并读取结果 JSON；导出器崩溃时也会写出 {"ok":false,...}
// 解释器候选依次尝试：解释器缺失、或目标依赖缺模块（ModuleNotFoundError）时自动换下一个
async function runExport(out: vscode.OutputChannel, pyCandidates: string[], args: string[], outFile: string, timeoutMs = 180000, cwd?: string): Promise<any> {
  out.appendLine(`$ ${pyCandidates[0]} ${args.join(' ')}`);
  out.appendLine(`候选解释器: ${pyCandidates.join(' → ')}`);
  let lastErr = '';
  for (const py of pyCandidates) {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {}
    const r = await tryRunPython(py, args, timeoutMs, cwd);
    if (r.errMsg) out.appendLine(r.errMsg);
    const payload = readJson(outFile);
    if (payload && payload.ok) {
      out.appendLine(`[成功] 使用 ${py}`);
      return payload;
    }
    if (payload && payload.error) {
      const msg = String(payload.error);
      out.appendLine(`[失败] ${msg.split('\n')[0]}`);
      if (/No module named|ModuleNotFoundError/i.test(msg)) {
        // 目标脚本的依赖不在该环境里，换下一个解释器
        lastErr = msg;
        continue;
      }
      throw new Error(msg);
    }
    if (r.started) {
      // 解释器跑过但结果缺失（超时/崩溃），不再换解释器重试
      lastErr = r.errMsg || '导出进程结束但未写出结果文件';
      break;
    }
    lastErr = r.errMsg;
  }
  throw new Error(lastErr || '导出失败，详情见输出面板（TorchViewer）');
}

async function askInputShape(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('torchviewer');
  const def = (cfg.get<number[]>('defaultInputShape') || [1, 3, 224, 224]).join(',');
  const s = await vscode.window.showInputBox({
    prompt: '输入张量形状（多输入用 ; 分隔，如 1,3,224,224;1,10）',
    value: def,
    validateInput: v => (/^[0-9;\[\],\s]+$/.test(v.trim()) ? null : '仅允许数字、逗号、分号'),
  });
  return (s || def).trim();
}

function showError(out: vscode.OutputChannel, e: unknown) {
  void vscode.window.showErrorMessage(`TorchViewer：${(e as Error).message}`, '查看输出').then(sel => {
    if (sel === '查看输出') out.show();
  });
}

async function visualize(context: vscode.ExtensionContext, out: vscode.OutputChannel, uri?: vscode.Uri) {
  try {
    uri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { '模型 / 脚本': ['py', 'pt', 'pth', 'pkl', 'ckpt', 'bin'] },
      });
      if (!picked || !picked[0]) return;
      uri = picked[0];
    }
    const script = uri.fsPath;
    const ext = path.extname(script).toLowerCase();
    const pyList = await buildPythonCandidates();
    const scriptDir = path.dirname(script);
    const exporter = path.join(context.extensionPath, 'python', 'torchviewer_export.py');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torchviewer-'));

    if (ext === '.py') {
      // 1) 分析脚本，列出候选模型类
      const listFile = path.join(tmpDir, 'classes.json');
      let listing: any;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TorchViewer：分析脚本…' },
        () => runExport(out, pyList, [exporter, '--file', script, '--list', '--out', listFile], listFile, 180000, scriptDir).then(p => (listing = p))
      );
      const classes: ClassInfo[] = listing?.classes || [];
      if (!classes.length) {
        void vscode.window.showErrorMessage('TorchViewer：文件中未找到 nn.Module 子类');
        return;
      }
      // 2) 选择模型类
      let model = classes[0].name;
      if (classes.length > 1) {
        const picked = await vscode.window.showQuickPick(
          classes.map(c => ({ label: c.name, description: c.instantiable ? '可直接实例化' : '需要构造参数' })),
          { placeHolder: '选择要可视化的模型类' }
        );
        if (!picked) return;
        model = picked.label;
      }
      // 3) 确认输入形状
      const shape = await askInputShape();
      // 4) 导出（实例化失败时提示输入构造表达式重试）
      const outFile = path.join(tmpDir, 'graph.json');
      let payload: any;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TorchViewer：导出模型结构…' },
        async () => {
          try {
            payload = await runExport(out, pyList, [exporter, '--file', script, '--model', model, '--input', shape, '--out', outFile], outFile, 180000, scriptDir);
          } catch (e) {
            const msg = String((e as Error).message);
            if (msg.includes('无法实例化')) {
              const expr = await vscode.window.showInputBox({ prompt: `构造表达式，如 ${model}(num_classes=10)`, placeHolder: `${model}(...)` });
              if (!expr) throw e;
              payload = await runExport(out, pyList, [exporter, '--file', script, '--model', model, '--build', expr, '--input', shape, '--out', outFile], outFile, 180000, scriptDir);
            } else {
              throw e;
            }
          }
        }
      );
      if (!payload) return;
      openViewer(context, payload, path.basename(script));
      return;
    }

    if (CKPT_EXTS.has(ext)) {
      const outFile = path.join(tmpDir, 'graph.json');
      let payload: any;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TorchViewer：导出模型结构…' },
        () => runExport(out, pyList, [exporter, '--ckpt', script, '--out', outFile], outFile, 180000, scriptDir).then(p => (payload = p))
      );
      if (!payload) return;
      openViewer(context, payload, path.basename(script));
      return;
    }

    void vscode.window.showErrorMessage(`TorchViewer：不支持的文件类型 ${ext}`);
  } catch (e) {
    showError(out, e);
  }
}

function openViewer(context: vscode.ExtensionContext, payload: any, fileName: string) {
  const panel = vscode.window.createWebviewPanel('torchviewer.viewer', `TorchViewer — ${fileName}`, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const jsUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'main.js')));
  const cssUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'main.css')));
  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cssUri} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="toolbar">
  <button id="btn-zoom-in" title="放大">＋</button>
  <button id="btn-zoom-out" title="缩小">－</button>
  <button id="btn-fit" title="适应视图">⤢</button>
  <div id="search-wrap"><input id="search" placeholder="搜索节点…" /><div id="search-list"></div></div>
  <span id="model-name"></span>
</div>
<div id="main">
  <div id="tree-panel"></div>
  <div id="tree-splitter" title="拖拽调整宽度"></div>
  <div id="graph-area">
    <svg id="svg">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#c9d6e2"></path></marker>
        <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#f5a623"></path></marker>
      </defs>
      <g id="viewport"><g id="panels"></g><g id="nodes"></g><g id="edges"></g></g>
    </svg>
  </div>
  <div id="details"></div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'ready') void panel.webview.postMessage({ type: 'data', data: payload });
  });
}
