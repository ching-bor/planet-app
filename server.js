const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8765;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || require('./config').DEEPSEEK_KEY;

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon'
};

function fetchHttps(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(options.headers || {})
      }
    };
    const req = https.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 20000, () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Proxy: Weibo Hot Search via 60s API ──
  if (pathname === '/proxy/weibo') {
    try {
      const result = await fetchHttps('https://60s.viki.moe/v2/weibo?encoding=json');
      if (result.status === 200) {
        const d = JSON.parse(result.body);
        if (d.code === 200 && d.data && d.data.length) {
          // 转换为统一格式
          const items = d.data.map((item, idx) => ({
            note: item.title,
            label_name: idx < 3 ? '沸' : '热',
            num: item.hot_value || 0,
            pic: '',
            link: item.link || ('https://s.weibo.com/weibo?q=' + encodeURIComponent(item.title))
          }));
          res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
          res.end(JSON.stringify({ data: { realtime: items } }));
          console.log('Weibo OK:', items.length, 'items');
          return;
        }
      }
      // 备用: 60秒读懂世界
      const news = await fetchHttps('https://60s.viki.moe/v2/60s?encoding=json');
      if (news.status === 200) {
        const nd = JSON.parse(news.body);
        if (nd.data && nd.data.news) {
          const items = nd.data.news.map((title, idx) => ({
            note: title,
            label_name: '新闻',
            num: 0,
            pic: '',
            link: ''
          }));
          res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
          res.end(JSON.stringify({ data: { realtime: items } }));
          console.log('60s news OK:', items.length, 'items');
          return;
        }
      }
      throw new Error('No data from 60s API');
    } catch (e) {
      console.error('Weibo proxy error:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ data: { realtime: [] }, error: e.message }));
    }
    return;
  }

  // ── Proxy: AI Chat (DeepSeek) ──
  if (pathname === '/proxy/ai') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let messages = [];
    try { messages = JSON.parse(body).messages || []; } catch { messages = [{ role: 'user', content: body }]; }

    const dsBody = JSON.stringify({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.8,
      max_tokens: 1024,
      stream: false
    });

    try {
      const result = await fetchHttps('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_KEY
        },
        body: dsBody,
        timeout: 30000
      });
      console.log('DeepSeek status:', result.status);
      if (result.status === 200) {
        const d = JSON.parse(result.body);
        const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (text && text.length > 1) {
          console.log('AI OK:', text.substring(0, 60));
          res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' });
          res.end(text);
          return;
        }
      }
      console.error('DeepSeek error:', result.status, result.body.substring(0, 200));
      res.writeHead(502, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end('AI_ERROR:' + result.status);
    } catch (e) {
      console.error('DeepSeek proxy error:', e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end('AI_ERROR:' + e.message);
    }
    return;
  }

  // ── Static file serving ──
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (file.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
  const fp = path.join(__dirname, file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT);
  console.log('Proxy: /proxy/weibo (60s API), /proxy/ai (DeepSeek)');
});
