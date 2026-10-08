import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs/acceptance');
const guide = await readFile(path.join(source, '2026-10-08-step-by-step-usage.md'), 'utf8');
const report = await readFile(path.join(source, '2026-10-08-real-interaction-report.md'), 'utf8');
const pictures = new Map();
for (const match of guide.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
  const bytes = await readFile(path.join(source, match[1]));
  const mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
  pictures.set(match[1], `data:${mime};base64,${bytes.toString('base64')}`);
}
const pictureId = (src) => `evidence-${path.basename(src).split('-')[0]}`;
const components = {
  img: ({ src, alt }) => React.createElement('figure', { id: pictureId(src) },
    React.createElement('img', { src: pictures.get(src), alt, loading: 'lazy' }),
    React.createElement('figcaption', null, alt)),
  a: ({ href, children }) => {
    if (pictures.has(href)) return React.createElement('a', { href: `#${pictureId(href)}` }, children);
    if (href?.endsWith('2026-10-08-real-interaction-report.md')) return React.createElement('a', { href: '#verification' }, children);
    if (href?.endsWith('2026-10-08-step-by-step-usage.md')) return React.createElement('a', { href: '#top' }, children);
    if (href?.startsWith('https://')) return React.createElement('a', { href }, children);
    return React.createElement('span', { title: '历史记录或源码位置，请参阅仓库中的Markdown版本' }, children);
  },
};
const render = (text) => renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm], components }, text));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Course Agent 逐步使用说明与真实验证报告</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#233047;font:16px/1.85 "Microsoft YaHei",system-ui,sans-serif}main{max-width:1080px;margin:24px auto;padding:32px 44px;background:white;border-radius:16px}h1{font-size:30px;line-height:1.4}h2{margin-top:48px;border-top:1px solid #dbe2ee;padding-top:24px;font-size:23px}a{color:#245ba6}figure{margin:24px 0 40px}img{display:block;width:100%;height:auto;border:1px solid #dbe2ee;border-radius:8px}figcaption{color:#58677f;font-size:14px;margin-top:8px}blockquote{border-left:4px solid #d39b35;background:#fff8e8;margin:20px 0;padding:10px 18px}table{border-collapse:collapse;width:100%;font-size:14px;display:block;overflow:auto}th,td{border:1px solid #dbe2ee;padding:10px;vertical-align:top;min-width:110px}th{background:#edf2fa}pre{overflow:auto;padding:18px;background:#edf2fa;border-radius:8px}code{overflow-wrap:anywhere}details{margin-top:48px}summary{cursor:pointer;font-size:24px;font-weight:700;background:#edf2fa;padding:18px;border-radius:8px}.top-note{color:#58677f;font-size:14px}@media(max-width:700px){main{margin:0;padding:20px 16px;border-radius:0}h1{font-size:26px}}
</style></head><body><main id="top"><p class="top-note">离线图文版 · 图片已嵌入，无需联网 · 原始事实来源为仓库中的2026-10-08说明与报告</p>${render(guide)}<details id="verification" open><summary>实际交互验证报告</summary>${render(report)}</details></main></body></html>`;
const output = path.join(root, 'release/trial-20261008-v4/使用说明与验证报告.html');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, html, 'utf8');
console.log(`Offline guide created with ${pictures.size} embedded screenshots: ${output}`);
