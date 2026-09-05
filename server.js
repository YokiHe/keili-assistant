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

// ============ 同步逻辑 ============
async function getNextRow(sheetName = SUMMARY) {
  const data = await readRange(sheetName, 'A2:A200');
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

// 课堂表现列文本：李晨（发言 4）、卢琴（扣分 2）、张三（未交手机）
function buildPerfText(performances) {
  if (!performances) return '';
  const parts = [];
  for (const [name, p] of Object.entries(performances)) {
    if (!p) continue;
    const tags = [];
    if ((p.speak || 0) > 0) tags.push('发言 ' + p.speak);
    if ((p.praise || 0) > 0) tags.push('加分 ' + p.praise);
    if ((p.discipline || 0) > 0) tags.push('扣分 ' + p.discipline);
    if ((p.nophone || 0) > 0) tags.push(p.nophone > 1 ? '未交手机 ' + p.nophone : '未交手机');
    if (tags.length) parts.push(name + '（' + tags.join('、') + '）');
  }
  return parts.join('、');
}

async function pushToFeishu(record) {
  const vals = [
    '第' + record.weekNum + '周', normDate(record.date), WD[record.weekday] || '', SN[record.session] || '',
    record.className, record.courseName, record.room, record.teacher,
    record.totalCount, record.presentCount, record.absentCount, record.lateCount, record.leaveCount,
    record.absentNames || '', record.lateNames || '', record.leaveNames || '',
    buildPerfText(record.performances)
  ];
  // 补表头（旧表格无"课堂表现"列）
  const qhdr = await readRange(SUMMARY, 'Q1:Q1');
  if (!qhdr[0] || !qhdr[0][0]) await writeCells(SUMMARY, 'Q1', [['课堂表现']]);
  const existingRow = await findMatchingRow(record);
  const rowNum = existingRow || (await getNextRow());
  await writeCells(SUMMARY, 'A' + rowNum + ':Q' + rowNum, [vals]);
}

// ============ 删除飞书中的点名记录 ============
// 删除维度（行/列）：实测 startIndex/endIndex 为 1-based 闭区间
async function deleteDimension(sheetName, majorDimension, startIndex, endIndex) {
  const token = await getTenantToken();
  const sheetId = await getSheetId(sheetName);
  await feishuHttp('DELETE', '/open-apis/sheets/v2/spreadsheets/' + SPREADSHEET_TOKEN + '/dimension_range', {
    dimension: { sheetId, majorDimension, startIndex, endIndex }
  }, token);
}

// 定位并删除汇总表对应行
async function deleteFromFeishu(record) {
  const results = { summary: false };
  const rowNum = await findMatchingRow(record);
  if (rowNum) {
    // 实测该接口 startIndex/endIndex 为 1-based 闭区间：起止相同即删除该行
    await deleteDimension(SUMMARY, 'ROWS', rowNum, rowNum);
    results.summary = true;
  }
  return results;
}

// 并发锁
let syncMutex = Promise.resolve();
function runSyncExclusive(fn) { const p = syncMutex.then(fn); syncMutex = p.catch(() => {}); return p; }

// 内存同步队列（Render 文件系统只读，不用文件）
let syncQueue = [];

// ============ 中间件 ============
// 允许跨域（前端可能用其他静态服务打开，后端仅本机/自有服务）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '80mb' }));
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

// ============ 作业文件上传到飞书云盘 ============
const HW_ROOT_NAME = '课粒作业';
const FEISHU_HW_FOLDER = process.env.FEISHU_HW_FOLDER || '';
const _hwFolderCache = {};

async function getRootFolderToken() {
  if (_hwFolderCache.root) return _hwFolderCache.root;
  const token = await getTenantToken();
  const data = await feishuHttp('GET', '/open-apis/drive/explorer/v2/root_folder/meta', undefined, token);
  const rootToken = data?.data?.token;
  if (!rootToken) throw new Error('无法获取云空间根目录');
  _hwFolderCache.root = rootToken;
  return rootToken;
}

async function ensureFolder(parentToken, name) {
  const key = parentToken + '/' + name;
  if (_hwFolderCache[key]) return _hwFolderCache[key];
  const token = await getTenantToken();
  // v2 explorer 接口：父目录 token 在路径中，body 用 title
  const data = await feishuHttp('POST', '/open-apis/drive/explorer/v2/folder/' + encodeURIComponent(parentToken), { title: name }, token);
  const t = data?.data?.token;
  if (!t) throw new Error('创建文件夹失败');
  _hwFolderCache[key] = t;
  return t;
}

async function uploadHwFileToFeishu({ className, hwTitle, fileName, base64, date }) {
  const token = await getTenantToken();
  const hwRoot = FEISHU_HW_FOLDER || await getRootFolderToken();
  const classFolder = await ensureFolder(hwRoot, HW_ROOT_NAME);
  const clsFolder = await ensureFolder(classFolder, className);
  // 按上传日期归档（前端传本地日期，避免服务器时区差一天）
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().split('T')[0];
  const dayFolder = await ensureFolder(clsFolder, day);
  const buf = Buffer.from(base64, 'base64');
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'explorer');
  form.append('parent_node', dayFolder);
  form.append('size', String(buf.length));
  form.append('file', new Blob([buf]), fileName);
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: form
  });
  const data = JSON.parse(await res.text());
  if (data.code !== 0) throw new Error('飞书上传错误 ' + data.code + ': ' + data.msg);
  const fileToken = data?.data?.file_token;
  let origin = 'https://feishu.cn';
  try { origin = new URL(FEISHU_SPREADSHEET_URL).origin; } catch (e) {}
  return { fileToken, url: origin + '/file/' + fileToken };
}

