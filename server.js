// 课栈助手 - Render 部署版本
// 飞书同步：使用环境变量，内存队列（Render 文件系统只读）
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const app = express();
const PORT = process.env.PORT || 3000;

// ============ 飞书配置（从环境变量读取） ============
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_SPREADSHEET_URL = process.env.FEISHU_SPREADSHEET_URL || '';
const FEISHU_CLASS_SHEETS_RAW = process.env.FEISHU_CLASS_SHEETS || '{}';

let FEISHU_CLASS_SHEETS = {};
try { FEISHU_CLASS_SHEETS = JSON.parse(FEISHU_CLASS_SHEETS_RAW); } catch (e) {}

const FEISHU_ENABLED = !!(FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_SPREADSHEET_URL);
const SPREADSHEET_TOKEN = FEISHU_SPREADSHEET_URL.split('/').pop();
const SUMMARY = '出勤汇总';

console.log('飞书同步:', FEISHU_ENABLED ? '已启用' : '未配置（仅本地保存）');
if (FEISHU_ENABLED) console.log('飞书表格:', FEISHU_SPREADSHEET_URL);

// ============ 飞书 API 封装 ============
async function feishuHttp(method, urlPath, body, token) {
  const url = 'https://open.feishu.cn' + urlPath;
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('飞书API返回非JSON: ' + text.slice(0, 200)); }
  if (data.code !== 0) throw new Error('飞书API错误 ' + data.code + ': ' + (data.msg || ''));
  return data;
}

// token 缓存
let _tokenCache = { token: '', expireAt: 0 };
async function getTenantToken() {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expireAt - 300000) {
    return _tokenCache.token;
  }
  const data = await feishuHttp('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET
  });
  _tokenCache = { token: data.tenant_access_token, expireAt: now + (data.expire || 7200) * 1000 };
  console.log('✓ 飞书 token 已刷新');
  return _tokenCache.token;
}

// sheetId 缓存
let _sheetIdCache = {};
let _sheetIdLoaded = false;
async function loadSheetIds() {
  if (_sheetIdLoaded) return;
  try {
    const token = await getTenantToken();
    const data = await feishuHttp('GET', '/open-apis/sheets/v3/spreadsheets/' + SPREADSHEET_TOKEN + '/sheets/query', undefined, token);
    (data?.data?.sheets || []).forEach(s => { _sheetIdCache[s.title] = s.sheet_id; });
    _sheetIdLoaded = true;
    console.log('✓ 已加载', Object.keys(_sheetIdCache).length, '个工作表');
  } catch (e) { console.error('⚠ 加载工作表列表失败:', e.message.slice(0, 100)); }
}
async function getSheetId(sheetName) {
  if (!_sheetIdLoaded) await loadSheetIds();
  return _sheetIdCache[sheetName] || sheetName;
}

async function readRange(sheetName, range) {
  const token = await getTenantToken();
  const sheetId = await getSheetId(sheetName);
  const a1 = encodeURIComponent(sheetId + '!' + (range.includes(':') ? range : range + ':' + range));
  const data = await feishuHttp('GET', '/open-apis/sheets/v2/spreadsheets/' + SPREADSHEET_TOKEN + '/values/' + a1, undefined, token);
  return (data?.data?.valueRange?.values || []).map(row => (row || []).map(c => (c !== undefined && c !== null) ? String(c) : ''));
}

async function writeCells(sheetName, range, values) {
  const token = await getTenantToken();
  const sheetId = await getSheetId(sheetName);
  const a1 = sheetId + '!' + (range.includes(':') ? range : range + ':' + range);
  const normalized = values.map(row => row.map(c => (c && typeof c === 'object' && 'value' in c) ? c.value : c));
  await feishuHttp('PUT', '/open-apis/sheets/v2/spreadsheets/' + SPREADSHEET_TOKEN + '/values', {
    valueRange: { range: a1, values: normalized }
  }, token);
}

