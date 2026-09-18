'use strict';

/* 声字幕 Web/PWA —— 与 Android 版同一套协议：麦克风 -> 16k PCM -> 百炼 WS 流式 ASR -> 字幕。
   浏览器无法自定义 WebSocket 鉴权头，因此 Key 通过 ?api_key= 传参（已实测百炼支持）。 */

var TARGET_RATE = 16000;
var FRAME_BYTES = 3200; // 100ms
var DEF_MODEL = 'qwen-audio-3.0-asr-flash-streaming';
var DEF_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
var MAX_LINES = 400;
var MAX_RECONNECT = 6;
var MAX_QUEUE = 150;
var START_TIMEOUT_MS = 10000;

/* ------------------------------ 设置 ------------------------------ */
var DEFAULTS = {
  key: '', model: DEF_MODEL, url: DEF_URL, language: 'auto', fontSp: 26,
  showTimestamp: false, showPartial: true, keepScreenOn: true,
  silenceMs: 1000, heartbeat: true, autoReconnect: true, inputSource: 'mic'
};
var prefs = (function () {
  var d = {}, k;
  for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) d[k] = DEFAULTS[k];
  try {
    var raw = localStorage.getItem('voicesub');
    if (raw) {
      var o = JSON.parse(raw);
      for (k in o) if (d.hasOwnProperty(k) && o[k] !== null && o[k] !== undefined) d[k] = o[k];
    }
  } catch (e) { }
  return d;
})();
function savePrefs() { try { localStorage.setItem('voicesub', JSON.stringify(prefs)); } catch (e) { } }
function langHints(c) {
  if (c === 'zh') return ['zh'];
  if (c === 'en') return ['en'];
  if (c === 'zh_en') return ['zh', 'en'];
  if (c === 'ja') return ['ja'];
  if (c === 'ko') return ['ko'];
  return null;
}
function langLabel(c) {
  var m = { auto: '自动检测', zh: '中文', en: 'English', zh_en: '中英混合', ja: '日本語', ko: '한국어' };
  return m[c] || '自动检测';
}