app.post('/hw-upload', async (req, res) => {
  const { className, hwTitle, fileName, date, data: b64 } = req.body || {};
  if (!className || !fileName || !b64) return res.status(400).json({ error: '无效数据' });
  if (!FEISHU_ENABLED) return res.status(500).json({ ok: false, error: '飞书未配置' });
  try {
    const result = await runSyncExclusive(() => uploadHwFileToFeishu({ className, hwTitle, fileName, date, base64: b64 }));
    console.log('✓ 作业文件已上传飞书云盘:', className + '/' + (date || '') + '/' + fileName);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('✗ 作业上传失败:', fileName, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除作业：同步删除飞书「作业汇总」表对应行
app.post('/hw-delete', async (req, res) => {
  const p = req.body || {};
  if (!p.className || !p.title || !p.date) return res.status(400).json({ error: '无效数据' });
  if (!FEISHU_ENABLED) return res.status(500).json({ ok: false, error: '未配置飞书同步' });
  try {
    const result = await runSyncExclusive(async () => {
      await ensureHwSheet();
      const rowNum = await findHwMatchingRow(p);
      if (!rowNum) return { found: false };
      // 实测该接口 1-based 闭区间：起止相同即删除该行
      await deleteDimension(HW_SUMMARY, 'ROWS', rowNum, rowNum);
      return { found: true };
    });
    console.log('✓ 已删除飞书作业行:', p.className, p.title, JSON.stringify(result));
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('✗ 删除飞书作业行失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除点名记录：同步删除飞书汇总表对应行 + 班级子表对应列，并移出待同步队列

// ============ 作业记录同步到飞书 ============
const HW_SUMMARY = '作业汇总';

// 确保作业汇总工作表存在（不存在则创建并写表头），返回 sheetId
async function ensureHwSheet() {
  await loadSheetIds();
  if (_sheetIdCache[HW_SUMMARY]) return _sheetIdCache[HW_SUMMARY];
  const token = await getTenantToken();
  const data = await feishuHttp('POST', '/open-apis/sheets/v3/spreadsheets/' + SPREADSHEET_TOKEN + '/sheets', { title: HW_SUMMARY, index: 1 }, token);
  const sheetId = data?.data?.sheet?.sheet_id;
  if (!sheetId) throw new Error('创建作业汇总表失败');
  _sheetIdCache[HW_SUMMARY] = sheetId;
  await writeCells(HW_SUMMARY, 'A1:H1', [['周次', '日期', '班级', '作业名称', '应交人数', '已交人数', '未交人数', '未交名单']]);
  console.log('✓ 已创建工作表 [作业汇总]');
  return sheetId;
}

// 按（日期/班级/作业名）定位已有行
async function findHwMatchingRow(payload) {
  const data = await readRange(HW_SUMMARY, 'A2:D200');
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (r[1] === payload.date && r[2] === payload.className && r[3] === payload.title) return i + 2;
  }
  return null;
}

// 作业同步主流程：更新旧记录或追加新行
async function pushHwToFeishu(payload) {
  await ensureHwSheet();
  const vals = [
    '第' + payload.week + '周', payload.date, payload.className, payload.title,
    payload.total, payload.submittedCount, payload.total - payload.submittedCount, payload.missingNames || ''
  ];
  const existingRow = await findHwMatchingRow(payload);
  const rowNum = existingRow || (await getNextRow(HW_SUMMARY));
  await writeCells(HW_SUMMARY, 'A' + rowNum + ':H' + rowNum, [vals]);
  return { updated: !!existingRow };
}

app.post('/hw-sync', async (req, res) => {
  const p = req.body || {};
  if (!p.className || !p.title || !p.date) return res.status(400).json({ error: '无效数据' });
  if (!FEISHU_ENABLED) return res.status(500).json({ ok: false, error: '未配置飞书同步' });
  try {
    const result = await runSyncExclusive(() => pushHwToFeishu(p));
    console.log('✓ 作业已同步飞书:', p.className, p.title, result.updated ? '(更新)' : '(新增)');
    res.json({ ok: true, updated: result.updated });
  } catch (e) {
    console.error('✗ 作业同步失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/delete-record', async (req, res) => {
  const record = req.body;
  if (!record?.weekNum || !record?.date || !record?.className) return res.status(400).json({ error: '无效数据' });
  syncQueue = syncQueue.filter(r => r.id !== record.id);
  if (!FEISHU_ENABLED) return res.json({ ok: true, summary: false, skipped: true });
  try {
    const result = await runSyncExclusive(() => deleteFromFeishu(record));
    console.log('✓ 已删除飞书记录:', record.className, normDate(record.date), JSON.stringify(result));
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('✗ 删除飞书记录失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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