// ============ 工具函数 ============
function colToLetter(n) {
  let s = ''; n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function normDate(d) {
  if (Array.isArray(d)) return String(d[0]).slice(0, 10);
  return String(d || '').slice(0, 10);
}
const WD = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
const SN = { 0: '0102节', 1: '0304节', 2: '0506节', 3: '0708节' };
const STATUS_SYMBOLS = { present: '✓', absent: '❌', late: '▲', leave: '〇' };

// ============ 同步逻辑 ============
async function getNextRow() {
  const data = await readRange(SUMMARY, 'A2:A200');
  let occupied = 1;
  data.forEach((row, i) => { if (row && row[0]) occupied = Math.max(occupied, i + 2); });
  return occupied + 1;
}

async function findMatchingRow(record) {
  const w = '第' + record.weekNum + '周';
  const d = normDate(record.date);
  const data = await readRange(SUMMARY, 'A2:E120');
  for (let i = 0; i < data.length; i++) {
    const r = data[i] || [];
    if (r[0] === w && r[1] === d && r[2] === (WD[record.weekday] || '') && r[3] === (SN[record.session] || '') && r[4] === record.className) return i + 2;
  }
  return null;
}

async function pushToClassSheet(record) {
  const cfg = FEISHU_CLASS_SHEETS[record.className];
  if (!cfg) return;
  const sheet = cfg.name || record.className;
  const weekLabel = '第' + record.weekNum + '周(' + normDate(record.date).slice(5) + ')';
  const statuses = record.statuses || {};

  const hdr = await readRange(sheet, 'A1:Z1');
  const hdrRow = (hdr[0] || []);
  let weekCol = hdrRow.indexOf(weekLabel);
  let maxCol = 3;
  hdrRow.forEach((v, i) => { if (v) maxCol = Math.max(maxCol, i + 1); });
  if (weekCol < 0) {
    weekCol = maxCol;
    await writeCells(sheet, colToLetter(weekCol) + '1', [[weekLabel]]);
  }

  const names = await readRange(sheet, 'C2:C200');
  const cells = names.map(row => {
    const name = ((row && row[0]) || '').trim();
    const st = statuses[name];
    return [st ? (STATUS_SYMBOLS[st] || '') : ''];
  });
  if (cells.length) {
    const letter = colToLetter(weekCol);
    await writeCells(sheet, letter + '2:' + letter + (1 + cells.length), cells);
  }
}

async function pushToFeishu(record) {
  const vals = [
    '第' + record.weekNum + '周', normDate(record.date), WD[record.weekday] || '', SN[record.session] || '',
    record.className, record.courseName, record.room, record.teacher,
    record.totalCount, record.presentCount, record.absentCount, record.lateCount, record.leaveCount,
    record.absentNames || '', record.lateNames || '', record.leaveNames || ''
  ];
  const existingRow = await findMatchingRow(record);
  const rowNum = existingRow || (await getNextRow());
  await writeCells(SUMMARY, 'A' + rowNum + ':P' + rowNum, [vals]);
  await pushToClassSheet(record);
}

// 并发锁
let syncMutex = Promise.resolve();
function runSyncExclusive(fn) { const p = syncMutex.then(fn); syncMutex = p.catch(() => {}); return p; }

// 内存同步队列（Render 文件系统只读，不用文件）
let syncQueue = [];

// ============ 中间件 ============
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ API 端点 ============
app.get('/health', (req, res) => {
  res.json({ ok: true, feishu: FEISHU_ENABLED });
});

app.get('/sync-status', (req, res) => {
  res.json({ pending: syncQueue.length });
});

app.post('/sync', async (req, res) => {
  const record = req.body;
  if (!record?.id) return res.status(400).json({ error: '无效数据' });

  if (!FEISHU_ENABLED) {
    return res.json({ ok: true, synced: false, pending: 0, error: '飞书未配置' });
  }

  if (!syncQueue.find(r => r.id === record.id)) syncQueue.push({ ...record, synced: false });

  try {
    await runSyncExclusive(() => pushToFeishu(record));
    syncQueue = syncQueue.filter(r => r.id !== record.id);
    console.log('✓ 已推送到飞书:', record.className, record.courseName);
    return res.json({ ok: true, synced: true, pending: syncQueue.length });
  } catch (e) {
    console.error('云端推送失败:', e.message.slice(0, 100));
    return res.json({ ok: true, synced: false, pending: syncQueue.length, error: e.message });
  }
});

app.post('/retry-pending', async (req, res) => {
  const pending = [...syncQueue];
  if (pending.length === 0) return res.json({ ok: true, retried: 0, success: 0, failed: 0 });
  let success = 0, failed = 0;
  for (const record of pending) {
    try {
      await runSyncExclusive(() => pushToFeishu(record));
      syncQueue = syncQueue.filter(r => r.id !== record.id);
      success++;
    } catch (e) { failed++; }
  }
  res.json({ ok: true, retried: pending.length, success, failed });
});

// ============ Edge TTS 语音合成 ============
try {
  const { EdgeTTS } = require('node-edge-tts');
  const ttsClient = new EdgeTTS({ voice: 'zh-CN-XiaoxiaoNeural', rate: '-10%', pitch: '+5Hz' });

  app.get('/tts', async (req, res) => {
    const text = req.query.text;
    if (!text) return res.status(400).json({ error: '缺少text参数' });
    const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`);
    try {
      await ttsClient.ttsPromise(text, tmpFile);
      if (!fs.existsSync(tmpFile)) throw new Error('TTS 输出文件未生成');
      const audio = fs.readFileSync(tmpFile);
      if (audio.length < 200) throw new Error('TTS 音频过短');
      res.set('Content-Type', 'audio/mp3');
      res.send(audio);
    } catch (e) {
      console.error('[TTS]', e.message);
      res.status(503).json({ error: e.message });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  });
  console.log('✓ TTS 语音合成已启用');
} catch (e) {
  console.log('⚠ TTS 未启用:', e.message);
}

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`课栈助手运行在端口 ${PORT}`);
  console.log(`访问地址: http://localhost:${PORT}`);
});