/* ------------------------------ PCM ------------------------------ */
function floatTo16(f32) {
  var out = new Int16Array(f32.length), i, s;
  for (i = 0; i < f32.length; i++) {
    s = f32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function Resampler(inRate, outRate) {
  this.step = inRate / outRate;
  this.prefilter = this.step >= 2;
  this.pos = 0;
  this.carry = new Int16Array(0);
}
Resampler.prototype.process = function (samples) {
  var raw = new Int16Array(this.carry.length + samples.length), i;
  raw.set(this.carry, 0);
  raw.set(samples, this.carry.length);
  var src = raw;
  if (this.prefilter) {
    var f = new Int16Array(raw.length);
    for (i = 0; i < raw.length; i++) {
      var a = raw[i > 0 ? i - 1 : 0], b = raw[i], c = raw[i < raw.length - 1 ? i + 1 : i];
      f[i] = ((a + b + c) / 3) | 0;
    }
    src = f;
  }
  var out = new Int16Array(Math.ceil(src.length / this.step) + 4), n = 0;
  for (; ;) {
    var i0 = this.pos | 0;
    if (i0 + 1 >= src.length) break;
    var fr = this.pos - i0;
    var v = src[i0] + (src[i0 + 1] - src[i0]) * fr;
    out[n++] = v < -32768 ? -32768 : (v > 32767 ? 32767 : Math.round(v));
    this.pos += this.step;
  }
  var consumed = Math.floor(this.pos);
  if (consumed > raw.length) consumed = raw.length;
  this.carry = raw.slice(consumed);
  this.pos -= consumed;
  return out.slice(0, n);
};

function FrameMuxer(sink) { this.buf = new Int16Array(0); this.sink = sink; }
FrameMuxer.prototype.push = function (i16) {
  var all = new Int16Array(this.buf.length + i16.length);
  all.set(this.buf, 0);
  all.set(i16, this.buf.length);
  var need = FRAME_BYTES / 2, off = 0;
  while (all.length - off >= need) {
    var bytes = new Uint8Array(FRAME_BYTES);
    new Int16Array(bytes.buffer).set(all.subarray(off, off + need));
    this.sink(bytes);
    off += need;
  }
  this.buf = all.slice(off);
};

/* --------------------------- 音频来源 --------------------------- */
function MicSource() { this.running = false; }
MicSource.prototype.label = function () { return '麦克风'; };
MicSource.prototype.start = function (sink) {
  var self = this;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.reject(new Error('当前环境不支持麦克风（需要 HTTPS 并用 Safari/Chrome 打开）'));
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  }).then(function (stream) {
    self.stream = stream;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    self.ctx = new Ctx();
    var go = function () {
      var src = self.ctx.createMediaStreamSource(stream);
      var proc = self.ctx.createScriptProcessor(4096, 1, 1);
      var gain = self.ctx.createGain();
      gain.gain.value = 0;
      var rs = new Resampler(self.ctx.sampleRate, TARGET_RATE);
      var mux = new FrameMuxer(sink);
      proc.onaudioprocess = function (e) {
        if (!self.running) return;
        var ds = rs.process(floatTo16(e.inputBuffer.getChannelData(0)));
        if (ds.length) mux.push(ds);
      };
      src.connect(proc);
      proc.connect(gain);
      gain.connect(self.ctx.destination);
      self.nodes = [src, proc, gain];
      self.running = true;
    };
    if (self.ctx.state === 'suspended' && self.ctx.resume) {
      return self.ctx.resume().then(go, go);
    }
    go();
  });
};
MicSource.prototype.stop = function () {
  this.running = false;
  var i;
  if (this.nodes) {
    for (i = 0; i < this.nodes.length; i++) { try { this.nodes[i].disconnect(); } catch (e) { } }
    this.nodes = null;
  }
  if (this.stream) {
    var t = this.stream.getTracks();
    for (i = 0; i < t.length; i++) { try { t[i].stop(); } catch (e) { } }
    this.stream = null;
  }
  if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (e) { } }
  this.ctx = null;
};

function SampleSource(url) { this.url = url; this.running = false; }
SampleSource.prototype.label = function () { return '示例音频'; };
SampleSource.prototype.start = function (sink) {
  var self = this;
  var Ctx = window.AudioContext || window.webkitAudioContext;
  self.ctx = new Ctx();
  return fetch(self.url).then(function (r) {
    if (!r.ok) throw new Error('示例音频加载失败');
    return r.arrayBuffer();
  }).then(function (ab) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var ok = function (b) { if (!settled) { settled = true; resolve(b); } };
      var bad = function (e) { if (!settled) { settled = true; reject(e || new Error('示例音频解码失败')); } };
      var p = self.ctx.decodeAudioData(ab, ok, bad);
      if (p && p.then) p.then(ok, bad);
    });
  }).then(function (buf) {
    var rs = new Resampler(buf.sampleRate, TARGET_RATE);
    var pcm = rs.process(floatTo16(buf.getChannelData(0)));
    self.running = true;
    self.pcm = pcm;
    self.loop(sink);
  });
};
SampleSource.prototype.loop = function (sink) {
  var self = this, per = FRAME_BYTES / 2, off = 0, silence = 9;
  function step() {
    if (!self.running) return;
    if (off < self.pcm.length) {
      var chunk = self.pcm.subarray(off, Math.min(off + per, self.pcm.length));
      var bytes = new Uint8Array(chunk.length * 2);
      new Int16Array(bytes.buffer).set(chunk);
      sink(bytes);
      off += per;
    } else if (silence > 0) {
      silence--;
      sink(new Uint8Array(FRAME_BYTES));
    } else {
      off = 0;
      silence = 9;
    }
    self.timer = setTimeout(step, 100);
  }
  step();
};
SampleSource.prototype.stop = function () {
  this.running = false;
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (e) { } }
  this.ctx = null;
};

