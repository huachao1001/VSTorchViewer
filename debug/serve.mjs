// TorchViewer 渲染调试服务：esbuild 监听重建 + 静态服务器 + 文件变更自动刷新
// 用法：
//   静态数据：npm run debug [-- --port 8123 --data debug/graph.json]
//   交互模式：node debug/serve.mjs --file <目标.py> [--python <解释器>] [--input 形状]
// 交互模式由服务端代理调用导出器：网页内 tab 切换 / 构造参数表单 / 输入形状提交均真实生效
import esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 解析命令行参数
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', 8123));
const TARGET_FILE = arg('file', '');
const PYTHON = arg('python', 'python');
const INITIAL_INPUT = arg('input', '');
const DATA_PATH = path.resolve(arg('data', path.join(ROOT, 'debug', 'graph.json')));
const INTERACTIVE = !!TARGET_FILE;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------- 交互模式：代理调用导出器 ----------

const TMP_OUT = path.join(os.tmpdir(), 'torchviewer-export.json');
const TMP_LIST = path.join(os.tmpdir(), 'torchviewer-classes.json');
// 表单记忆落盘（按目标文件区分）：服务重启后仍能"上次填写的参数直接续跑"
const MEMO_PATH = path.join(os.tmpdir(), `torchviewer-memo-${path.basename(TARGET_FILE || 'debug')}.json`);
let memoDisk = null;
const loadMemo = () => {
  if (!memoDisk) {
    try {
      memoDisk = JSON.parse(fs.readFileSync(MEMO_PATH, 'utf8'));
    } catch {
      memoDisk = {};
    }
  }
  return memoDisk;
};
const saveMemo = (model, entry) => {
  const m = loadMemo();
  m[model] = entry;
  memoDisk = m;
  try {
    fs.writeFileSync(MEMO_PATH, JSON.stringify(m));
  } catch {
    /* 落盘失败不影响内存记忆 */
  }
};

const runExporter = args =>
  new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [path.join(ROOT, 'python', 'torchviewer_export.py'), ...args], { cwd: ROOT });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      const out = args[args.indexOf('--out') + 1];
      if (out && fs.existsSync(out)) resolve();
      else reject(new Error(err || `导出器退出码 ${code}`));
    });
  });

let classes = []; // 类清单（--list 缓存，多 tab 数据源）
let state = null; // 当前推送状态：{type:'data',data} | {type:'form',model,classes}
let currentModel = ''; // 最近导出的模型（输入形状变更时重导出用）
const lastRun = new Map(); // model → {args, raw, input}

async function listClasses() {
  await runExporter(['--list', '--file', TARGET_FILE, '--out', TMP_LIST]);
  classes = JSON.parse(fs.readFileSync(TMP_LIST, 'utf8')).classes || [];
  // 磁盘表单记忆 → 内存（服务重启后"上次填写直接续跑"仍生效）
  const memo = loadMemo();
  for (const [model, entry] of Object.entries(memo)) {
    if (classes.some(c => c.name === model) && !lastRun.has(model)) lastRun.set(model, entry);
  }
}

async function exportModel(model, opts = {}) {
  const last = lastRun.get(model) || {};
  const args = opts.args !== undefined ? opts.args : last.args;
  const raw = opts.raw !== undefined ? opts.raw : last.raw;
  const input = opts.input !== undefined ? opts.input : (last.input ?? INITIAL_INPUT);
  const cli = ['--file', TARGET_FILE, '--model', model, '--out', TMP_OUT];
  if (args && Object.keys(args).length) cli.push('--args', JSON.stringify(args));
  else if (raw) cli.push('--build', `${model}(${raw})`);
  if (input) cli.push('--input', input);
  lastRun.set(model, { args, raw, input });
  saveMemo(model, { args, raw, input });
  currentModel = model;
  await runExporter(cli);
  const data = JSON.parse(fs.readFileSync(TMP_OUT, 'utf8'));
  if (!data.ok) return { type: 'error', message: data.error || '导出失败' };
  data.classes = classes;
  // 附带实际使用的构造参数：webview 回填表单记忆（右下角表单预填真实值）
  if (args && Object.keys(args).length) data.__tvArgs = args;
  // 渲染缓存键：模型/参数/形状/文件任一变化才重渲染（对齐扩展侧行为）
  data.__tvKey = JSON.stringify([model, args || null, raw || null, input || null, fs.statSync(TARGET_FILE).mtimeMs]);
  return { type: 'data', data };
}

// webview 渲染器监听重建
const ctx = await esbuild.context({
  entryPoints: [path.join(ROOT, 'src/webview/main.ts')],
  bundle: true,
  outfile: path.join(ROOT, 'media/main.js'),
  format: 'iife',
  target: 'es2020',
  logLevel: 'info',
});
await ctx.watch();

const mtimes = () => {
  const m = p => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  return {
    js: m(path.join(ROOT, 'media/main.js')),
    css: m(path.join(ROOT, 'media/main.css')),
    html: m(path.join(ROOT, 'debug/preview.html')),
  };
};

const serveJSON = (res, obj) => {
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/state') {
        // 初始状态：交互模式 → 类清单/表单/最近导出；静态模式 → graph.json 包装成 data 消息
        if (!state && INTERACTIVE) {
          await listClasses();
          const first = classes[0];
          state = first && first.instantiable ? await exportModel(first.name) : { type: 'form', model: first?.name || '', classes };
        } else if (!state) {
          state = { type: 'data', data: JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) };
        }
        serveJSON(res, state);
        return;
      }
      if (p === '/export') {
        const q = url.searchParams;
        const model = q.get('model') || currentModel;
        let args = null;
        if (q.get('args')) {
          try {
            args = JSON.parse(q.get('args'));
          } catch {
            args = null;
          }
        }
        const raw = q.get('raw') || '';
        const input = q.has('input') ? q.get('input') : undefined;
        const cls = classes.find(c => c.name === model);
        // 需传参类：无新提交参数且无历史记忆 → 表单态；有记忆（上次填写）→ 直接续跑导出
        const memoArgs = lastRun.get(model)?.args;
        if (cls && !cls.instantiable && !args && !raw && !(memoArgs && Object.keys(memoArgs).length)) {
          state = { type: 'form', model, classes };
        } else {
          state = await exportModel(model, { args, raw, input }).catch(e => ({ type: 'error', message: String(e.message || e) }));
        }
        serveJSON(res, state);
        return;
      }
      if (p === '/__mtime') {
        serveJSON(res, mtimes());
        return;
      }
      if (p === '/' || p === '/index.html') {
        const file = path.join(ROOT, 'debug', 'preview.html');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
      // 静态文件（限制在项目根内）
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT) || !fs.statSync(file).isFile()) throw new Error('not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      // 错误也返回 JSON：前端 getJSON 统一 JSON.parse 后展示可读信息
      res.writeHead(500, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  })
  .listen(PORT, () => {
    const url = `http://localhost:${PORT}/debug/preview.html`;
    console.log(`TorchViewer 调试预览: ${url}`);
    console.log(INTERACTIVE ? `目标文件: ${TARGET_FILE}\n解释器: ${PYTHON}` : `数据文件: ${DATA_PATH}`);
    console.log('修改 main.ts/main.css/preview.html 后页面自动刷新');
    // 自动打开系统浏览器（Simple Browser 在受限模式下会拦截请求，不可靠）
    if (!process.argv.includes('--no-open')) {
      const open = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
      import('node:child_process').then(({ spawn }) => spawn(open[0], open[1], { detached: true, stdio: 'ignore' }).unref());
    }
  });
