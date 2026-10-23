/* ==========================================================================
 * library.js —— 视频库（本地多视频清单）
 *
 * 【为什么需要这一层】
 *   保利威点播播放器一次只吃一个 VID —— 页面本身没有"视频列表"的概念。
 *   而"把账号下所有视频列出来"必须调用 VOD 服务端 API，它要用 secretkey
 *   参与签名：secretkey 一旦写进前端就等于公开泄露，且接口也不允许浏览器
 *   跨域直连。本项目硬约束是纯前端、无后端，所以做不了自动拉取。
 *
 *   于是这里做"本地视频库"：把你在保利威后台看到的 VID 登记进来
 *   （点一下 + 粘贴若干行即可），页面就能在多个视频之间切换。
 *   清单存在 localStorage（labmark.library.v1），刷新、关机都不丢。
 *
 * 【和标注数据的关系】
 *   store.js 的存储键是 labmark.v1:<vid>，本来就按视频隔离。
 *   所以切换视频后，笔记 / 区间 / 字幕 / 报告都是各自独立的一套，不会串。
 *   这里只负责"清单 + 每个视频的概览统计"，不碰标注本身的读写。
 *
 * 暴露接口：
 *   LabLibrary.list()                 → [{ vid, name, addedAt, lastOpen, builtin }]
 *   LabLibrary.add(name, vid)         → { ok, entry, reason }
 *   LabLibrary.addMany(text)          → { added, dup, invalid }
 *   LabLibrary.remove(vid)            → boolean（内置条目不可删）
 *   LabLibrary.touch(vid)             记录"最后打开时间"
 *   LabLibrary.stats(vid)             → { markers, ranges, subtitles, updatedAt }
 *   LabLibrary.isValidVid(vid)        VID 格式粗校验
 * ========================================================================== */