/* --------------------------- ASR 客户端 --------------------------- */
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function AsrClient(cfg, cb) {
  this.cfg = cfg;
  this.cb = cb;
  this.pending = [];
  this.started = false;
  this.finished = false;
  this.closing = false;
  this.opened = false;
  this.taskId = uuid();
  this.timer = null;
}
AsrClient.prototype.buildUrl = function () {
  var sep = this.cfg.url.indexOf('?') >= 0 ? '&' : '?';
  return this.cfg.url + sep + 'api_key=' + encodeURIComponent(this.cfg.key);
};
AsrClient.prototype.connect = function () {
  var self = this, u;
  try { u = new URL(this.buildUrl()); } catch (e) { this.cb.onFatalError('服务地址无效：' + e.message); return; }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') { this.cb.onFatalError('服务地址必须以 wss:// 开头'); return; }
  if (u.protocol === 'ws:' && location.protocol === 'https:') { this.cb.onFatalError('HTTPS 页面不能连接 ws://，请改用 wss://'); return; }
  try { this.ws = new WebSocket(u.toString()); } catch (e) { this.cb.onFatalError('无法建立连接：' + e.message); return; }
  this.ws.binaryType = 'arraybuffer';
  this.ws.onopen = function () {
    self.opened = true;
    self.cb.onOpen();
    self.armWatchdog();
    try { self.ws.send(JSON.stringify(self.runTask())); }
    catch (e) { self.cb.onTransportError('发送请求失败'); }
  };
  this.ws.onmessage = function (ev) { self.handle(ev.data); };
  this.ws.onclose = function (ev) {
    self.clearWatchdog();
    if (self.closing) return;
    if (self.finished) { self.cb.onFinished(); return; }
    if (!self.opened) { self.cb.onFatalError('连接被拒绝（请检查 API Key 与网络；浏览器无法读取具体状态码）'); return; }
    self.cb.onTransportError('连接被断开（' + ev.code + '）');
  };
  this.ws.onerror = function () { };
};
AsrClient.prototype.armWatchdog = function () {
  var self = this;
  this.clearWatchdog();
  this.timer = setTimeout(function () {
    if (self.started || self.finished || self.closing) return;
    self.closing = true;
    try { self.ws.close(); } catch (e) { }
    self.cb.onTransportError('服务端无响应（10 秒未开始识别）');
  }, START_TIMEOUT_MS);
};
AsrClient.prototype.clearWatchdog = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
};
AsrClient.prototype.runTask = function () {
  var params = {
    format: 'pcm',
    sample_rate: TARGET_RATE,
    heartbeat: !!this.cfg.heartbeat,
    semantic_punctuation_enabled: false,
    max_sentence_silence: this.cfg.silenceMs
  };
  var hints = langHints(this.cfg.language);
  if (hints) params.language_hints = hints;
  return {
    header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio', task: 'asr', function: 'recognition',
      model: this.cfg.model, input: {}, parameters: params
    }
  };
};
AsrClient.prototype.sendAudio = function (bytes) {
  if (this.closing || !bytes || !bytes.length) return;
  if (!this.started || !this.ws || this.ws.readyState !== 1) {
    this.pending.push(bytes);
    while (this.pending.length > MAX_QUEUE) this.pending.shift();
    return;
  }
  try { this.ws.send(bytes); } catch (e) { }
};
AsrClient.prototype.onTaskStarted = function () {
  this.started = true;
  while (this.pending.length) {
    var b = this.pending.shift();
    if (!b || !b.length) continue;
    try { this.ws.send(b); } catch (e) { break; }
  }
};
AsrClient.prototype.handle = function (text) {
  var msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  var h = msg.header || {};
  var ev = h.event;
  if (ev === 'task-started') {
    this.onTaskStarted();
    this.clearWatchdog();
    this.cb.onStarted();
  } else if (ev === 'result-generated') {
    var out = (msg.payload || {}).output || {};
    var s = out.sentence || {};
    if (s.heartbeat) return;
    if (s.sentence_end) this.cb.onSentence(s.text || '', s.begin_time | 0, s.end_time | 0);
    else if ((s.text && s.text.length) || s.sentence_begin) this.cb.onPartial(s.text || '', s.begin_time | 0);
  } else if (ev === 'task-finished') {
    this.finished = true;
    this.clearWatchdog();
    this.cb.onFinished();
  } else if (ev === 'task-failed') {
    this.clearWatchdog();
    this.cb.onFailed(h.error_code || '', h.error_message || '');
  }
};
AsrClient.prototype.finish = function () {
  if (this.closing) return;
  this.closing = true;
  this.clearWatchdog();
  try {
    if (this.ws && this.started && !this.finished && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
        payload: { input: {} }
      }));
    }
  } catch (e) { }
  var self = this;
  setTimeout(function () { try { self.ws.close(1000, 'client stop'); } catch (e) { } }, 250);
};
AsrClient.prototype.abort = function () {
  this.closing = true;
  this.clearWatchdog();
  try { this.ws.close(); } catch (e) { }
};

