/* ==========================================================================
 * store.js —— 本地持久化层（仅 localStorage，无后端、无登录）
 *
 * 数据结构：
 * {
 *   version: 1,
 *   vid: '视频 VID 或 demo',
 *   markers: [{ id, time, note, color, source, thumb, createdAt }],   source: manual | ai | voice
 *   ranges:  [{ id, start, end, note, color, createdAt }],
 *   subtitles: [{ id, start, end, text, createdAt }],   // AI 分段字幕（按画面内容生成）
 *   report:      { text, at, count },     // AI 复盘报告（4 模块）
 *   reportDraft: { text, at, count },     // AI 实验报告初稿（6 章，Markdown）
 *   loop:        { id, rate },            // A-B 循环：正在循环的区间 id + 倍速
 *   updatedAt: 时间戳
 * }
 *
 * 存储键按视频隔离：labmark.v1:<vid>，换视频不会串数据。
 * ========================================================================== */

window.LabStore = (function () {
  'use strict';

  var CFG = window.LABMARK_CONFIG || {};
  var PREFIX = CFG.storageKeyPrefix || 'labmark.v1';
  var PALETTE = CFG.palette || ['#2b7fd4'];
  var RATES = [0.5, 0.75, 1, 1.25, 1.5];

  /* 缩略图容量上限。
   * 一张 320px 宽的 JPEG 约 15~25KB，localStorage 单域名只有 5MB，
   * 而这里还存着报告正文，所以必须设两道闸：条数 + 总字节。
   * 超限时按 createdAt 从最旧的开始丢图（只丢图，笔记文字一律保留）。 */
  var THUMB_MAX_COUNT = 50;
  var THUMB_MAX_BYTES = 1600000;

  /** 该视频对应的存储键 */
  function keyOf(vid) {
    return PREFIX + ':' + (vid && String(vid).trim() ? String(vid).trim() : 'demo');
  }

  /** 空状态 */
  function emptyState(vid) {
    return {
      version: 1,
      vid: vid || '',
      markers: [],
      ranges: [],
      subtitles: [],
      report: null,
      reportDraft: null,
      loop: { id: '', rate: 1 },
      updatedAt: 0,
    };
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function pickColor(c) {
    return PALETTE.indexOf(c) >= 0 ? c : PALETTE[0];
  }

  /** 只接受内联的 data:image/jpeg|png，防止脏数据把整个列表带崩 */
  function pickThumb(v) {
    if (typeof v !== 'string' || v.length < 64) return '';
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(v)) return '';
    return v.length > 400000 ? '' : v;
  }

  /** 把任意来源的数据（本地缓存 / 导入文件）洗成可信结构，避免脏数据破坏渲染 */
  function normalize(raw, vid) {
    var state = emptyState(vid);
    if (!raw || typeof raw !== 'object') return state;

    if (Array.isArray(raw.markers)) {
      state.markers = raw.markers
        .filter(function (m) { return m && isNum(m.time) && m.time >= 0; })
        .map(function (m, i) {
          return {
            id: typeof m.id === 'string' && m.id ? m.id : 'm' + i + '_' + Math.random().toString(36).slice(2, 7),
            time: Math.round(m.time * 100) / 100,
            note: typeof m.note === 'string' ? m.note.slice(0, 500) : '',
            color: pickColor(m.color),
            source: m.source === 'ai' ? 'ai' : (m.source === 'voice' ? 'voice' : 'manual'),
            thumb: pickThumb(m.thumb),
            createdAt: isNum(m.createdAt) ? m.createdAt : Date.now(),
          };
        })
        .sort(function (a, b) { return a.time - b.time; });
    }

    if (Array.isArray(raw.ranges)) {
      state.ranges = raw.ranges
        .filter(function (r) { return r && isNum(r.start) && isNum(r.end) && r.end > r.start; })
        .map(function (r, i) {
          return {
            id: typeof r.id === 'string' && r.id ? r.id : 'r' + i + '_' + Math.random().toString(36).slice(2, 7),
            start: Math.round(r.start * 100) / 100,
            end: Math.round(r.end * 100) / 100,
            note: typeof r.note === 'string' ? r.note.slice(0, 500) : '',
            color: r.color === '#14b8c4' || PALETTE.indexOf(r.color) >= 0 ? (r.color || '#14b8c4') : '#14b8c4',
            createdAt: isNum(r.createdAt) ? r.createdAt : Date.now(),
          };
        })
        .sort(function (a, b) { return a.start - b.start; });
    }

    state.updatedAt = isNum(raw.updatedAt) ? raw.updatedAt : Date.now();

    // AI 分段字幕：按时间排好，空文本丢掉
    if (Array.isArray(raw.subtitles)) {
      state.subtitles = raw.subtitles
        .filter(function (s) {
          return s && isNum(s.start) && isNum(s.end) && s.end > s.start &&
            typeof s.text === 'string' && s.text.trim();
        })
        .map(function (s, i) {
          return {
            id: typeof s.id === 'string' && s.id ? s.id : 's' + i + '_' + Math.random().toString(36).slice(2, 7),
            start: Math.round(s.start * 100) / 100,
            end: Math.round(s.end * 100) / 100,
            text: s.text.trim().slice(0, 120),
            createdAt: isNum(s.createdAt) ? s.createdAt : Date.now(),
          };
        })
        .sort(function (a, b) { return a.start - b.start; });
    }

    // AI 复盘报告（可选）
    if (raw.report && typeof raw.report.text === 'string' && raw.report.text) {
      state.report = {
        text: raw.report.text.slice(0, 8000),
        at: isNum(raw.report.at) ? raw.report.at : Date.now(),
        count: isNum(raw.report.count) ? raw.report.count : state.markers.length,
      };
    }

    // AI 实验报告初稿（可选）：Markdown 原文，比复盘报告长，上限放到 12000
    if (raw.reportDraft && typeof raw.reportDraft.text === 'string' && raw.reportDraft.text) {
      state.reportDraft = {
        text: raw.reportDraft.text.slice(0, 12000),
        at: isNum(raw.reportDraft.at) ? raw.reportDraft.at : Date.now(),
        count: isNum(raw.reportDraft.count) ? raw.reportDraft.count : state.markers.length,
      };
    }

    // A-B 循环状态：区间可能已被删掉，这里先存 id，由上层校验
    if (raw.loop && typeof raw.loop === 'object') {
      var rate = Number(raw.loop.rate);
      state.loop = {
        id: typeof raw.loop.id === 'string' ? raw.loop.id : '',
        rate: RATES.indexOf(rate) >= 0 ? rate : 1,
      };
    }

    return state;
  }

  /** 读取某个视频的标注数据 */
  function load(vid) {
    try {
      var raw = window.localStorage.getItem(keyOf(vid));
      if (!raw) return emptyState(vid || '');
      return normalize(JSON.parse(raw), vid);
    } catch (err) {
      console.warn('[LabMark] 读取本地数据失败，将以空数据启动', err);
      return emptyState(vid || '');
    }
  }

  /** 按「条数 + 总字节」双闸裁掉最旧的缩略图，返回被裁掉的数量 */
  function pruneThumbs(state) {
    var withThumb = state.markers.filter(function (m) { return m.thumb; });
    if (!withThumb.length) return 0;

    var removed = 0;
    var byAge = function (a, b) { return a.createdAt - b.createdAt; };

    if (withThumb.length > THUMB_MAX_COUNT) {
      var olds = withThumb.slice().sort(byAge);
      for (var i = 0; i < olds.length - THUMB_MAX_COUNT; i++) {
        olds[i].thumb = '';
        removed += 1;
      }
    }

    var total = 0;
    state.markers.forEach(function (m) { if (m.thumb) total += m.thumb.length; });
    if (total > THUMB_MAX_BYTES) {
      var rest = state.markers.filter(function (m) { return m.thumb; }).sort(byAge);
      for (var j = 0; j < rest.length && total > THUMB_MAX_BYTES; j++) {
        total -= rest[j].thumb.length;
        rest[j].thumb = '';
        removed += 1;
      }
    }
    return removed;
  }

  /** 写入（自动补 updatedAt）；返回是否成功 */
  function save(state) {
    try {
      pruneThumbs(state);
      var payload = {
        version: 1,
        vid: state.vid || '',
        markers: state.markers,
        ranges: state.ranges,
        subtitles: state.subtitles || [],
        report: state.report || null,
        reportDraft: state.reportDraft || null,
        loop: state.loop || { id: '', rate: 1 },
        updatedAt: Date.now(),
      };
      window.localStorage.setItem(keyOf(state.vid), JSON.stringify(payload));
      return true;
    } catch (err) {
      // 隐私模式 / 配额满时会失败，属可预期异常
      console.warn('[LabMark] 本地保存失败', err);
      return false;
    }
  }

  /** 合并导入数据（按 id 去重），返回新增数量 */
  function merge(current, incoming, vid) {
    var merged = normalize(
      {
        markers: (current.markers || []).concat(incoming.markers || []),
        ranges: (current.ranges || []).concat(incoming.ranges || []),
        subtitles: incoming.subtitles || [],
        updatedAt: Date.now(),
      },
      vid
    );

    // 去重：同 id 只保留一条
    var seenM = {};
    merged.markers = merged.markers.filter(function (m) {
      if (seenM[m.id]) return false;
      seenM[m.id] = 1;
      return true;
    });
    var seenR = {};
    merged.ranges = merged.ranges.filter(function (r) {
      if (seenR[r.id]) return false;
      seenR[r.id] = 1;
      return true;
    });

    var added = merged.markers.length - (current.markers || []).length +
      (merged.ranges.length - (current.ranges || []).length);

    return { state: merged, added: Math.max(0, added) };
  }

  return {
    keyOf: keyOf,
    load: load,
    save: save,
    merge: merge,
    normalize: normalize,
    emptyState: emptyState,
    pruneThumbs: pruneThumbs,
  };
})();