window.LabLibrary = (function () {
  'use strict';

  var CFG = window.LABMARK_CONFIG || {};
  var KEY = 'labmark.library.v1';
  var PREFIX = CFG.storageKeyPrefix || 'labmark.v1';

  /* 保利威 VID 的形状：32 位十六进制哈希 + 下划线 + 一位数字（_0 / _8 …）。
   * 不做严格校验 —— 后台也出现过更短的自定义 ID，这里只拦明显的手误
   * （空串、纯中文、粘贴时带进来的整段 URL）。 */
  function isValidVid(vid) {
    var v = String(vid || '').trim();
    if (v.length < 6 || v.length > 64) return false;
    return /^[0-9A-Za-z][0-9A-Za-z_-]*$/.test(v);
  }

  /** 内置条目：写在 config.js 的 videoLibrary 里，永远在列表最前面且不可删 */
  function builtins() {
    return (CFG.videoLibrary || []).filter(function (it) {
      return it && isValidVid(it.vid);
    }).map(function (it) {
      return {
        vid: String(it.vid).trim(),
        name: String(it.name || '未命名视频'),
        addedAt: 0,
        lastOpen: 0,
        builtin: true,
      };
    });
  }

  function read() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (it) {
        return it && isValidVid(it.vid);
      }).map(function (it) {
        return {
          vid: String(it.vid).trim(),
          name: String(it.name || '未命名视频').slice(0, 40),
          addedAt: Number(it.addedAt) || 0,
          lastOpen: Number(it.lastOpen) || 0,
          builtin: false,
        };
      });
    } catch (err) {
      return [];
    }
  }

  function write(list) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch (err) {
      console.warn('[LabMark] 视频库写入失败（localStorage 可能已满）', err);
      return false;
    }
  }

  /**
   * 完整清单 = 内置条目 + 用户添加的条目。
   * 同名 VID 只保留一份（内置优先），并按「最后打开 → 添加时间」倒序，
   * 让最近在用的视频自然排到前面。
   */
  function list() {
    var seen = {};
    var all = builtins().concat(read()).filter(function (it) {
      if (seen[it.vid]) return false;
      seen[it.vid] = 1;
      return true;
    });

    var head = all.filter(function (it) { return it.builtin; });
    var tail = all.filter(function (it) { return !it.builtin; }).sort(function (a, b) {
      return (b.lastOpen || b.addedAt) - (a.lastOpen || a.addedAt);
    });
    return head.concat(tail);
  }

  function findByVid(vid) {
    var v = String(vid || '').trim();
    var all = list();
    for (var i = 0; i < all.length; i++) {
      if (all[i].vid === v) return all[i];
    }
    return null;
  }

  /**
   * 添加一条。已存在时只更新名称，不重复插入。
   * name 为空则按 VID 自动起一个可读的名字（「视频 · 12ab34cd」）。
   */
  function add(name, vid) {
    var v = String(vid || '').trim();
    var n = String(name || '').trim().slice(0, 40);

    if (!v) return { ok: false, reason: 'empty-vid' };
    if (!isValidVid(v)) return { ok: false, reason: 'bad-vid' };

    var exist = findByVid(v);
    if (exist && exist.builtin) {
      return { ok: false, reason: 'builtin', entry: exist };
    }
    if (exist) {
      if (n) {
        var items = read().map(function (it) {
          if (it.vid === v) it.name = n;
          return it;
        });
        write(items);
      }
      return { ok: false, reason: 'dup', entry: exist };
    }

    var entry = {
      vid: v,
      name: n || ('视频 · ' + v.slice(0, 8)),
      addedAt: Date.now(),
      lastOpen: 0,
      builtin: false,
    };
    var next = read();
    next.push(entry);
    write(next);
    return { ok: true, entry: entry };
  }

  /**
   * 批量添加：把从保利威后台复制的一整列 VID 直接粘进来。
   * 每行可以是「VID」或「名称 VID」/「名称,VID」/「名称|VID」，顺序不敏感 ——
   * 先把行拆成若干段，认出哪一段是 VID，剩下的拼成名称。
   */
  function addMany(text) {
    var result = { added: 0, dup: 0, invalid: 0, entries: [] };
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var raw = line.trim();
      if (!raw) return;

      var parts = raw.split(/[\s,，|\t]+/).filter(Boolean);
      if (!parts.length) return;

      var vid = '';
      var nameParts = [];
      parts.forEach(function (p) {
        // 兼容误粘贴的完整播放地址：?vid=xxx 或 /video/xxx
        var m = /(?:[?&]vid=|\/video\/)([0-9A-Za-z_-]+)/.exec(p);
        if (m) p = m[1];
        if (!vid && isValidVid(p) && /[0-9]/.test(p)) vid = p;
        else nameParts.push(p);
      });

      if (!vid) { result.invalid += 1; return; }

      var r = add(nameParts.join(' '), vid);
      if (r.ok) { result.added += 1; result.entries.push(r.entry); }
      else if (r.reason === 'dup' || r.reason === 'builtin') result.dup += 1;
      else result.invalid += 1;
    });
    return result;
  }

  function remove(vid) {
    var v = String(vid || '').trim();
    if (!v) return false;
    var items = read();
    var next = items.filter(function (it) { return it.vid !== v; });
    if (next.length === items.length) return false;
    write(next);
    return true;
  }

  /** 记录最后打开时间（用于清单排序） */
  function touch(vid) {
    var v = String(vid || '').trim();
    if (!v) return;
    var items = read();
    var hit = false;
    items.forEach(function (it) {
      if (it.vid === v) { it.lastOpen = Date.now(); hit = true; }
    });
    if (hit) write(items);
  }

  /**
   * 该视频的标注概览。直接读 store.js 用的同一个键，
   * 所以数字和打开该视频后看到的一定一致。
   * 注意：这里只统计条数，不解析结构，坏数据也不影响列表渲染。
   */
  function stats(vid) {
    var v = String(vid || '').trim();
    var out = { markers: 0, ranges: 0, subtitles: 0, updatedAt: 0 };
    try {
      var raw = JSON.parse(window.localStorage.getItem(PREFIX + ':' + (v || 'demo')) || 'null');
      if (!raw || typeof raw !== 'object') return out;
      out.markers = Array.isArray(raw.markers) ? raw.markers.length : 0;
      out.ranges = Array.isArray(raw.ranges) ? raw.ranges.length : 0;
      out.subtitles = Array.isArray(raw.subtitles) ? raw.subtitles.length : 0;
      out.updatedAt = Number(raw.updatedAt) || 0;
    } catch (err) { /* 忽略，返回零值 */ }
    return out;
  }

  return {
    list: list,
    findByVid: findByVid,
    add: add,
    addMany: addMany,
    remove: remove,
    touch: touch,
    stats: stats,
    isValidVid: isValidVid,
  };
})();