/* ----------------------------- 会话 ----------------------------- */
var session = {
  state: 'idle', detail: '', error: null, running: false,
  lines: [], partial: '', bytes: 0, startedAt: 0, frozenElapsed: 0,
  attempts: 0, src: null, client: null, cfg: null, reconTimer: null
};

function elapsed() {
  return session.running ? (Date.now() - session.startedAt) : session.frozenElapsed;
}
function audioMs() { return session.bytes * 1000 / (2 * TARGET_RATE); }
function clock(ms) {
  var t = Math.max(0, Math.floor(ms / 1000));
  var m = Math.floor(t / 60), s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
function stamp(ms) { return clock(ms); }

function sessionStart(cfg, src) {
  if (session.running) return;
  session.cfg = cfg;
  session.src = src;
  session.attempts = 0;
  session.bytes = 0;
  session.error = null;
  session.detail = '';
  session.partial = '';
  session.frozenElapsed = 0;
  session.startedAt = Date.now();
  session.running = true;
  setState('connecting', '');
  var sink = function (bytes) {
    session.bytes += bytes.length;
    if (session.client) session.client.sendAudio(bytes);
    if (!sink.last || Date.now() - sink.last > 300) { sink.last = Date.now(); renderStats(); }
  };
  Promise.resolve()
    .then(function () { return src.start(sink); })
    .then(function () { connectClient(); })
    .catch(function (e) { session.running = false; sessionFail((e && e.message) ? e.message : '录音启动失败'); });
}

function connectClient() {
  if (!session.running) return;
  var client = new AsrClient(session.cfg, {
    onOpen: function () { },
    onStarted: function () { session.attempts = 0; if (session.running) setState('listening', ''); },
    onPartial: function (t) { if (!session.running) return; session.partial = t; renderSubs(false); },
    onSentence: function (t, b, e) {
      if (!session.running) return;
      session.partial = '';
      addSentence(t, b, e);
      renderSubs(true);
    },
    onFinished: function () { if (session.running) onTransport('识别任务已结束'); },
    onFailed: function (code, msg) {
      if (!session.running) return;
      sessionFail('识别失败：' + (msg || code || '未知错误'));
    },
    onTransportError: function (msg) { if (session.running) onTransport(msg); },
    onFatalError: function (msg) { if (session.running) sessionFail(msg); }
  });
  session.client = client;
  client.connect();
}

function addSentence(text, begin, end) {
  if (!text || !text.trim().length) return;
  var last = session.lines[session.lines.length - 1];
  if (last && last.text === text && last.end === end) return;
  session.lines.push({ text: text, begin: begin, end: end });
  while (session.lines.length > MAX_LINES) session.lines.shift();
}

function onTransport(msg) {
  if (!session.running) return;
  var old = session.client;
  session.client = null;
  if (old) old.abort();
  if (!session.cfg.autoReconnect || session.attempts >= MAX_RECONNECT) { sessionFail(msg); return; }
  session.attempts++;
  setState('reconnecting', msg);
  var delay = Math.min(8000, 700 * Math.pow(2, Math.min(session.attempts - 1, 4)));
  clearTimeout(session.reconTimer);
  session.reconTimer = setTimeout(function () { if (session.running) connectClient(); }, delay);
}

function sessionStop() {
  if (!session.running) return;
  session.running = false;
  session.frozenElapsed = Date.now() - session.startedAt;
  clearTimeout(session.reconTimer);
  var src = session.src;
  session.src = null;
  if (src) { try { src.stop(); } catch (e) { } }
  var c = session.client;
  session.client = null;
  if (c) c.finish();
  session.partial = '';
  releaseWake();
  setState('idle', '');
  renderSubs(true);
}

function sessionFail(msg) {
  session.running = false;
  session.frozenElapsed = Date.now() - session.startedAt;
  clearTimeout(session.reconTimer);
  session.error = msg;
  session.partial = '';
  var c = session.client;
  session.client = null;
  if (c) c.abort();
  var src = session.src;
  session.src = null;
  if (src) { try { src.stop(); } catch (e) { } }
  releaseWake();
  setState('error', msg);
  renderSubs(true);
  toast(msg);
}

/* ------------------------------ UI ------------------------------ */
var $ = function (id) { return document.getElementById(id); };
var wakeLock = null;
var uiTimer = null;
var toastTimer = null;

function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
}

