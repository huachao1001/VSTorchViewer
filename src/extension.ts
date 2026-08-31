import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

interface ClassInfo {
  name: string;
  instantiable: boolean;
  params?: { name: string; required: boolean; default?: string; annotation?: string }[];
}

interface PythonRunResult {
  started: boolean; // 解释器是否成功启动过
  errMsg: string;   // 失败原因（成功为空）
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('TorchViewer');
  LOG_OUT = out;
  context.subscriptions.push(
    out,
    vscode.commands.registerCommand('torchviewer.visualize', (uri?: vscode.Uri) => visualize(context, out, uri)),
    vscode.commands.registerCommand('torchviewer.visualizeFile', (uri?: vscode.Uri) => visualize(context, out, uri))
  );
}

// ---------- 日志 ----------
// 双写：输出面板（完整历史）+ 预览面板遮罩内的实时日志窗（当前在做什么一目了然）
let LOG_OUT: vscode.OutputChannel | undefined;
let LOG_WEB: ((text: string) => void) | undefined;
function log(msg: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  try {
    LOG_OUT?.appendLine(`[${t}] ${msg}`);
  } catch {}
  try {
    LOG_WEB?.(msg);
  } catch {}
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

// 枚举 conda 环境对应的解释器路径（仅在依赖缺失需要换环境时调用）
function getCondaEnvPythons(): Promise<string[]> {
  return new Promise(resolve => {
    cp.exec('conda env list', { encoding: 'utf-8', timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const pys: string[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/).filter(Boolean).filter(p => p !== '*');
        if (!parts.length || line.trim().startsWith('#')) continue;
        const envPath = parts[parts.length - 1]; // 末列是环境路径
        const py = process.platform === 'win32' ? path.join(envPath, PY_NAME) : path.join(envPath, 'bin', 'python');
        try {
          if (fs.statSync(py).isFile()) pys.push(py);
        } catch {}
      }
      resolve(pys);
    });
  });
}

