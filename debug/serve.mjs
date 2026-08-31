// TorchViewer 渲染调试服务：esbuild 监听重建 + 静态服务器 + 文件变更自动刷新
// 用法：npm run debug [-- --port 8123 --data debug/graph.json]
import esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 解析命令行参数
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', 8123));
const DATA_PATH = path.resolve(arg('data', path.join(ROOT, 'debug', 'graph.json')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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
    graph: m(DATA_PATH),
  };
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/graph.json') {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(DATA_PATH));
        return;
      }
      if (p === '/__mtime') {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(mtimes()));
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
    } catch {
      res.writeHead(404);
      res.end('404');
    }
  })
  .listen(PORT, () => {
    const url = `http://localhost:${PORT}/debug/preview.html`;
    console.log(`TorchViewer 调试预览: ${url}`);
    console.log(`数据文件: ${DATA_PATH}`);
    console.log('重新导出 JSON 或修改 main.ts/main.css/preview.html 后页面自动刷新');
    // 自动打开系统浏览器（Simple Browser 在受限模式下会拦截请求，不可靠）
    if (!process.argv.includes('--no-open')) {
      const open = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
      import('node:child_process').then(({ spawn }) => spawn(open[0], open[1], { detached: true, stdio: 'ignore' }).unref());
    }
  });