function setState(st, detail) {
  session.state = st;
  session.detail = detail || '';
  renderStatus();
  renderToggle();
}

function renderStatus() {
  var dot = $('dot');
  var st = session.state;
  var cls = 'dot ', txt;
  if (st === 'connecting') { cls += 'busy'; txt = '连接中…'; }
  else if (st === 'listening') { cls += 'live'; txt = '聆听中'; }
  else if (st === 'reconnecting') { cls += 'busy'; txt = '网络波动，重连中… ' + session.detail; }
  else if (st === 'error') { cls += 'error'; txt = session.error || '出错'; }
  else { cls += 'idle'; txt = '未开始'; }
  dot.className = cls;
  $('statusText').textContent = txt;
  $('timer').textContent = clock(elapsed());
}

function renderToggle() {
  var b = $('btnToggle');
  if (session.running) { b.textContent = '停止'; b.classList.add('stop'); }
  else { b.textContent = '开始聆听'; b.classList.remove('stop'); }
}

function renderStats() {
  var n = 0, i;
  for (i = 0; i < session.lines.length; i++) n += session.lines[i].text.length;
  if (prefs.showPartial) n += session.partial.length;
  $('stats').textContent = '已转写 ' + n + ' 字 · 已听 ' + clock(audioMs());
}

var lastLineCount = -1;
function renderSubs(force) {
  var box = $('subs');
  if (force || session.lines.length !== lastLineCount) {
    lastLineCount = session.lines.length;
    var html = '', i;
    for (i = 0; i < session.lines.length; i++) {
      var l = session.lines[i];
      html += '<div class="line final">' +
        (prefs.showTimestamp ? '<span class="t">' + stamp(l.begin) + '</span>' : '') +
        '<span class="x"></span></div>';
    }
    if (prefs.showPartial && session.partial.length) {
      html += '<div class="line partial"><span class="x"></span></div>';
    }
    box.innerHTML = html || '';
    // 文本用 textContent 写入，避免任何 HTML 注入
    var nodes = box.querySelectorAll('.line .x'), k = 0;
    for (i = 0; i < session.lines.length; i++) nodes[k++].textContent = session.lines[i].text;
    if (prefs.showPartial && session.partial.length) nodes[k].textContent = session.partial;
  } else {
    var p = box.querySelector('.line.partial');
    if (prefs.showPartial && session.partial.length) {
      if (!p) { renderSubs(true); } else { p.querySelector('.x').textContent = session.partial; }
    } else if (p) {
      p.parentNode.removeChild(p);
    }
  }
  var cur = box.querySelector('.line.partial .x');
  if (cur && !cur.querySelector('.cursor')) {
    var c = document.createElement('span');
    c.className = 'cursor';
    c.textContent = '▍';
    cur.appendChild(c);
  }
  var empty = (!session.lines.length && (!prefs.showPartial || !session.partial.length));
  var hint = $('empty');
  if (hint) hint.classList.toggle('hidden', !empty);
  box.scrollTop = box.scrollHeight;
  renderStats();
}