// Promise 超时包装：超时返回 undefined，不抛异常（用于可能卡住的外部扩展 API）
function withTimeout<T>(p: Thenable<T> | Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([Promise.resolve(p), new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
}

// Python 扩展（ms-python.python）设置的解释器，全部读出（不枚举猜测）：
// 解释器选择按 文件 → 工作区 → 全局 三层独立存储，各层选择都读出来按序作为候选
async function getPythonExtInterpreters(resource?: vscode.Uri): Promise<string[]> {
  const ext = vscode.extensions.getExtension('ms-python.python');
  if (!ext) {
    log('Python 扩展（ms-python.python）未安装');
    return [];
  }
  // 先激活再取 exports：未激活时 exports 是 undefined
  try {
    if (!ext.isActive) {
      log('等待 Python 扩展激活（限时 5s）…');
      await withTimeout(ext.activate(), 5000);
    }
  } catch {}
  if (!ext.isActive) {
    log('Python 扩展激活超时，跳过其解释器选择');
    return [];
  }
  const api = ext.exports as any;
  if (!api) {
    log('Python 扩展已激活但未暴露 API');
    return [];
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const out: string[] = [];
  const push = (p: string | undefined, label: string): void => {
    if (p && !out.includes(p)) {
      log(`Python 扩展解释器（${label}）: ${p}`);
      out.push(p);
    }
  };

  // 按优先级排列的资源：目标文件 → 当前工作区 → 全局
  const scopes: { label: string; uris: (vscode.Uri | undefined)[] }[] = [];
  if (resource) scopes.push({ label: '目标文件', uris: [resource] });
  if (folder) scopes.push({ label: '当前工作区', uris: [folder] });
  scopes.push({ label: '全局', uris: [undefined] });

  if (api.environments?.getActiveEnvironmentPath && api.environments?.resolveEnvironment) {
    for (const scope of scopes) {
      for (const r of scope.uris) {
        // 两种调用形态都试：新 API 收 { workspaceFolder }，旧 API 收位置参数 Uri
        const envs: any[] = [];
        try {
          envs.push(api.environments.getActiveEnvironmentPath(r ? { workspaceFolder: r } : undefined));
        } catch {}
        if (r) {
          try {
            envs.push(api.environments.getActiveEnvironmentPath(r));
          } catch {}
        }
        for (const env of envs) {
          if (!env) continue;
          for (const cand of [env, env.id, env.path]) {
            if (cand === undefined || cand === null) continue;
            try {
              const resolved = (await withTimeout(api.environments.resolveEnvironment(cand), 5000)) as any;
              push(resolved?.executable?.uri?.fsPath || resolved?.path, scope.label);
            } catch {}
          }
        }
      }
    }
  }
  // python.interpreterPath 命令：同样按资源逐个读
  for (const scope of scopes) {
    for (const r of scope.uris) {
      try {
        const p = (await withTimeout(vscode.commands.executeCommand('python.interpreterPath', r), 5000)) as unknown;
        if (typeof p === 'string' && p.trim()) push(p.trim(), scope.label);
      } catch {}
    }
  }
  // 旧版 API 兜底：execCommand 可能是 ['conda','run','-p',env,'python'] 形式，从中解析真实解释器
  for (const scope of scopes) {
    for (const r of scope.uris) {
      try {
        const det = api.settings?.getExecutionDetails?.(r);
        const cmd: string[] | undefined = det?.execCommand;
        if (!cmd?.length) continue;
        const absPy = cmd.filter(c => /[\\/]python(\.exe)?$/i.test(c)).pop();
        if (absPy) {
          push(absPy, scope.label);
          continue;
        }
        const pi = cmd.findIndex(c => c === '-p' || c === '--prefix');
        if (pi >= 0 && cmd[pi + 1]) {
          push(process.platform === 'win32' ? path.join(cmd[pi + 1], 'python.exe') : path.join(cmd[pi + 1], 'bin', 'python'), scope.label);
          continue;
        }
        const last = cmd[cmd.length - 1];
        if (/[\\/]python(\.exe)?$/i.test(last) || last === 'python') push(last, scope.label);
      } catch {}
    }
  }
  if (!out.length) log('未能从 Python 扩展获取任何解释器设置');
  return out;
}

// 解释器候选：VS Code 各层设置的解释器（目标文件 → 工作区 → 全局）→ torchviewer.pythonPath → python.defaultInterpreterPath → 常见解释器名
// ---------- 从 VS Code 磁盘存储读取 Python 环境选择 ----------
// 「选择解释器」的落盘位置：workspaceStorage\<hash>\workspace.json（工作区文件夹映射）
// + state.vscdb（SQLite）内 ms-python.vscode-python-envs 项的 JSON：
//   { "ms-python.vscode-python-envs:conda:WORKSPACE_SELECTED": { "<文件夹>": "<环境路径>" },
//     "ms-python.vscode-python-envs:conda:GLOBAL_SELECTED": "<环境路径>" }
// 直接按目标文件所属工作区读取，跨窗口也能拿到（Python 扩展 API 只反映当前窗口的选择）
function pyInterpreterFromEnvPrefix(env: string): string {
  const e = env.trim();
  if (!e) return e;
  if (/python(\.exe)?$/i.test(e)) return e;
  if (/scripts$/i.test(e)) return path.join(e, 'python.exe');
  return process.platform === 'win32' ? path.join(e, 'python.exe') : path.join(e, 'bin', 'python');
}

// 从文本 start（'{'）处提取括号配平的 JSON 片段（值内容为路径，不含花括号，够用）
function extractBalancedJson(text: string, start: number): string | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function readStoredSelectedInterpreters(scriptPath: string): string[] {
  const out: string[] = [];
  try {
    const norm = (p: string) => p.toLowerCase().replace(/\//g, '\\');
    const scriptN = norm(scriptPath);
    const appData = process.env.APPDATA;
    const roots = appData
      ? [
          path.join(appData, 'Code', 'User', 'workspaceStorage'),
          path.join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
          path.join(appData, 'VSCodium', 'User', 'workspaceStorage'),
        ]
      : [];
    for (const root of roots) {
      let hashes: string[] = [];
      try {
        hashes = fs.readdirSync(root);
      } catch {
        continue;
      }
      // 找出包含目标脚本的工作区（最长前缀优先）
      let best: { folderN: string; dir: string } | undefined;
      for (const h of hashes) {
        const dir = path.join(root, h);
        let wj: string;
        try {
          wj = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf-8');
        } catch {
          continue;
        }
        let folders: string[] = [];
        try {
          const j = JSON.parse(wj);
          folders = j.folder ? [j.folder] : (j.folders || []).map((f: any) => f.uri);
        } catch {
          continue;
        }
        for (const u of folders) {
          let f: string;
          try {
            f = decodeURIComponent(String(u).replace(/^file:\/\/\//, ''));
          } catch {
            continue;
          }
          const fN = norm(f);
          if ((scriptN.startsWith(fN + '\\') || scriptN === fN) && (!best || fN.length > best.folderN.length)) {
            best = { folderN: fN, dir };
          }
        }
      }
      if (!best) continue;
      // 读该工作区 state.vscdb（含 WAL）里的 python-envs 选择
      for (const db of [path.join(best.dir, 'state.vscdb'), path.join(best.dir, 'state.vscdb-wal')]) {
        let text: string;
        try {
          if (!fs.existsSync(db)) continue;
          text = fs.readFileSync(db, 'utf8');
        } catch {
          continue;
        }
        const keyAt = text.indexOf('"ms-python.vscode-python-envs:');
        if (keyAt < 0) continue;
        const objStart = text.lastIndexOf('{', keyAt);
        if (objStart < 0) continue;
        const raw = extractBalancedJson(text, objStart);
        if (!raw) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue;
        }
        for (const [k, v] of Object.entries(obj)) {
          const m = /^(.*):(WORKSPACE|GLOBAL)_SELECTED$/.exec(k);
          if (!m) continue;
          if (m[2] === 'WORKSPACE_SELECTED' && v && typeof v === 'object') {
            for (const [fk, env] of Object.entries(v as Record<string, unknown>)) {
              if (scriptN.startsWith(norm(fk))) {
                const py = pyInterpreterFromEnvPrefix(String(env));
                if (py && !out.includes(py)) out.push(py);
              }
            }
          } else if (m[2] === 'GLOBAL_SELECTED' && typeof v === 'string') {
            const py = pyInterpreterFromEnvPrefix(v);
            if (py && !out.includes(py)) out.push(py);
          }
        }
      }
      if (out.length) break;
    }
  } catch (e) {
    log(`读取 VS Code 存储的环境选择失败: ${(e as Error).message}`);
  }
  return out;
}

async function buildPythonCandidates(resource?: vscode.Uri): Promise<string[]> {
  const cands: string[] = [];
  // 1) VS Code 磁盘存储的环境选择（目标文件所属工作区，跨窗口可读）
  if (resource) {
    const stored = readStoredSelectedInterpreters(resource.fsPath);
    if (stored.length) {
      log(`VS Code 存储的工作区环境: ${stored.join(' → ')}`);
      cands.push(...stored);
    }
  }
  // 2) Python 扩展 API（当前窗口：目标文件 → 工作区 → 全局）
  cands.push(...(await getPythonExtInterpreters(resource)));
  const configured = (vscode.workspace.getConfiguration('torchviewer').get<string>('pythonPath') || '').trim();
  if (configured) cands.push(configured);
  const pyDefault = (vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || '').trim();
  if (pyDefault) cands.push(pyDefault);
  cands.push('python', 'python3', 'py');
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
// 记忆上次成功的解释器：同一脚本下次直接优先使用，跳过全部探测/枚举
function readPyMemo(context: vscode.ExtensionContext, script: string): string | undefined {
  const e = readCache(context, cacheKey(['py', script]));
  return e && e.v === CACHE_VERSION && typeof e.py === 'string' && e.py ? e.py : undefined;
}

async function runExport(
  out: vscode.OutputChannel,
  pyCandidates: string[],
  args: string[],
  outFile: string,
  timeoutMs = 180000,
  cwd?: string,
  context?: vscode.ExtensionContext,
  memoKey?: string
): Promise<any> {
  log(`$ ${pyCandidates[0]} ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' …' : ''}`);
  const cands = [...pyCandidates];
  const tried = new Set<string>();
  let extrasAdded = false;
  let depErr = '';   // 真实解释器跑起来后的报错（依赖缺失等，最有参考价值）
  let spawnErr = ''; // 解释器本身无法启动（ENOENT 之类）
  for (let i = 0; i < cands.length; i++) {
    const py = cands[i];
    const tkey = process.platform === 'win32' ? py.toLowerCase() : py;
    if (tried.has(tkey)) continue;
    tried.add(tkey);
    log(`尝试解释器: ${py}`);
    const r = await tryRunPython(py, args, timeoutMs, cwd);
    if (r.errMsg) log(`  ${r.errMsg.replace(/\n/g, ' | ')}`);
    const payload = readJson(outFile);
    if (payload && payload.ok) {
      log(`[成功] 使用 ${py}`);
      if (context && memoKey) {
        writeCache(context, cacheKey(['py', memoKey]), { v: CACHE_VERSION, py });
        log('已记忆该脚本可用的解释器，下次直接使用');
      }
      return payload;
    }
    if (payload && payload.error) {
      const msg = String(payload.error);
      log(`[失败] ${msg.split('\n')[0]}`);
      if (/No module named|ModuleNotFoundError/i.test(msg)) {
        // 目标脚本的依赖不在该环境里：首次遇到时把所有 conda 环境追加为候选
        //（VS Code 的解释器选择按窗口隔离，当前窗口读不到其他项目选的环境时的兜底）
        depErr = msg;
        if (!extrasAdded) {
          extrasAdded = true;
          const envs = (await getCondaEnvPythons()).filter(e => !tried.has(process.platform === 'win32' ? e.toLowerCase() : e));
          if (envs.length) {
            log(`依赖缺失，追加 conda 环境候选: ${envs.join(' → ')}`);
            cands.splice(i + 1, 0, ...envs);
          }
        }
        continue;
      }
      throw new Error(msg);
    }
    if (r.started) {
      // 解释器跑过但结果缺失（超时/崩溃），不再换解释器重试
      depErr = r.errMsg || '导出进程结束但未写出结果文件';
      break;
    }
    spawnErr = r.errMsg;
  }
  // 优先展示真实运行报错（依赖缺失），解释器缺失的 ENOENT 只是兜底信息
  throw new Error(depErr || spawnErr || '导出失败，详情见输出面板（TorchViewer）');
}

function showError(out: vscode.OutputChannel, e: unknown) {
  void vscode.window.showErrorMessage(`TorchViewer：${(e as Error).message}`, '查看输出').then(sel => {
    if (sel === '查看输出') out.show();
  });
}

// ---------- 导出结果缓存 ----------
// 结果落盘到 globalStorage；同一文件（mtime 未变）+ 同模型/输入再次打开时直接恢复，跳过 Python 导出
// 结构格式变更时递增 CACHE_VERSION，旧缓存整体失效
const CACHE_VERSION = '1';

function cacheKey(parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

function readCache(context: vscode.ExtensionContext, key: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(context.globalStorageUri.fsPath, `tv-${key}.json`), 'utf-8'));
  } catch {
    return undefined;
  }
}

function writeCache(context: vscode.ExtensionContext, key: string, entry: any): void {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(path.join(context.globalStorageUri.fsPath, `tv-${key}.json`), JSON.stringify(entry));
  } catch {}
}

// 缓存命中且源文件未改动
function cacheFresh(entry: any, mtime: number): boolean {
  return !!entry && entry.v === CACHE_VERSION && entry.mtime === mtime;
}

async function visualize(context: vscode.ExtensionContext, out: vscode.OutputChannel, uri?: vscode.Uri) {
  try {
    uri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'Python 脚本': ['py'] },
      });
      if (!picked || !picked[0]) return;
      uri = picked[0];
    }
    const script = uri.fsPath;
    const ext = path.extname(script).toLowerCase();
    // 仅解析包含 nn.Module 的 .py 文件，其余文件直接提示后返回
    if (ext !== '.py') {
      void vscode.window.showWarningMessage('TorchViewer 仅支持包含 nn.Module 的 .py 文件');
      return;
    }
    let hasModule = false;
    try {
      hasModule = /\bnn\.Module\b/.test(fs.readFileSync(script, 'utf-8'));
    } catch {}
    if (!hasModule) {
      void vscode.window.showWarningMessage('未检测到 nn.Module，TorchViewer 仅解析包含 nn.Module 的 Python 文件');
      return;
    }
    const scriptDir = path.dirname(script);
    const exporter = path.join(context.extensionPath, 'python', 'torchviewer_export.py');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torchviewer-'));

    // 先打开面板（带加载动画），后续解析过程把进度 / 结果 / 错误推送到面板内
    let classes: ClassInfo[] = [];
    let exportOnce: ((model: string, input?: string, args?: Record<string, string>) => Promise<any>) | undefined;
    let currentModel: string | undefined;
    let lastInput: string | undefined;
    let lastArgs: Record<string, string> | undefined;
    const sender = openViewer(context, path.basename(script), async msg => {
      if (msg?.type === 'openLog') {
        out.show();
        return;
      }
      if (!exportOnce) return;
      if (msg?.type === 'export' && typeof msg.model === 'string' && classes.some(c => c.name === msg.model)) {
        currentModel = msg.model;
        lastArgs = msg.args && typeof msg.args === 'object' ? (msg.args as Record<string, string>) : undefined;
        // 需要构造参数且表单尚未提交 → 推送参数表单而不是直接导出
        const cls = classes.find(c => c.name === msg.model);
        if (cls && !cls.instantiable && !lastArgs) {
          sender.post({ type: 'form', model: msg.model, classes });
          return;
        }
      } else if (msg?.type === 'input' && typeof msg.shape === 'string') {
        lastInput = msg.shape.trim();
      } else {
        return;
      }
      try {
        const data = await exportOnce(currentModel!, lastInput, lastArgs);
        if (data) sender.post({ type: 'data', data });
      } catch (e) {
        fail(e);
      }
    });
    LOG_WEB = text => {
      try {
        sender.post({ type: 'log', text });
      } catch {}
    };
    log(`打开预览: ${script}`);
    const notify = (text: string) => {
      log(text);
      sender.post({ type: 'progress', text });
    };
    const fail = (e: unknown) => {
      log(`[错误] ${(e as Error).message}`);
      showError(out, e);
      sender.post({ type: 'error', message: (e as Error).message });
    };

    try {
      if (ext === '.py') {
        const fileMtime = fs.statSync(script).mtimeMs;
        // 1) 类清单缓存：脚本未改动时直接复用，跳过 --list 导出
        const classesKey = cacheKey(['cls', script]);
        let cachedClasses = readCache(context, classesKey);
        if (cacheFresh(cachedClasses, fileMtime) && Array.isArray(cachedClasses.classes) && cachedClasses.classes.length) {
          classes = cachedClasses.classes;
          log('类清单缓存命中');
        } else {
          log('类清单缓存未命中');
        }

        // 2) 图结构缓存：类清单 + 默认模型的结构都已缓存 → 秒开恢复，完全跳过 Python
        const first = classes.length ? classes.find(c => c.instantiable) || classes[0] : undefined;
        if (first) {
          const graphKey = cacheKey(['graph', script, first.name, '']);
          const cachedGraph = readCache(context, graphKey);
          if (cacheFresh(cachedGraph, fileMtime) && cachedGraph.payload) {
            log('图结构缓存命中，直接恢复');
            const payload = cachedGraph.payload;
            payload.classes = classes;
            payload.model = first.name;
            sender.post({ type: 'data', data: payload });
            return;
          }
        }

        // 3) 无缓存 → 正常导出
        notify('正在分析 Python 环境…');
        const pyList = await buildPythonCandidates(uri);
        log(`解释器候选: ${pyList.join(' → ')}`);
        // 上次验证过可用的解释器直接置顶，跳过全部探测
        const memo = readPyMemo(context, script);
        if (memo) {
          log(`命中解释器记忆（上次成功）: ${memo}`);
          const idx = pyList.findIndex(p => p.toLowerCase() === memo.toLowerCase());
          if (idx >= 0) pyList.splice(idx, 1);
          pyList.unshift(memo);
        }

        // 类清单缺失或过期 → 重新分析脚本
        if (!classes.length) {
          const listFile = path.join(tmpDir, 'classes.json');
          notify('正在分析脚本中的模型类…');
          const listing = await runExport(out, pyList, [exporter, '--file', script, '--list', '--out', listFile], listFile, 180000, scriptDir, context, script);
          classes = listing?.classes || [];
          if (!classes.length) throw new Error('文件中未找到 nn.Module 子类');
          writeCache(context, classesKey, { v: CACHE_VERSION, mtime: fileMtime, classes });
          log(`已写入类清单缓存（${classes.length} 个类）`);
        }

        const outFile = path.join(tmpDir, 'graph.json');
        const attachMeta = (payload: any, model: string): any => {
          if (payload) {
            payload.classes = classes;
            payload.model = model;
          }
          return payload;
        };
        // 表单值 → 构造表达式：值为 Python 字面量原样拼接，空值跳过（用类默认值）
        const buildExpr = (model: string, args?: Record<string, string>): string | undefined => {
          if (!args) return undefined;
          const pairs = Object.entries(args)
            .filter(([, v]) => v && v.trim())
            .map(([k, v]) => `${k}=${v.trim()}`);
          return `${model}(${pairs.join(', ')})`;
        };
        // 单次导出：input 形状可选；需要构造参数的类用表单值拼 --build 表达式；结果写缓存
        exportOnce = async (model: string, input?: string, args?: Record<string, string>): Promise<any> => {
          const gKey = cacheKey(['graph', script, model, input || '', buildExpr(model, args) || '']);
          const cachedGraph = readCache(context, gKey);
          if (cacheFresh(cachedGraph, fileMtime) && cachedGraph.payload) {
            return attachMeta(cachedGraph.payload, model);
          }
          notify(`正在导出 ${model}…`);
          const args0 = [exporter, '--file', script, '--model', model];
          const expr = buildExpr(model, args);
          if (expr) args0.push('--build', expr);
          if (input) args0.push('--input', input);
          const payload = await runExport(out, pyList, [...args0, '--out', outFile], outFile, 180000, scriptDir, context, script);
          writeCache(context, gKey, { v: CACHE_VERSION, mtime: fileMtime, payload });
          log('导出结果已写入缓存');
          return attachMeta(payload, model);
        };

        // 4) 默认导出第一个可直接实例化的类；需要构造参数的类推送表单；不询问输入形状（在预览界面输入，避免弹窗打断）
        const def = classes.find(c => c.instantiable) || classes[0];
        currentModel = def.name;
        if (!def.instantiable) {
          log(`默认类 ${def.name} 需要构造参数，推送参数表单`);
          sender.post({ type: 'form', model: def.name, classes });
          return;
        }
        const payload = await exportOnce(def.name);
        if (!payload) throw new Error('导出进程结束但未写出结果文件');
        log('导出完成，已推送到预览');
        sender.post({ type: 'data', data: payload });
        return;
      }

      throw new Error(`不支持的文件类型 ${ext}（仅支持包含 nn.Module 的 .py 文件）`);
    } catch (e) {
      fail(e);
    }
  } catch (e) {
    showError(out, e);
  }
}

// 打开预览面板：数据 / 进度 / 错误由调用方通过返回的 sender 异步推送
// webview 就绪前 postMessage 可能被丢弃，先把消息排队，收到 ready 后再冲刷
function openViewer(
  context: vscode.ExtensionContext,
  fileName: string,
  onMessage?: (msg: any) => void | Promise<void>
) {
  const panel = vscode.window.createWebviewPanel('torchviewer.viewer', `TorchViewer — ${fileName}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const webview = panel.webview;
  const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'main.js')));
  const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'main.css')));
  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="tv-loading"><div class="spinner"></div><div class="tv-loading-text">正在准备…</div></div>
<div id="model-tabs" style="display:none"></div>
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
  let ready = false;
  const queue: any[] = [];
  const post = (msg: any) => {
    if (ready) void panel.webview.postMessage(msg);
    else queue.push(msg);
  };
  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'ready') {
      ready = true;
      while (queue.length) void panel.webview.postMessage(queue.shift());
      return;
    }
    void onMessage?.(msg);
  });
  panel.onDidDispose(() => {
    queue.length = 0;
  });
  return { post };
}