function applyFont() {
  var nodes = document.querySelectorAll('.subs .x');
  for (var i = 0; i < nodes.length; i++) nodes[i].style.fontSize = prefs.fontSp + 'px';
}

function requestWake() {
  if (!prefs.keepScreenOn || !navigator.wakeLock || !navigator.wakeLock.request) return;
  try {
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }, function () { });
  } catch (e) { }
}
function releaseWake() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
}

function startAutoSave() {
  clearInterval(uiTimer);
  uiTimer = setInterval(function () {
    if (session.running) { $('timer').textContent = clock(elapsed()); renderStats(); }
  }, 500);
}

/* --------------------------- 事件绑定 --------------------------- */
document.addEventListener('DOMContentLoaded', function () {
  applyFont();
  renderStatus();
  renderToggle();
  renderSubs(true);
  startAutoSave();

  $('btnToggle').addEventListener('click', function () {
    if (session.running) { sessionStop(); return; }
    if (!prefs.key || !prefs.key.trim()) { toast('请先在「设置」中填写阿里云百炼 API Key'); openSheet(true); return; }
    if (!/^wss:\/\//.test(prefs.url.trim())) { toast('服务地址必须以 wss:// 开头'); openSheet(true); return; }
    var src;
    if (prefs.inputSource === 'sample') src = new SampleSource('sample_zh.wav');
    else src = new MicSource();
    requestWake();
    sessionStart({
      key: prefs.key.trim(), model: prefs.model.trim(), url: prefs.url.trim(),
      language: prefs.language, silenceMs: prefs.silenceMs,
      heartbeat: prefs.heartbeat, autoReconnect: prefs.autoReconnect
    }, src);
  });

  $('btnSettings').addEventListener('click', function () { openSheet(true); });
  $('btnClose').addEventListener('click', function () { openSheet(false); });
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) openSheet(false); });

  $('btnClear').addEventListener('click', function () {
    session.lines = [];
    session.partial = '';
    lastLineCount = -1;
    renderSubs(true);
    toast('已清空');
  });
  $('btnCopy').addEventListener('click', function () {
    var t = session.lines.map(function (l) { return l.text; }).join('');
    if (prefs.showPartial) t += session.partial;
    if (!t.trim()) { toast('还没有字幕内容'); return; }
    var done = function () { toast('已复制全部字幕'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t, done); });
    } else { fallbackCopy(t, done); }
  });
  $('btnFontMinus').addEventListener('click', function () { prefs.fontSp = Math.max(16, prefs.fontSp - 2); savePrefs(); applyFont(); });
  $('btnFontPlus').addEventListener('click', function () { prefs.fontSp = Math.min(40, prefs.fontSp + 2); savePrefs(); applyFont(); });
  $('chipMic').addEventListener('click', function () { setSource('mic'); });
  $('chipSample').addEventListener('click', function () { setSource('sample'); });
  $('chipLang').addEventListener('click', function () {
    var codes = ['auto', 'zh', 'en', 'zh_en', 'ja', 'ko'];
    var i = codes.indexOf(prefs.language);
    prefs.language = codes[(i + 1) % codes.length];
    savePrefs();
    $('chipLang').textContent = langLabel(prefs.language);
    toast('识别语言：' + langLabel(prefs.language));
  });

  bindSheet();
});

function fallbackCopy(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
  document.body.removeChild(ta);
}

function setSource(v) {
  if (v === prefs.inputSource) return;
  if (session.running) { sessionStop(); toast('已切换声音来源，请重新开始'); }
  prefs.inputSource = v;
  savePrefs();
  renderChips();
}

function renderChips() {
  var mic = prefs.inputSource !== 'sample';
  $('chipMic').classList.toggle('on', mic);
  $('chipSample').classList.toggle('on', !mic);
  $('chipLang').textContent = langLabel(prefs.language);
}

function openSheet(open) {
  $('sheet').classList.toggle('hidden', !open);
  if (open) fillSheet();
}

function fillSheet() {
  $('inKey').value = prefs.key || '';
  $('inModel').value = prefs.model || DEF_MODEL;
  $('inUrl').value = prefs.url || DEF_URL;
  $('inLang').value = prefs.language || 'auto';
  $('inFont').value = prefs.fontSp;
  $('inSilence').value = prefs.silenceMs;
  $('fontVal').textContent = prefs.fontSp + 'sp';
  $('silenceVal').textContent = prefs.silenceMs + 'ms';
  $('inTs').checked = !!prefs.showTimestamp;
  $('inPartial').checked = !!prefs.showPartial;
  $('inWake').checked = !!prefs.keepScreenOn;
  $('inHeartbeat').checked = !!prefs.heartbeat;
  $('inReconnect').checked = !!prefs.autoReconnect;
  $('testResult').classList.add('hidden');
  renderChips();
}

function readSheet() {
  prefs.key = $('inKey').value.trim();
  prefs.model = $('inModel').value.trim() || DEF_MODEL;
  prefs.url = $('inUrl').value.trim() || DEF_URL;
  prefs.language = $('inLang').value;
  prefs.fontSp = parseInt($('inFont').value, 10) || 26;
  prefs.silenceMs = parseInt($('inSilence').value, 10) || 1000;
  prefs.showTimestamp = $('inTs').checked;
  prefs.showPartial = $('inPartial').checked;
  prefs.keepScreenOn = $('inWake').checked;
  prefs.heartbeat = $('inHeartbeat').checked;
  prefs.autoReconnect = $('inReconnect').checked;
  savePrefs();
}

function bindSheet() {
  $('btnShowKey').addEventListener('click', function () {
    var f = $('inKey');
    var show = f.type === 'password';
    f.type = show ? 'text' : 'password';
    $('btnShowKey').textContent = show ? '隐藏' : '显示';
  });
  $('inFont').addEventListener('input', function () { $('fontVal').textContent = $('inFont').value + 'sp'; });
  $('inSilence').addEventListener('input', function () { $('silenceVal').textContent = $('inSilence').value + 'ms'; });
  $('btnSave').addEventListener('click', function () {
    readSheet();
    applyFont();
    renderSubs(true);
    renderChips();
    toast('已保存');
  });
  $('btnReset').addEventListener('click', function () {
    try { localStorage.removeItem('voicesub'); } catch (e) { }
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) prefs[k] = DEFAULTS[k];
    fillSheet();
    applyFont();
    renderSubs(true);
    toast('已恢复默认');
  });
  $('btnTest').addEventListener('click', function () {
    readSheet();
    testConnection();
  });
}

function testConnection() {
  var out = $('testResult');
  out.classList.remove('hidden', 'ok', 'bad');
  if (!prefs.key) {
    out.classList.add('bad');
    out.textContent = '请先填写 API Key';
    return;
  }
  out.textContent = '正在测试连接…';
  var client = new AsrClient({
    key: prefs.key, model: prefs.model, url: prefs.url, language: prefs.language,
    silenceMs: prefs.silenceMs, heartbeat: true, autoReconnect: false
  }, {
    onOpen: function () { },
    onStarted: function () { finishTest(true, '连接成功，Key 与模型可用'); },
    onPartial: function () { },
    onSentence: function () { },
    onFinished: function () { },
    onFailed: function (code, msg) { finishTest(false, '服务端拒绝：' + (msg || code)); },
    onTransportError: function (msg) { finishTest(false, msg); },
    onFatalError: function (msg) { finishTest(false, msg); }
  });
  var settled = false;
  var timer = setTimeout(function () { finishTest(false, '连接超时（12 秒）'); }, 12000);
  function finishTest(ok, msg) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { client.abort(); } catch (e) { }
    out.classList.remove('hidden');
    out.classList.add(ok ? 'ok' : 'bad');
    out.textContent = msg;
  }
  client.connect();
}
