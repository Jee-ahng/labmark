/* ==========================================================================
 * app.js —— LabMark 应用主逻辑
 *
 * 功能闭环：
 *   播放 → 打点（记录当前时间戳）→ 写笔记 → 时间轴生成小旗帜
 *        → 点击旗帜/笔记 → 播放器 seek 回看
 *        → 设置起点/终点生成「重点区间」
 *        → 全部数据写入 localStorage，刷新不丢
 * ========================================================================== */

(function () {
  'use strict';

  var CFG = window.LABMARK_CONFIG || {};
  var PALETTE = CFG.palette || ['#2b7fd4'];
  var SEEK_STEP = CFG.seekStep || 5;
  var MIN_RANGE = CFG.minRangeSeconds || 1;

  var els = {};
  var player = null;
  var saveTimer = null;
  var toastTimer = null;
  var aiBusy = false;     // 识帧请求进行中（防连点重复打点 / 重复计费）
  var draftBusy = false;  // 实验报告初稿生成中
  var draftShowRaw = false;  // 报告初稿：显示 Markdown 源码还是排版视图

  /** 语音打点的运行态（不进 localStorage，属于临时会话状态） */
  var voice = {
    rec: null,        // SpeechRecognition 实例
    active: false,    // 是否正在收音
    pending: 0,       // 正在被 AI 整理的条数
    lastText: '',     // 上一条已打点的口语（用于 3 秒内去重，continuous 模式会重复回调）
    lastAt: 0,
    barTimer: null,
    retried: false,   // network 错误是否已经自动重试过一次
  };

  /** A-B 循环的防重入标记：seek 会触发 time 事件，避免在回调里反复跳 */
  var loopSeeking = false;
  var loopRestored = false;

  /** 缩略图取帧器（复用一个 CORS 副本 video，串行截帧） */
  var grabber = null;

  /** AI 字幕生成中 */
  var subBusy = false;
  /** 字幕分段长度（秒）：越短越细，但请求数和耗时同步上升 */
  var SUB_SEG = 20;
  /** 单次请求最多带多少张图，避免 prompt 过长导致模型串行号 */
  var SUB_BATCH = 6;

  /** 刚新增的条目 id：只用于渲染时挂入场动画的 class，播完即忘，不进存储 */
  var freshMarkerId = null;
  var freshRangeId = null;

  /* 应用状态（与 localStorage 同构，外加纯 UI 状态） */
  var state = {
    vid: '',
    markers: [],
    ranges: [],
    subtitles: [],       // AI 分段字幕 [{ id, start, end, text }]
    report: null,        // AI 复盘报告缓存 { text, at, count }
    reportDraft: null,   // AI 实验报告初稿缓存 { text, at, count }
    loop: { id: '', rate: 1 },   // A-B 循环：区间 id + 倍速
    tab: 'notes',       // notes | ranges | subs
    query: '',
    activeId: null,     // 当前高亮条目
    draftStart: null,   // 区间草稿起点（秒）
    duration: 0,
    currentTime: 0,
    playing: false,
  };

  /* ---------------- 工具函数 ---------------- */

  function $(id) { return document.getElementById(id); }

  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

  function round2(v) { return Math.round(v * 100) / 100; }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 秒 → mm:ss / h:mm:ss */
  function fmt(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '--:--';
    var total = Math.floor(sec);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nowClock() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function byTime(a, b) { return a.time - b.time; }
  function byStart(a, b) { return a.start - b.start; }

  function findMarker(id) {
    for (var i = 0; i < state.markers.length; i++) {
      if (state.markers[i].id === id) return state.markers[i];
    }
    return null;
  }

  function findRange(id) {
    for (var i = 0; i < state.ranges.length; i++) {
      if (state.ranges[i].id === id) return state.ranges[i];
    }
    return null;
  }

  /** toast 轻提示 */
  function toast(message, type) {
    var wrap = els.toastWrap;
    var node = document.createElement('div');
    node.className = 'toast' + (type ? ' ' + type : '');
    node.textContent = message;

    // 连续操作时最多堆 3 条，再多的从最旧的开始挤掉，别糊住面板
    while (wrap.children.length >= 3) {
      wrap.removeChild(wrap.firstChild);
    }
    wrap.appendChild(node);

    setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 200);
    }, 2000);
  }

  /* ---------------- 持久化 ---------------- */

  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var ok = window.LabStore.save(state);
      els.saveState.textContent = ok
        ? '已保存到本机 · ' + nowClock()
        : '保存失败：浏览器存储不可用';
    }, 250);
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    els.cntNotes.textContent = state.markers.length;
    els.cntRanges.textContent = state.ranges.length;
    els.cntSubs.textContent = state.subtitles.length;
    renderTabs();
    renderNotes();
    renderRanges();
    renderSubtitles();
    renderTimeline();
    renderDraft();
    renderLoopBar();
    renderTransport();
  }

  function renderTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.tab === state.tab);
    });
    els.noteList.classList.toggle('is-hidden', state.tab !== 'notes');
    els.rangeList.classList.toggle('is-hidden', state.tab !== 'ranges');
    els.subList.classList.toggle('is-hidden', state.tab !== 'subs');
    els.search.placeholder = state.tab === 'notes'
      ? '搜索笔记内容或时间…'
      : (state.tab === 'ranges' ? '搜索区间备注…' : '搜索字幕内容…');
  }

  function matchQuery(text, extra) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return String(text).toLowerCase().indexOf(q) >= 0 ||
      String(extra || '').toLowerCase().indexOf(q) >= 0;
  }

  function renderNotes() {
    var scrollTop = els.panelBody.scrollTop;
    var list = state.markers.slice().sort(byTime);

    if (!list.length) {
      els.noteList.innerHTML =
        '<li class="empty"><strong>还没有标记</strong>' +
        '播放到关键操作时，点「添加标记」或按 <kbd>M</kbd><br />当前时间戳会自动记录下来</li>';
      return;
    }

    var html = list.map(function (m, i) {
      if (!matchQuery(m.note, fmt(m.time))) return '';
      var active = state.activeId === m.id ? ' is-active' : '';
      // 刚新增的条目：渲染时带 is-new，播放一次淡入下滑入场动画
      var fresh = freshMarkerId === m.id ? ' is-new' : '';
      var dots = PALETTE.map(function (c) {
        return '<button class="color-dot' + (c === m.color ? ' is-on' : '') + '" data-act="color" data-color="' + c +
          '" style="--dc:' + c + '" title="切换标记颜色" aria-label="切换标记颜色"></button>';
      }).join('');
      // 来源徽标：AI 识帧 / 语音打点
      var aiTag = '';
      if (m.source === 'ai') {
        aiTag = '<span class="note-ai" title="由 AI 识帧生成">AI</span>';
      } else if (m.source === 'voice') {
        aiTag = '<span class="note-ai note-voice" title="语音打点，AI 整理">语音</span>';
      }

      // 缩略图三种状态：有图 / 正在截（骨架）/ 没截到（虚线占位，可点补拍）
      var thumbMode = m.thumb ? 'ok'
        : (thumbQueue.indexOf(m.id) >= 0 ? 'pending' : (thumbFailed[m.id] ? 'missing' : ''));
      var thumbCls = thumbMode === 'ok' ? ' has-thumb'
        : (thumbMode ? ' has-no-thumb' : '');
      var thumbHTML = '';
      if (thumbMode === 'ok') {
        thumbHTML = '<button class="note-thumb" data-act="thumb" title="查看关键帧大图">' +
          '<img alt="" src="' + m.thumb + '"></button>';
      } else if (thumbMode === 'pending') {
        thumbHTML = '<button class="note-thumb is-pending" data-act="thumb" ' +
          'title="正在截取这一步的关键帧…" aria-label="关键帧截取中"></button>';
      } else if (thumbMode === 'missing') {
        thumbHTML = '<button class="note-thumb is-missing" data-act="thumb" ' +
          'title="这一步没截到画面，点一下补一张（视频要先播放出画面）" aria-label="补一张关键帧"></button>';
      }

      return '' +
        '<li class="note-item' + active + fresh + thumbCls + '" data-id="' + m.id +
          '" data-src="' + (m.source || '') + '" style="--c:' + m.color + '">' +
          thumbHTML +
          '<div class="note-main">' +
            '<div class="note-row">' +
              '<button class="time-chip" data-act="jump" title="跳转到 ' + fmt(m.time) + '">' + fmt(m.time) + '</button>' +
              '<span class="note-idx">#' + (i + 1) + '</span>' +
              aiTag +
              '<div class="note-tools">' + dots +
                '<button class="link danger" data-act="delete" title="删除这个标记">删除</button>' +
              '</div>' +
            '</div>' +
            '<textarea class="note-text" rows="1" maxlength="500" ' +
              'placeholder="记录这一步的操作 / 易错点 / 结论…">' + escapeHTML(m.note) + '</textarea>' +
          '</div>' +
        '</li>';
    }).join('');

    els.noteList.innerHTML = html || '<li class="empty"><strong>没有匹配的笔记</strong>换个关键词试试</li>';
    els.panelBody.scrollTop = scrollTop;
    autosizeAll(els.noteList);
  }

  function renderRanges() {
    var scrollTop = els.panelBody.scrollTop;
    var list = state.ranges.slice().sort(byStart);

    if (!list.length) {
      els.rangeList.innerHTML =
        '<li class="empty"><strong>还没有重点区间</strong>' +
        '播放到区间开头按 <kbd>I</kbd> 设置起点，结尾按 <kbd>O</kbd> 生成区间<br />适合标记「完整操作流程」</li>';
      return;
    }

    var html = list.map(function (r) {
      if (!matchQuery(r.note, fmt(r.start) + ' ' + fmt(r.end))) return '';
      var active = state.activeId === r.id ? ' is-active' : '';
      var looping = state.loop.id === r.id;
      var fresh = freshRangeId === r.id ? ' is-new' : '';
      return '' +
        '<li class="range-item' + active + fresh + (looping ? ' is-looping' : '') + '" data-id="' + r.id + '" style="--c:' + r.color + '">' +
          '<div class="note-row">' +
            '<button class="time-chip" data-act="jump" title="跳转到区间起点">' + fmt(r.start) + ' → ' + fmt(r.end) + '</button>' +
            '<span class="dur-chip">' + Math.round(r.end - r.start) + 's</span>' +
            '<button class="loop-toggle' + (looping ? ' is-on' : '') + '" data-act="loop" ' +
              'title="' + (looping ? '关闭循环播放' : '循环播放这段区间（到达终点自动跳回起点）') + '">' +
              '<span class="lp-ico" aria-hidden="true">⟳</span>' + (looping ? state.loop.rate + 'x' : '循环') +
            '</button>' +
            '<div class="range-actions">' +
              '<button class="link danger" data-act="delete" title="删除这个区间">删除</button>' +
            '</div>' +
          '</div>' +
          '<textarea class="note-text" rows="1" maxlength="500" ' +
            'placeholder="这个区间在做什么？关键步骤 / 现象 / 结论…">' + escapeHTML(r.note) + '</textarea>' +
        '</li>';
    }).join('');

    els.rangeList.innerHTML = html || '<li class="empty"><strong>没有匹配的区间</strong>换个关键词试试</li>';
    els.panelBody.scrollTop = scrollTop;
    autosizeAll(els.rangeList);
  }

  /** AI 字幕列表：生成中显示进度，空态给出生成入口 */
  function renderSubtitles() {
    var scrollTop = els.panelBody.scrollTop;

    if (subBusy) {
      els.subList.innerHTML =
        '<li class="sub-progress" id="subProgress">' +
          '<span id="subProgressText">正在分析画面…</span>' +
          '<span class="bar"><i id="subProgressBar"></i></span>' +
        '</li>';
      els.panelBody.scrollTop = scrollTop;
      return;
    }

    if (!state.subtitles.length) {
      els.subList.innerHTML =
        '<li class="empty"><strong>还没有 AI 字幕</strong>' +
        '按时间段自动分析画面，给每一段配一句说明<br />' +
        '实验视频的关键信息多在画面上，字幕能帮你快速定位到某一步<br /><br />' +
        '<button class="btn ghost sm" id="btnSubGenerate">生成 AI 字幕</button></li>';
      els.panelBody.scrollTop = scrollTop;
      return;
    }

    var html = state.subtitles.map(function (s) {
      if (!matchQuery(s.text, fmt(s.start) + ' ' + fmt(s.end))) return '';
      var active = state.activeId === s.id ? ' is-active' : '';
      return '' +
        '<li class="sub-item' + active + '" data-id="' + s.id + '">' +
          '<div class="sub-row">' +
            '<span class="sub-time">' + fmt(s.start) + '</span>' +
            '<span class="sub-dur">' + Math.round(s.end - s.start) + 's</span>' +
          '</div>' +
          '<div class="sub-text">' + escapeHTML(s.text) + '</div>' +
        '</li>';
    }).join('');

    els.subList.innerHTML = html || '<li class="empty"><strong>没有匹配的字幕</strong>换个关键词试试</li>';
    els.panelBody.scrollTop = scrollTop;
  }

  function renderTimeline() {
    var d = state.duration;

    // 标记
    if (!d || !state.markers.length) {
      els.tlMarkers.innerHTML = '';
    } else {
      els.tlMarkers.innerHTML = state.markers.slice().sort(byTime).map(function (m, i) {
        var left = clamp((m.time / d) * 100, 0, 100);
        var active = state.activeId === m.id ? ' is-active' : '';
        var fresh = freshMarkerId === m.id ? ' is-new' : '';
        return '<button class="tl-marker' + active + fresh + '" data-id="' + m.id + '" style="left:' + left.toFixed(3) +
          '%;--c:' + m.color + '" aria-label="跳转到 ' + fmt(m.time) + '">' +
          '<span class="mk-flag">' + (i + 1) + '</span><span class="mk-pole"></span></button>';
      }).join('');
    }

    // 区间
    if (!d || !state.ranges.length) {
      els.tlRanges.innerHTML = '';
    } else {
      els.tlRanges.innerHTML = state.ranges.slice().sort(byStart).map(function (r) {
        var left = clamp((r.start / d) * 100, 0, 100);
        var width = clamp(((r.end - r.start) / d) * 100, 0.5, 100 - left);
        var looping = state.loop.id === r.id;
        return '<div class="tl-range' + (looping ? ' is-loop' : '') + '" data-id="' + r.id + '" style="left:' +
          left.toFixed(3) + '%;width:' + width.toFixed(3) + '%;background:' + r.color + '26;border-color:' +
          r.color + '88;border-left-color:' + r.color + '">' +
          '<span class="tl-range-label">' + (looping ? '⟳ ' : '') + fmt(r.start) + ' → ' + fmt(r.end) +
          '</span></div>';
      }).join('');
    }

    // AI 字幕轨
    if (!d || !state.subtitles.length) {
      els.tlSubs.innerHTML = '';
      els.tlSubs.classList.add('is-hidden');
    } else {
      els.tlSubs.classList.remove('is-hidden');
      els.tlSubs.innerHTML = state.subtitles.map(function (s) {
        var left = clamp((s.start / d) * 100, 0, 100);
        var width = clamp(((s.end - s.start) / d) * 100, 0.8, 100 - left);
        var active = state.activeId === s.id ? ' is-on' : '';
        // 时间轴上的字幕块只当"位置指示器"：一段通常只有几十像素宽，
        // 塞进去的文字必然被截成半截，看着像没排版。完整内容在「AI 字幕」标签页里，
        // 只有特别长的片段（≥18%）才在块内直接显示文字。
        var tiny = width < 18 ? ' is-tiny' : '';
        var label = width < 18 ? '' : escapeHTML(s.text);
        // 宽度减 2px 留出缝隙，相邻字幕块才不会糊成一条
        return '<button class="tl-sub' + active + tiny + '" data-id="' + s.id + '" style="left:' +
          left.toFixed(3) + '%;width:calc(' + width.toFixed(3) + '% - 2px)" title="' +
          escapeHTML(s.text) + '（点击跳转）">' + label + '</button>';
      }).join('');
    }

    // 空状态
    var empty = !state.markers.length && !state.ranges.length && !state.subtitles.length;
    els.tlEmpty.classList.toggle('is-hidden', !empty);
    els.tlEmpty.innerHTML = d
      ? '还没有任何标记 —— 播放到关键步骤时，点击「添加标记」<kbd>M</kbd>'
      : '视频加载中…';

    renderTicks();
    updatePlayhead();

    // 动画只播一次：渲染完就忘掉"新增"标记，后续重绘不再重复弹入
    freshMarkerId = null;
    freshRangeId = null;
  }

  function renderTicks() {
    var d = state.duration;
    if (!d) { els.tlTicks.innerHTML = ''; return; }

    var steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
      if (d / steps[i] <= 8) { step = steps[i]; break; }
    }

    var html = '';
    for (var t = 0; t <= d + 0.001; t += step) {
      var left = clamp((t / d) * 100, 0, 100);
      html += '<span class="tick" style="left:' + left.toFixed(3) + '%">' + fmt(t) + '</span>';
    }
    els.tlTicks.innerHTML = html;
  }

  function updatePlayhead() {
    var pct = state.duration > 0 ? clamp((state.currentTime / state.duration) * 100, 0, 100) : 0;
    els.tlPlayhead.style.left = pct.toFixed(3) + '%';
    els.tCur.textContent = fmt(state.currentTime);
    if (state.duration > 0) els.tDur.textContent = fmt(state.duration);
  }

  function renderTransport() {
    var playing = state.playing;
    els.btnPlay.querySelector('.ico-play').classList.toggle('is-hidden', playing);
    els.btnPlay.querySelector('.ico-pause').classList.toggle('is-hidden', !playing);
    els.btnPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function renderDraft() {
    var has = state.draftStart != null;
    els.draftBar.classList.toggle('is-hidden', !has);
    els.btnRangeEnd.classList.toggle('is-armed', has);
    if (has) els.draftJump.textContent = '起点 ' + fmt(state.draftStart);
  }

  function renderMode(mode) {
    var isPolyv = mode === 'polyv';
    els.modeBadge.classList.toggle('is-demo', !isPolyv);
    els.modeText.textContent = isPolyv ? '保利威播放器 · 已接入' : '演示模式 · 示例视频';
    if (isPolyv) {
      els.vidBadgeText.textContent = 'VID ' + shortId(state.vid);
      els.vidBadge.title = '当前视频：' + state.vid + '\n点击打开视频库，切换到其他视频';
      hideNotice();
    } else if (CFG.demoRequested) {
      // 主动进入演示模式（index.html?demo=1）
      els.vidBadgeText.textContent = '演示视频';
      els.vidBadge.title = '当前为演示视频（无需 VID）\n点击打开视频库';
      showNotice('演示模式：正在播放 40 秒操作示意片段（随项目附带，断网也能用），打点、笔记、区间、缩略图与本地保存全部可用。点击右上角「保利威播放器」可切回真实 VID。', false);
    } else {
      els.vidBadgeText.textContent = '示例视频';
      els.vidBadge.title = '当前未配置 VID，正在用示例视频\n点击打开视频库';
      var reason = player && player._demoReason;
      var map = {
        'no-vid': '当前未配置保利威 VID，正在用示例视频跑通完整标注流程。在地址栏加 ?vid=你的VID，刷新后即切换为保利威点播播放器。',
        'sdk-missing': '保利威播放器 SDK 未加载成功（可能是网络问题），已自动切换到示例视频，标注功能不受影响。',
        'sdk-error': '保利威播放器初始化异常，已自动切换到示例视频。',
        'manual': '已切换到示例视频，标注功能照常可用。',
      };
      showNotice(map[reason] || map['no-vid'], false);
    }
  }

  /**
   * 显示播放器提示条
   * @param {string} text 文案（支持 \n 换行）
   * @param {boolean|{demo?:boolean, diag?:boolean, retry?:boolean, error?:boolean}} actions
   *        true 等价于 { demo: true }（向后兼容），false/undefined 不显示按钮
   */
  function showNotice(text, actions) {
    var opts = actions === true ? { demo: true } : (actions || {});
    els.noticeText.textContent = text;
    els.playerNotice.classList.remove('is-hidden');
    els.playerNotice.classList.toggle('is-error', !!opts.error);
    els.noticeAction.classList.toggle('is-hidden', !opts.demo);
    els.noticeDiag.classList.toggle('is-hidden', !opts.diag);
    els.noticeRetry.classList.toggle('is-hidden', !opts.retry);
  }

  function hideNotice() {
    // 重试进行中：重建播放器会重新抛一次 mode 事件，这里不能被它顺手把「正在重试…」藏掉
    if (playRetry && playRetry.pending) return;
    els.playerNotice.classList.add('is-hidden');
  }

  /** 播放失败时的一键自检：区分「连不上凭证接口」和「视频侧不可播」 */
  function runDiagnose() {
    if (!player) return;
    var label = els.noticeDiag.textContent;
    els.noticeDiag.disabled = true;
    els.noticeDiag.textContent = '诊断中…';

    var restore = function () {
      els.noticeDiag.disabled = false;
      els.noticeDiag.textContent = label;
    };

    player.diagnose().then(function (res) {
      restore();
      showNotice(res.summary, { demo: true, diag: true, retry: true, error: !res.ok });
      toast(res.short, res.ok ? '' : 'warn');
      console.info('[LabMark 诊断]\n' + res.summary);
    }).catch(function (err) {
      restore();
      showNotice('诊断执行失败：' + (err && err.message ? err.message : err), { demo: true, diag: true, retry: true, error: true });
    });
  }

  /* ---------------- 播放失败重试 ----------------
   *
   * #003「获取播放凭证失败」几乎都是瞬时的：保利威凭证接口限流、代理缓存了旧凭证、
   * 插件拦住了播放器发出的那一跳。刷新页面能好，但会丢掉当前进度和没保存的草稿，
   * 所以这里就地重建播放器（= 重新要一次凭证）。
   *
   * 策略：第一次失败先自动重试一次，不让用户第一眼就看到错误面板；
   *       自动重试也失败才亮出「重试播放 / 运行诊断 / 切换示例视频」三个出口。
   *       手动点「重试播放」不限次数。
   */
  var playRetry = { autoUsed: false, pending: false, watchdog: null, resumeAt: 0 };

  function clearRetryWatchdog() {
    playRetry.pending = false;
    if (playRetry.watchdog) { clearTimeout(playRetry.watchdog); playRetry.watchdog = null; }
  }

  function retryPlayer() {
    if (!player || player.mode !== 'polyv') return;

    clearRetryWatchdog();
    playRetry.pending = true;
    playRetry.resumeAt = player.getTime() || 0;   // 记下重试前的进度，重建后回到原位

    var nth = (player._retryCount || 0) + 1;
    showNotice('正在重新获取播放凭证…（第 ' + nth + ' 次重试）', {});

    if (!player.retry()) {
      clearRetryWatchdog();
      showNotice('重试未成功：播放器无法重建。\n可点「切换示例视频」继续演示，或刷新页面后再试。',
        { demo: true, diag: true, retry: true, error: true });
      return;
    }

    // 重建后既不报错也不出画面（比如请求一直挂着）时，12 秒后兜底提示，避免一直停在「重试中」
    playRetry.watchdog = setTimeout(function () {
      if (!playRetry.pending) return;
      clearRetryWatchdog();
      if (player.getDuration() > 0) return;
      showNotice('重试后仍未拿到视频画面。\n建议：点「运行诊断」看凭证接口是否被拦；或「切换示例视频」先把标注流程演完。',
        { demo: true, diag: true, retry: true, error: true });
    }, 12000);
  }

  function autosizeAll(scope) {
    if (!scope) return;
    Array.prototype.forEach.call(scope.querySelectorAll('.note-text'), function (ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });
  }

  function markActive(id) {
    state.activeId = id;
    Array.prototype.forEach.call(els.noteList.querySelectorAll('.note-item'), function (li) {
      li.classList.toggle('is-active', li.dataset.id === id);
    });
    Array.prototype.forEach.call(els.rangeList.querySelectorAll('.range-item'), function (li) {
      li.classList.toggle('is-active', li.dataset.id === id);
    });
    Array.prototype.forEach.call(els.tlMarkers.querySelectorAll('.tl-marker'), function (b) {
      b.classList.toggle('is-active', b.dataset.id === id);
    });
  }

  /* ---------------- 核心动作 ---------------- */

  function canUseVideo() {
    if (state.duration > 0) return true;
    // duration 的上报偶尔比第一帧画面晚一拍。只卡 duration 会出现
    // 「视频明明已经能播，点打点却提示还在加载」——有画面就允许打点。
    var v = getVideoEl();
    return !!(v && v.videoWidth > 0);
  }

  function addMarker() {
    if (!canUseVideo()) { toast('视频还在加载，稍等一下', 'warn'); return; }

    var t = round2(player.getTime());
    var marker = {
      id: uid('m'),
      time: t,
      note: '',
      color: PALETTE[0],   // 普通打点统一用主题蓝，颜色仍可在笔记里手动改
      createdAt: Date.now(),
    };

    state.markers.push(marker);
    state.markers.sort(byTime);
    state.activeId = marker.id;
    state.tab = 'notes';
    freshMarkerId = marker.id;   // 只影响这一次渲染的入场动画
    /* 先把缩略图位摆出来（渲染成「截取中」骨架）。
     * 取帧要等视频 seek 完，通常 1~3 秒，这段时间如果什么都不显示，
     * 用户就会以为「这个功能没有」—— 骨架本身就是最直接的反馈。 */
    if (thumbQueue.indexOf(marker.id) < 0) thumbQueue.push(marker.id);
    delete thumbFailed[marker.id];

    persist();
    renderAll();
    focusField(els.noteList, marker.id);
    grabThumb(marker.id);
    toast('已在 ' + fmt(t) + ' 打点，接着写下这一步的要点');
  }

  /* ---------------- 关键帧缩略图 ---------------- */

  /* 打点瞬间视频可能还没解码出画面（刚切视频、刚 seek、还在缓冲），
   * 早先的实现在这里直接 return，于是这一条就永久没有缩略图 ——
   * 现场演示最常见的「缩略图没出来」就是这么来的。
   * 现在改成排队：等播放器真的出画面再统一补拍，超时才放弃并给一个可点的占位。 */
  var thumbQueue = [];
  var thumbFailed = {};
  var thumbFlushTimer = null;

  function getGrabber() {
    var v = getVideoEl();
    if (!v) return null;
    if (!grabber) grabber = window.LabAI.makeGrabber(v);
    return grabber;
  }

  /** 视频是否已经能取到画面（readyState >= HAVE_CURRENT_DATA 且有尺寸） */
  function videoPaintable() {
    var v = getVideoEl();
    return !!(v && v.readyState >= 2 && v.videoWidth > 0);
  }

  /**
   * 给某条打点补一张关键帧缩略图。
   * @param {string} id  打点 id
   * @param {boolean} force 已有图也重截（用户点「补一张」时）
   */
  function grabThumb(id, force) {
    var m = findMarker(id);
    if (!m) return;
    if (m.thumb && !force) return;

    // 画面还没就绪：先排队，等 flushThumbQueue 补拍，绝不静默丢弃
    if (!videoPaintable()) {
      if (force) m.thumb = '';
      if (thumbQueue.indexOf(id) < 0) thumbQueue.push(id);
      delete thumbFailed[id];
      paintThumb(id);
      scheduleThumbFlush();
      return;
    }

    var g = getGrabber();
    if (!g) return;

    if (force) m.thumb = '';

    g.grab(m.time, 320, 0.72)
      .then(function (url) {
        var target = findMarker(id);
        if (!target || !url) return;
        var at = thumbQueue.indexOf(id);
        if (at >= 0) thumbQueue.splice(at, 1);
        target.thumb = url;
        delete thumbFailed[id];
        persist();
        paintThumb(id);
      })
      .catch(function (err) {
        // 跨域 / 超时：记下来，卡片上给一个虚线占位，点一下可重试
        console.warn('[LabMark] 关键帧截图失败', fmt(m.time), err && err.message);
        var at = thumbQueue.indexOf(id);
        if (at >= 0) thumbQueue.splice(at, 1);
        var target = findMarker(id);
        if (target && !target.thumb) thumbFailed[id] = true;
        paintThumb(id);
      });
  }

  /** 视频没画面时挂起的补拍任务：轻量轮询，最多等 16 秒 */
  function scheduleThumbFlush() {
    if (thumbFlushTimer || !thumbQueue.length) return;
    var tries = 0;
    thumbFlushTimer = setInterval(function () {
      tries += 1;
      if (videoPaintable()) {
        clearInterval(thumbFlushTimer);
        thumbFlushTimer = null;
        flushThumbQueue();
        return;
      }
      if (tries > 40) {
        clearInterval(thumbFlushTimer);
        thumbFlushTimer = null;
        thumbQueue.forEach(function (id) { thumbFailed[id] = true; });
        thumbQueue.length = 0;
        renderNotes();
      }
    }, 400);
  }

  function flushThumbQueue() {
    if (!thumbQueue.length) return;
    var ids = thumbQueue.slice();
    thumbQueue.length = 0;
    ids.forEach(function (id) { grabThumb(id); });
  }

  /** 只替换这一条 DOM 里的缩略图，避免整列表重绘打断正在输入的文本框 */
  function paintThumb(id) {
    var li = els.noteList.querySelector('.note-item[data-id="' + id + '"]');
    var m = findMarker(id);
    if (!li || !m) return;

    var mode = m.thumb ? 'ok' : (thumbQueue.indexOf(id) >= 0 ? 'pending' : (thumbFailed[id] ? 'missing' : ''));
    var btn = li.querySelector('.note-thumb');

    if (!mode) {
      if (btn) btn.parentNode.removeChild(btn);
      li.classList.remove('has-thumb', 'has-no-thumb');
      return;
    }

    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'note-thumb';
      btn.dataset.act = 'thumb';
      li.insertBefore(btn, li.firstChild);
    }
    btn.classList.remove('is-pending', 'is-missing');

    if (mode === 'ok') {
      btn.innerHTML = '<img alt="" src="' + m.thumb + '">';
      btn.title = '查看关键帧大图';
      li.classList.add('has-thumb');
      li.classList.remove('has-no-thumb');
      return;
    }

    btn.innerHTML = '';
    btn.classList.add(mode === 'pending' ? 'is-pending' : 'is-missing');
    btn.title = mode === 'pending'
      ? '正在截取这一步的关键帧…'
      : '这一步没截到画面，点一下补一张（视频要先播放出画面）';
    li.classList.add('has-no-thumb');
    li.classList.remove('has-thumb');
  }

  function openThumb(id) {
    var m = findMarker(id);
    if (!m || !m.thumb) return;
    state.thumbId = id;
    els.thumbImg.src = m.thumb;
    els.thumbTime.textContent = fmt(m.time);
    els.thumbNote.textContent = m.note ? m.note.replace(/\s+/g, ' ').slice(0, 90) : '（这一步还没有写笔记）';
    els.thumbMask.classList.remove('is-hidden', 'is-closing');
  }

  /**
   * 统一的关闭动画：先播 200ms 反向淡出，再挂 is-hidden。
   * 只是把"瞬间消失"换成"淡出"，不改变任何关闭后的状态处理。
   */
  function fadeClose(mask, after) {
    if (!mask || mask.classList.contains('is-hidden')) {
      if (after) after();
      return;
    }
    mask.classList.add('is-closing');
    setTimeout(function () {
      mask.classList.remove('is-closing');
      mask.classList.add('is-hidden');
      if (after) after();
    }, 200);
  }

  function closeThumb() {
    fadeClose(els.thumbMask, function () {
      els.thumbImg.removeAttribute('src');
      state.thumbId = null;
    });
  }

  /* ---------------- 视频库：多个保利威视频之间切换 ----------------
   * 保利威播放器一次只吃一个 VID，页面本身没有「视频列表」。
   * 把账号下的其他视频登记进本地清单（assets/js/library.js），
   * 就能在这里切换。每个视频的标注存在各自的 labmark.v1:<vid> 里，
   * 所以切换后笔记、区间、字幕、报告都是独立的一套。
   *
   * 切换方式：整页带 ?vid= 重载。比运行时销毁重建播放器稳 ——
   * state、AI 取帧副本、时间轴缓存都要跟着换，重载一步到位，也只要 1 秒。
   * ---------------------------------------------------------------- */

  /** 卡片上的 VID：中间省略，保留首 8 位与后缀（_0 / _8），保证可辨认 */
  function shortId(v) {
    var s2 = String(v || '');
    return s2.length > 14 ? s2.slice(0, 8) + '…' + s2.slice(-2) : s2;
  }

  /** 「最后更新」用相对说法，比完整日期更好扫 */
  function libWhen(ts) {
    var d = new Date(ts);
    var now = new Date();
    var pad = function (n) { return ('0' + n).slice(-2); };
    if (d.toDateString() === now.toDateString()) {
      return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /** 当前打开的视频在清单里的标识：真实 VID 或 ''（演示视频） */
  function currentLibVid() {
    return CFG.demoRequested || !state.vid ? '' : state.vid;
  }

  function libItemHTML(it, isCurrent) {
    var demo = !it.vid;
    var st = demo ? window.LabLibrary.stats('demo') : window.LabLibrary.stats(it.vid);
    var bits = [];
    if (st.markers) bits.push(st.markers + ' 条笔记');
    if (st.ranges) bits.push(st.ranges + ' 个区间');
    if (st.updatedAt) bits.push(libWhen(st.updatedAt) + ' 更新');

    var stat = bits.length ? bits.join(' · ') : '还没有标注';
    var cls = 'lib-item' + (isCurrent ? ' is-current' : '') + (demo ? ' is-demo' : '');

    return '' +
      '<li class="' + cls + '" data-vid="' + escapeHTML(it.vid || '') + '">' +
        '<span class="lib-icon" aria-hidden="true">' +
          (demo
            ? '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="6" width="18" height="12" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10.4l4 1.6-4 1.6z" fill="currentColor"/></svg>') +
        '</span>' +
        '<span class="lib-info">' +
          '<b class="lib-name">' + escapeHTML(demo ? '演示视频 · 40 秒示意' : it.name) + '</b>' +
          '<span class="lib-meta">' +
            '<span class="lib-vid">' + (demo ? '无需 VID' : escapeHTML(shortId(it.vid))) + '</span>' +
            '<i class="lib-sep">·</i>' +
            '<span class="lib-stat">' + escapeHTML(stat) + '</span>' +
          '</span>' +
        '</span>' +
        '<span class="lib-acts">' +
          (isCurrent
            ? '<span class="lib-now">正在观看</span>'
            : '<button class="link lib-go" data-act="go">打开</button>') +
          (!it.builtin && !demo
            ? '<button class="link danger lib-del" data-act="del" title="从视频库移除（不会删除标注数据）">移除</button>'
            : '') +
        '</span>' +
      '</li>';
  }

  function renderLibrary() {
    if (!els.libList) return;
    var cur = currentLibVid();
    var items = window.LabLibrary.list();

    var demoEntry = { vid: '', name: '演示视频 · 40 秒示意', builtin: true };
    var all = items.concat([demoEntry]);

    // 正在观看的那条提到最前：打开弹窗第一眼就知道自己在看哪个
    for (var i = 0; i < all.length; i++) {
      if ((all[i].vid || '') === cur) {
        all.unshift(all.splice(i, 1)[0]);
        break;
      }
    }

    els.libList.innerHTML = all.map(function (it) {
      return libItemHTML(it, (it.vid || '') === cur);
    }).join('');

    var total = items.length;
    els.libMeta.textContent = '共 ' + total + ' 个保利威视频 · 标注数据按视频分开保存，切换不会互相影响';
  }

  function openLibrary() {
    if (!els.libMask) return;
    renderLibrary();
    els.libMask.classList.remove('is-hidden', 'is-closing');
    if (els.libInput) {
      els.libInput.value = '';
      setTimeout(function () { els.libInput.focus(); }, 220);
    }
  }

  function closeLibrary() {
    fadeClose(els.libMask);
  }

  /**
   * 切到另一个视频。
   * 先 persist()，保证当前视频的笔记落盘后再跳，
   * 然后把目标名字塞进 sessionStorage，新页面加载完提示一句「已切换到 …」。
   */
  function switchVideo(vid) {
    var target = String(vid || '');
    var isDemo = !target || target === 'demo';

    if (isDemo ? !currentLibVid() : target === (state.vid || '')) {
      closeLibrary();
      return;
    }

    persist();

    var name = isDemo ? '演示视频' : '';
    if (!isDemo) {
      var hit = window.LabLibrary.findByVid(target);
      name = hit ? hit.name : target.slice(0, 8);
      window.LabLibrary.touch(target);
    }

    try { window.sessionStorage.setItem('labmark.justSwitched', name); } catch (err) { /* 隐私模式忽略 */ }

    // 180ms 的过渡：卡片淡出 → 整页换视频，避免硬切的白闪
    document.documentElement.classList.add('is-switching');
    setTimeout(function () {
      window.location.search = isDemo ? '?demo=1' : '?vid=' + encodeURIComponent(target);
    }, 180);
  }

  function addLibraryFromInput() {
    var text = els.libInput ? els.libInput.value : '';
    if (!text.trim()) {
      toast('先粘一个 VID 进来', 'warn');
      els.libInput.focus();
      return;
    }

    var r = window.LabLibrary.addMany(text);
    if (r.added) {
      els.libInput.value = '';
      renderLibrary();
      // 只加了一条就直接问「要不要打开」，多条时留在列表里让用户自己点
      toast('已添加 ' + r.added + ' 个视频' + (r.dup ? '，' + r.dup + ' 个已在列表中' : ''));
    } else if (r.dup) {
      toast('这些视频已经在列表里了', 'warn');
    } else {
      toast('没认出有效的 VID，检查一下是否少了「_0」这类后缀', 'warn');
    }
    if (r.invalid && r.added) {
      toast('有 ' + r.invalid + ' 行没认出来，已跳过', 'warn');
    }
  }

  function removeMarker(id) {
    state.markers = state.markers.filter(function (m) { return m.id !== id; });
    if (state.activeId === id) state.activeId = null;
    persist();
    renderAll();
    toast('标记已删除');
  }

  function setMarkerColor(id, color) {
    var m = findMarker(id);
    if (!m || PALETTE.indexOf(color) < 0) return;
    m.color = color;
    persist();
    renderTimeline();
    var item = els.noteList.querySelector('[data-id="' + id + '"]');
    if (item) {
      item.style.setProperty('--c', color);
      Array.prototype.forEach.call(item.querySelectorAll('.color-dot'), function (dot) {
        dot.classList.toggle('is-on', dot.dataset.color === color);
      });
    }
  }

  function removeRange(id) {
    var wasLooping = state.loop.id === id;
    state.ranges = state.ranges.filter(function (r) { return r.id !== id; });
    if (state.activeId === id) state.activeId = null;
    if (wasLooping) state.loop.id = '';   // 循环的区间被删了，顺手退出循环
    persist();
    renderAll();
    toast(wasLooping ? '区间已删除，循环播放已退出' : '区间已删除');
  }

  function setRangeStart() {
    if (!canUseVideo()) { toast('视频还在加载，稍等一下', 'warn'); return; }
    state.draftStart = round2(player.getTime());
    renderDraft();
    toast('区间起点：' + fmt(state.draftStart) + '，播放到结束位置再点「区间终点」');
  }

  function setRangeEnd() {
    if (!canUseVideo()) { toast('视频还在加载，稍等一下', 'warn'); return; }
    if (state.draftStart == null) { toast('请先点「区间起点」', 'warn'); return; }

    var end = round2(player.getTime());
    if (end - state.draftStart < MIN_RANGE) {
      toast('这段区间不到 ' + MIN_RANGE + ' 秒，再往后播放一点', 'warn');
      return;
    }

    var range = {
      id: uid('r'),
      start: state.draftStart,
      end: end,
      note: '',
      color: PALETTE[1],
      createdAt: Date.now(),
    };

    state.ranges.push(range);
    state.ranges.sort(byStart);
    state.draftStart = null;
    state.activeId = range.id;
    state.tab = 'ranges';
    freshRangeId = range.id;

    persist();
    renderAll();
    focusField(els.rangeList, range.id);
    toast('已生成重点区间 ' + fmt(range.start) + ' → ' + fmt(range.end));
  }

  function cancelDraft() {
    state.draftStart = null;
    renderDraft();
  }

  /* ---------------- A-B 区间循环播放 ---------------- */

  /** 当前正在循环的区间（区间可能已被删除，这时返回 null） */
  function currentLoopRange() {
    if (!state.loop.id) return null;
    return findRange(state.loop.id);
  }

  /**
   * 循环控制行是常驻的：没开循环时它也是一个明确入口，
   * 开了之后整行转成青色系，A-B 时间与进度都是等宽读数。
   */
  function renderLoopBar() {
    var r = currentLoopRange();
    var on = !!r;

    els.loopBar.classList.toggle('is-on', on);
    els.loopBar.classList.toggle('is-off', !on);
    els.btnLoopToggle.classList.toggle('is-on', on);
    els.btnLoopToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.btnLoopBtnText.textContent = on ? '循环中' : '循环';
    els.btnLoopToggle.title = on
      ? '关闭循环播放'
      : '循环当前高亮的重点区间（快捷键 L）';
    els.btnLoopExit.classList.toggle('is-hidden', !on);

    Array.prototype.forEach.call(els.rateSeg.querySelectorAll('.rate-btn'), function (btn) {
      btn.classList.toggle('is-on', Number(btn.dataset.rate) === Number(state.loop.rate));
    });

    if (!on) {
      els.loopRange.textContent = 'A --:--  ·  B --:--';
      els.loopProg.textContent = '';
      return;
    }

    els.loopRange.textContent = fmt(r.start) + ' → ' + fmt(r.end);
    updateLoopProgress(state.currentTime, r);
  }

  /** 循环开关 / 快捷键 L 的共同入口：优先当前高亮区间，其次第一个区间 */
  function toggleLoopSmart() {
    if (state.loop.id) { stopLoop(); return; }
    var r = findRange(state.activeId) || state.ranges.slice().sort(byStart)[0];
    if (!r) { toast('还没有重点区间，先按 I / O 圈出一段', 'warn'); return; }
    toggleLoop(r.id);
  }

  function updateLoopProgress(t, r) {
    if (!r) return;
    var span = Math.max(0.01, r.end - r.start);
    var inRange = clamp(t - r.start, 0, span);
    els.loopProg.textContent = fmt(inRange) + ' / ' + fmt(span);
  }

  /** 开关循环：同一个区间再点一次就是关闭 */
  function toggleLoop(id) {
    if (state.loop.id === id) { stopLoop(); return; }

    var r = findRange(id);
    if (!r) return;
    if (!canUseVideo()) { toast('视频还在加载，稍等一下', 'warn'); return; }

    state.loop.id = id;
    state.loop.rate = state.loop.rate || 1;

    player.setRate(state.loop.rate);
    player.seek(r.start);
    player.play();

    persist();
    renderRanges();
    renderTimeline();
    renderLoopBar();

    toast('已开启循环 ' + fmt(r.start) + ' → ' + fmt(r.end) + ' · ' + state.loop.rate + 'x');
  }

  /**
   * 停止循环：清状态 + 恢复 1x。
   * silent = true 时不弹提示（初始化恢复失败、区间被删等场景）
   */
  function stopLoop(silent) {
    var had = !!state.loop.id;
    state.loop.id = '';
    if (player) player.setRate(1);

    if (had) {
      persist();
      renderRanges();
      renderTimeline();
      renderLoopBar();
      if (!silent) toast('已退出循环播放，恢复正常速度');
    }
  }

  function setLoopRate(rate) {
    var r = Number(rate);
    if (!isFinite(r) || r <= 0) return;
    state.loop.rate = r;
    if (player) player.setRate(r);
    persist();
    renderRanges();
    renderLoopBar();
    toast('循环倍速 ' + r + 'x');
  }

  /**
   * 循环的核心判定：播放到 B 点自动跳回 A 点。
   * 只在「正在播放」时跳 —— 用户手动暂停时不该被拽走。
   * loopSeeking 用来挡住 seek 触发的 time 回灌，避免同一帧内反复跳。
   */
  function checkLoop(t) {
    var r = currentLoopRange();
    if (!r) return;

    updateLoopProgress(t, r);

    if (loopSeeking || !player.isPlaying()) return;
    if (t < r.end - 0.04) return;

    loopSeeking = true;
    player.seek(r.start);
    // 保利威部分皮肤 seek 后会短暂进入 pause，这里补一次 play 保证循环连续
    if (!player.isPlaying()) player.play();

    setTimeout(function () { loopSeeking = false; }, 240);
  }

  /** 刷新页面后恢复上次的循环设置（不自动播放，避免打断用户） */
  function restoreLoop() {
    if (loopRestored || !player) return;
    loopRestored = true;

    var r = currentLoopRange();
    if (!r) {
      if (state.loop.id) { state.loop.id = ''; persist(); }
      renderLoopBar();
      return;
    }

    player.setRate(state.loop.rate);
    renderLoopBar();
    toast('已恢复循环片段 ' + fmt(r.start) + ' → ' + fmt(r.end) + ' · ' + state.loop.rate + 'x');
  }

  function jumpTo(seconds) {
    if (!canUseVideo()) return;
    player.seek(seconds);
    state.currentTime = seconds;
    updatePlayhead();
  }

  /**
   * 跳转定位反馈：对应的时间旗帜外扩一圈淡蓝光晕。
   * 纯视觉提示，700ms 后自动摘掉 class，不影响任何状态。
   */
  function flashMarker(id) {
    var btn = els.tlMarkers.querySelector('.tl-marker[data-id="' + id + '"]');
    if (!btn) return;
    btn.classList.remove('is-flash');
    void btn.offsetWidth;    // 强制回流，让动画能从 0 重新播放
    btn.classList.add('is-flash');
    setTimeout(function () { btn.classList.remove('is-flash'); }, 700);
  }

  function jumpToMarker(id) {
    var m = findMarker(id);
    if (!m) return;
    jumpTo(m.time);
    markActive(id);
    flashMarker(id);
  }

  function jumpToRange(id) {
    var r = findRange(id);
    if (!r) return;
    jumpTo(r.start);
    markActive(id);
  }

  function switchTab(tab) {
    state.tab = tab;
    renderTabs();
  }

  function focusField(listEl, id) {
    requestAnimationFrame(function () {
      var item = listEl.querySelector('[data-id="' + id + '"]');
      if (!item) return;
      item.scrollIntoView({ block: 'nearest' });
      var ta = item.querySelector('.note-text');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      }
    });
  }

  function clearAll() {
    if (!state.markers.length && !state.ranges.length && !state.subtitles.length) {
      toast('当前没有可清空的数据');
      return;
    }
    if (!window.confirm('确定清空全部标记、重点区间与 AI 字幕吗？此操作不可撤销。')) return;
    state.markers = [];
    state.ranges = [];
    state.subtitles = [];
    state.report = null;
    state.reportDraft = null;
    state.loop = { id: '', rate: 1 };
    if (player) player.setRate(1);
    state.activeId = null;
    state.draftStart = null;
    persist();
    renderAll();
    toast('已清空全部标注');
  }

  /* ---------------- AI 能力（模式 A 识帧打点 / 模式 B 复盘报告） ---------------- */

  function getVideoEl() {
    return document.querySelector('#polyvWrap video') || document.getElementById('demoVideo');
  }

  function timeText(ts) {
    var d = new Date(ts || Date.now());
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 未配置 AI 时直接引导去设置，避免点了没反应 */
  function requireAI() {
    if (window.LabAI && window.LabAI.isConfigured()) return true;
    toast('还没配置 AI 接口，先填写 key 再试', 'warn');
    openAISettings();
    return false;
  }

  /**
   * AI 失败的统一出口：401/403 这类「配置问题」直接把设置弹层打开并标红，
   * 免得用户只看到一个 toast 不知道下一步该干什么。
   */
  function handleAIError(err, fallbackText) {
    var msg = err && err.message ? err.message : (fallbackText || 'AI 调用失败');
    toast(msg, 'danger');
    if (/40[13]|未配置|不匹配|无法访问/.test(msg)) {
      openAISettings();
      setTestResult('bad', '❌ ' + msg + '\n改完再点「测试连接」验证。');
    }
  }

  /**
   * 模式 A 主流程：先在点击瞬间落点（保证时间戳准确），再取帧识别并填笔记。
   * getDataUrl：返回 Promise<dataURL>，可以是实时截图，也可以是上传的图片。
   */
  function runFrameNote(getDataUrl, atTime) {
    // 并发保护：连点会同时发起多次请求，既产生重复打点也重复计费
    if (aiBusy) { toast('上一帧还在识别中，稍等一下', 'warn'); return; }
    if (!requireAI()) return;

    aiBusy = true;

    var t = round2(atTime == null ? player.getTime() : atTime);
    var marker = {
      id: uid('m'),
      time: t,
      note: 'AI 识别中…',
      color: PALETTE[0],   // 普通打点统一用主题蓝，颜色仍可在笔记里手动改
      source: 'ai',
      createdAt: Date.now(),
    };

    state.markers.push(marker);
    state.markers.sort(byTime);
    state.activeId = marker.id;
    state.tab = 'notes';

    persist();
    renderAll();
    markActive(marker.id);

    els.btnAI.classList.add('is-busy');

    /* 实测：截帧偶发超时、接口偶发抖动都会让识别失败。
     * 现场演示时这一下很致命，所以失败自动重试一次；
     * 但配置类错误（key 无效 / 未配置 / 401 / 403）重试也没用，直接抛。 */
    var tries = 0;

    function attempt() {
      tries += 1;
      return Promise.resolve()
        .then(getDataUrl)
        .then(function (dataUrl) {
          if (!dataUrl) throw new Error('截图失败，请重试');
          // 识帧用的这张图正好就是这一帧的关键帧，缩一张直接当缩略图，不用二次截帧
          if (!marker.thumb) {
            window.LabAI.downscale(dataUrl, 320, 0.72).then(function (small) {
              if (!findMarker(marker.id) || marker.thumb) return;
              marker.thumb = small;
              persist();
              paintThumb(marker.id);
            }).catch(function () { });
          }
          return window.LabAI.noteFromFrame(dataUrl);
        })
        .catch(function (err) {
          var msg = String((err && err.message) || '');
          var notRetryable = /401|403|未配置|key|不支持图片/i.test(msg);
          if (tries < 2 && !notRetryable) {
            return new Promise(function (resolve) { setTimeout(resolve, 700); }).then(attempt);
          }
          throw err;
        });
    }

    attempt()
      .then(function (note) {
        marker.note = '【操作描述】' + note.op + '\n【易错提醒】' + note.warn;
        persist();
        renderNotes();
        renderTimeline();
        markActive(marker.id);
        toast('AI 已生成打点笔记 · ' + fmt(t));
      })
      .catch(function (err) {
        // 识别失败也保留时间戳，给一份可手写的骨架
        marker.note = '【操作描述】\n【易错提醒】';
        persist();
        renderNotes();
        markActive(marker.id);
        if (!marker.thumb) grabThumb(marker.id);   // 识别失败也留一张帧，方便事后自己看
        handleAIError(err, 'AI 识别失败');
      })
      .then(function () {
        aiBusy = false;
        els.btnAI.classList.remove('is-busy');
      });
  }

  function aiFrameNote() {
    if (!canUseVideo()) { toast('视频还在加载，稍等一下', 'warn'); return; }
    runFrameNote(function () {
      return window.LabAI.captureFrame(getVideoEl(), 720);
    }, player.getTime());
  }

  function aiUploadNote(file) {
    if (!file) return;
    runFrameNote(function () {
      return window.LabAI.fileToDataURL(file, 720);
    }, canUseVideo() ? player.getTime() : 0);
  }

  /* ---------------- 复盘报告弹层 ---------------- */

  /** VID 是 30+ 位的哈希，整串放进弹窗副标题会把一行挤成两行，只留前 8 位够识别 */
  function shortVid() {
    var vid = state.vid || 'demo';
    return vid.length > 14 ? vid.slice(0, 8) + '…' : vid;
  }

  function reportMetaText() {
    return 'VID ' + shortVid() + ' · 时长 ' + fmt(state.duration) +
      ' · ' + state.markers.length + ' 条标记 · ' + state.ranges.length + ' 段区间';
  }

  /** 报告模块头识别。
   * 模型的输出习惯并不统一，四种情况都要吃得下：
   *   "1. 📌 实验时间线"            → 序号 + 标题
   *   "📌 实验时间线"               → 只有标题
   *   "📝 小结：本实验验证了……"      → 标题和正文挤在同一行
   *   "✅ 重做时在 00:30 控制加酸量"  → 这是正文里的强调句，不是标题
   * 规则：emoji 必须在行首（允许前面带序号）；有冒号就切出标题+正文，
   * 没冒号且太长（>24 字）则判为正文行。
   */
  var REPORT_HEAD_RE = /^(?:(\d+)\s*[.、)]\s*)?(📌|⚠️|✅|📝)\s*([\s\S]*)$/;

  /** 模型有时会自作主张加 Markdown 前缀（`## ` / `**` / `- ` / `> `），识别标题前先剥掉
   *  注意顺序：先剥标题井号，再剥行首符号（`**` 的星号会被行首规则啃掉一个），最后清掉剩余星号 */
  function stripMdNoise(line) {
    return String(line)
      .trim()
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*+>]+\s*/, '')
      .replace(/\*+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitReportHead(line) {
    var m = REPORT_HEAD_RE.exec(stripMdNoise(line));
    if (!m) return null;

    var rest = m[3].trim();
    var label = rest;
    var inline = '';
    var ci = rest.search(/[：:]/);

    if (ci >= 0) {
      label = rest.slice(0, ci).trim();
      inline = rest.slice(ci + 1).trim();
    } else if (rest.length > 24) {
      return null;
    }

    return { emoji: m[2], label: label, inline: inline };
  }

  /** 把模型输出的纯文本按 4 个模块排版（标题原样保留，不改写） */
  function formatReportText(text) {
    var lines = String(text || '').split(/\r?\n/);
    var blocks = [];
    var cur = null;
    var headCount = 0;

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) return;
      var head = splitReportHead(line);
      if (head) {
        // 序号由代码统一生成：模型有时写 "1." 有时不写，不能让它决定编号
        headCount += 1;
        cur = {
          title: headCount + '. ' + head.emoji + (head.label ? ' ' + head.label : ''),
          items: head.inline ? [head.inline] : [],
        };
        blocks.push(cur);
        return;
      }
      if (!cur) { cur = { title: '', items: [] }; blocks.push(cur); }
      cur.items.push(line.trim());
    });

    // 一个模块头都没识别出来，说明模型整篇按 Markdown 写了（## 标题 + - 列表），
    // 那就交给 Markdown 渲染器，别硬按 emoji 拆（否则会原样显示一堆 ## 和 **）
    var hasHead = blocks.some(function (b) { return !!b.title; });
    if (!hasHead) return renderMarkdown(text);

    var html = blocks.map(function (b) {
      var body = b.items.map(function (line) {
        var bullet = /^([-•·]|\d+[\.、)])\s+/.test(line);
        var clean = line.replace(/^([-•·]|\d+[\.、)])\s+/, '');
        clean = escapeHTML(clean).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        return '<div class="' + (bullet ? 'rp-li' : 'rp-line') + '">' + clean + '</div>';
      }).join('');
      var head = b.title ? '<div class="report-h">' + escapeHTML(b.title) + '</div>' : '';
      return '<section class="report-block">' + head + '<div class="report-body">' + body + '</div></section>';
    }).join('');

    return html || '<div class="report-state">报告内容为空</div>';
  }

  function reportLoadingHTML() {
    return '<div class="report-state"><span class="spin-dot"></span>正在根据 ' + state.markers.length +
      ' 条打点生成复盘报告…<br />首次生成通常需要 5~20 秒</div>';
  }

  function renderReportError(msg) {
    els.reportBody.innerHTML =
      '<div class="report-error"><b>报告生成失败</b>' + escapeHTML(msg) +
      '<br />请检查「AI 设置」里的接口地址、key 与模型；修正后点「重新生成」。</div>';
    els.reportHint.textContent = '生成失败时可修正 AI 配置后重试';
  }

  function generateReport() {
    if (!state.markers.length) { toast('先打几个点，AI 才有素材', 'warn'); return; }

    els.reportBody.innerHTML = reportLoadingHTML();
    els.reportHint.textContent = 'AI 正在阅读你的打点记录…';
    els.btnReportRetry.classList.add('is-busy');
    els.btnReportRetry.disabled = true;

    window.LabAI.report({
      markers: state.markers,
      ranges: state.ranges,
      duration: state.duration,
      vid: state.vid,
    })
      .then(function (text) {
        state.report = { text: text, at: Date.now(), count: state.markers.length };
        persist();
        els.reportBody.innerHTML = formatReportText(text);
        els.reportBody.scrollTop = 0;
        els.reportHint.textContent = '生成于 ' + timeText(state.report.at) + ' · 依据 ' + state.report.count + ' 条打点';
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : '未知错误';
        renderReportError(msg);
        if (/40[13]|未配置|不匹配|无法访问/.test(msg)) {
          closeReport();
          handleAIError(err, 'AI 生成失败');
        }
      })
      .then(function () {
        els.btnReportRetry.classList.remove('is-busy');
        els.btnReportRetry.disabled = false;
      });
  }

  function openReport() {
    els.reportMeta.textContent = reportMetaText();
    els.reportMask.classList.remove('is-hidden', 'is-closing');

    if (state.report && state.report.text) {
      els.reportBody.innerHTML = formatReportText(state.report.text);
      var stale = state.report.count !== state.markers.length;
      els.reportHint.textContent = '生成于 ' + timeText(state.report.at) + ' · 依据 ' + state.report.count + ' 条打点' +
        (stale ? '（打点已变化，建议重新生成）' : '');
    } else {
      generateReport();
    }
  }

  function closeReport() {
    fadeClose(els.reportMask);
  }

  function copyReport() {
    var text = state.report && state.report.text;
    if (!text) { toast('还没有可复制的报告', 'warn'); return; }
    copyText(text, '报告已复制到剪贴板');
  }

  function downloadReport() {
    var text = state.report && state.report.text;
    if (!text) { toast('还没有可下载的报告', 'warn'); return; }

    var head = '# 实验复盘报告\n\n' +
      '- VID：' + (state.vid || 'demo') + '\n' +
      '- 时长：' + fmt(state.duration) + '\n' +
      '- 标记：' + state.markers.length + ' 条 · 重点区间：' + state.ranges.length + ' 段\n' +
      '- 生成时间：' + new Date(state.report.at).toLocaleString('zh-CN') + '\n\n---\n\n';

    var blob = new Blob([head + text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    a.href = url;
    a.download = 'labmark-report-' + (state.vid || 'demo') + '-' + stamp + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('报告已下载');
  }

  /* ---------------- 实验报告初稿（Markdown 6 章） ---------------- */

  /** 行内格式：先转义，再还原 **粗体** 与 `代码`，避免 XSS */
  function mdInline(str) {
    return escapeHTML(str)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  /** Markdown 表格：首行表头 + 第二行分隔线 + 数据行（模型常留空，给一行填写位） */
  function buildMdTable(rows) {
    function cells(row) {
      return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
    }
    var head = cells(rows[0]);
    var body = rows.slice(2).map(cells);
    var width = head.length;

    var thead = '<thead><tr>' + head.map(function (c) {
      return '<th>' + mdInline(c) + '</th>';
    }).join('') + '</tr></thead>';

    var tbody;
    if (!body.length) {
      // 「五、数据记录」常见情况：只有表头。补一行提示，学生可以直接往里填
      tbody = '<tr><td colspan="' + width + '" class="md-empty-hint">（在此填入实测数据）</td></tr>';
    } else {
      tbody = body.map(function (r) {
        return '<tr>' + r.map(function (c) {
          return '<td>' + (c ? mdInline(c) : '&nbsp;') + '</td>';
        }).join('') + '</tr>';
      }).join('');
    }

    return '<table class="md-table">' + thead + '<tbody>' + tbody + '</tbody></table>';
  }

  /**
   * 极简 Markdown 渲染：够用就好，覆盖模型实际会输出的语法
   *   # ~ #### 标题、- / 1. 列表、| 表格 |、> 引用、--- 分隔线、**粗体**、`code`
   * 不引第三方库，保持纯前端零依赖。
   */
  function renderMarkdown(md) {
    var lines = String(md || '').replace(/\r/g, '').split('\n');
    var html = [];
    var i = 0;

    function isSpecial(t) {
      return /^(#{1,4}\s|\||>\s?|([-*+]|\d+[.)])\s|-{3,}$|\*{3,}$|_{3,}$)/.test(t);
    }

    while (i < lines.length) {
      var t = lines[i].trim();
      if (!t) { i++; continue; }

      // 表格
      if (/^\|/.test(t) && i + 1 < lines.length && /^\|[\s:\-|]+\|$/.test(lines[i + 1].trim())) {
        var rows = [];
        var j = i;
        while (j < lines.length && /^\|/.test(lines[j].trim())) { rows.push(lines[j].trim()); j++; }
        html.push(buildMdTable(rows));
        i = j;
        continue;
      }

      // 标题
      var h = /^(#{1,4})\s+(.*)$/.exec(t);
      if (h) {
        var lv = h[1].length;
        html.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { html.push('<hr />'); i++; continue; }

      // 引用
      if (/^>\s?/.test(t)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quote.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        html.push('<blockquote>' + mdInline(quote.join(' ')) + '</blockquote>');
        continue;
      }

      // 有序 / 无序列表（含缩进续行）
      if (/^([-*+]|\d+[.)])\s+/.test(t)) {
        var ordered = /^\d+[.)]\s+/.test(t);
        var tag = ordered ? 'ol' : 'ul';
        var items = [];
        while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, ''));
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isSpecial(lines[i].trim())) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i++;
          }
        }
        html.push('<' + tag + '>' + items.map(function (it) {
          return '<li>' + mdInline(it) + '</li>';
        }).join('') + '</' + tag + '>');
        continue;
      }

      // 普通段落（连续非空行合并）
      var buf = [];
      while (i < lines.length && lines[i].trim() && !isSpecial(lines[i].trim())) {
        buf.push(lines[i].trim());
        i++;
      }
      if (buf.length) html.push('<p>' + mdInline(buf.join('')) + '</p>');
      else i++;   // 兜底，避免死循环
    }

    return html.join('') || '<div class="md-state">报告内容为空</div>';
  }

  function draftMetaText() {
    return 'VID ' + shortVid() + ' · 时长 ' + fmt(state.duration) +
      ' · 依据 ' + state.markers.length + ' 条打点 · ' + state.ranges.length + ' 段区间';
  }

  /** 报告正文的两种视图：排版后 / Markdown 源码 */
  function renderDraftBody(text) {
    if (draftShowRaw) {
      els.draftBody.innerHTML = '<pre class="md-raw">' + escapeHTML(text) + '</pre>';
    } else {
      els.draftBody.innerHTML = renderMarkdown(text);
    }
    els.btnDraftRaw.textContent = draftShowRaw ? '排版' : '源码';
  }

  function toggleDraftRaw() {
    draftShowRaw = !draftShowRaw;
    var text = state.reportDraft && state.reportDraft.text;
    if (text) renderDraftBody(text);
    else els.btnDraftRaw.textContent = draftShowRaw ? '排版' : '源码';
  }

  function draftLoadingHTML() {
    return '<div class="md-state"><span class="spin-dot"></span>正在把 ' + state.markers.length +
      ' 条打点整理成实验报告初稿…<br />首次生成通常需要 10~30 秒</div>';
  }

  /** 生成 / 重新生成报告初稿 */
  function generateDraftReport() {
    if (draftBusy) { toast('报告正在生成中，稍等一下', 'warn'); return; }
    if (!state.markers.length) { toast('先打几个点，AI 才有素材', 'warn'); return; }
    if (!requireAI()) return;

    draftBusy = true;
    els.draftBody.innerHTML = draftLoadingHTML();
    els.btnDraftRetry.classList.add('is-busy');
    els.btnDraftRetry.disabled = true;
    els.btnDraftCopy.disabled = true;
    els.btnDraftDownload.disabled = true;

    window.LabAI.reportDraft({
      markers: state.markers,
      ranges: state.ranges,
      duration: state.duration,
      vid: state.vid,
    })
      .then(function (text) {
        state.reportDraft = { text: text, at: Date.now(), count: state.markers.length };
        persist();
        renderDraftBody(text);
        els.draftBody.scrollTop = 0;
        els.draftMeta.textContent = draftMetaText() + ' · 生成于 ' + timeText(state.reportDraft.at);
        toast('实验报告初稿已生成');
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : '未知错误';
        els.draftBody.innerHTML = '<div class="md-alert"><b>报告生成失败</b>' + escapeHTML(msg) +
          '<br />请检查「AI 设置」里的接口地址、key 与模型；修正后点「重新生成」。</div>';
        if (/40[13]|未配置|不匹配|无法访问/.test(msg)) handleAIError(err, 'AI 生成失败');
        else toast(msg, 'danger');
      })
      .then(function () {
        draftBusy = false;
        els.btnDraftRetry.classList.remove('is-busy');
        els.btnDraftRetry.disabled = false;
        els.btnDraftCopy.disabled = false;
        els.btnDraftDownload.disabled = false;
      });
  }

  function openDraftReport() {
    els.draftMeta.textContent = draftMetaText();
    els.draftMask.classList.remove('is-hidden', 'is-closing');

    if (state.reportDraft && state.reportDraft.text) {
      renderDraftBody(state.reportDraft.text);
      var stale = state.reportDraft.count !== state.markers.length;
      els.draftMeta.textContent = draftMetaText() + ' · 上次生成于 ' + timeText(state.reportDraft.at) +
        (stale ? '（打点已变化，建议点「重新生成」）' : '（点「重新生成」可刷新）');
    } else {
      generateDraftReport();
    }
  }

  function closeDraftReport() {
    fadeClose(els.draftMask);
  }

  /** 复制：优先异步剪贴板，失败退回 textarea + execCommand（file:// 下也能用） */
  function copyText(text, okText) {
    var done = function () { toast(okText || '已复制到剪贴板'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (err) { toast('复制失败，请手动选中文本', 'danger'); }
      document.body.removeChild(ta);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function copyDraftReport() {
    var text = state.reportDraft && state.reportDraft.text;
    if (!text) { toast('还没有可复制的报告', 'warn'); return; }
    copyText(text, '实验报告初稿已复制');
  }

  function downloadDraftReport() {
    var text = state.reportDraft && state.reportDraft.text;
    if (!text) { toast('还没有可下载的报告', 'warn'); return; }

    // 需求指定文件名 report.md，纯 Markdown 原文，粘进 Word / Typora 都能用
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'report.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已下载 report.md');
  }

  /* ---------------- AI 字幕（按画面内容分段生成） ---------------- */

  function updateSubProgress(done, total, label) {
    var t = document.getElementById('subProgressText');
    var b = document.getElementById('subProgressBar');
    if (t && label) t.textContent = label;
    if (b && total) b.style.width = Math.round((done / total) * 100) + '%';
  }

  function findSub(id) {
    for (var i = 0; i < state.subtitles.length; i++) {
      if (state.subtitles[i].id === id) return state.subtitles[i];
    }
    return null;
  }

  function jumpToSub(id) {
    var s = findSub(id);
    if (!s) return;
    jumpTo(s.start);
    markActive(id);
  }

  /**
   * 生成 AI 字幕。
   *
   * 为什么是「按画面」而不是「按声音」：
   *   保利威的 <video> 跨域且没带 crossOrigin，captureStream 直接被安全策略挡掉；
   *   换成带 CORS 的副本 video 能取出非静音音轨，但当前账号的 key 只授权了
   *   deepseek-v4.1-flash-1017（音频输入返回 400，专用 ASR 模型 403），
   *   所以走「抽帧 + 多模态理解画面」这条稳定可用的路。
   *   实验视频的关键信息本来就在画面上（动作、仪器、读数），这条路反而更贴场景。
   *
   * 实现上刻意不碰主播放器：取帧走独立的 CORS 副本 video，
   * 所以生成期间用户可以继续正常观看，不会被 seek 打断。
   */
  function generateSubtitles() {
    if (subBusy) { toast('字幕正在生成中，稍等一下', 'warn'); return; }
    if (!requireAI()) return;
    if (!state.duration) { toast('视频还在加载，稍等一下', 'warn'); return; }

    var g = getGrabber();
    if (!g) { toast('播放器还没准备好', 'warn'); return; }

    var dur = state.duration;
    var seg = SUB_SEG;
    var total = Math.ceil(dur / seg);
    // 长视频限制段数，避免一次点出几十个请求
    if (total > 40) { seg = Math.ceil(dur / 40); total = Math.ceil(dur / seg); }

    var slots = [];
    for (var i = 0; i < total; i++) {
      var s = i * seg;
      var e = Math.min(dur, s + seg);
      if (e - s < 1.2) break;
      slots.push({ start: round2(s), end: round2(e), mid: round2((s + e) / 2) });
    }
    if (!slots.length) { toast('视频太短，不需要切分', 'warn'); return; }

    subBusy = true;
    state.tab = 'subs';
    renderTabs();
    renderSubtitles();
    updateSubProgress(0, slots.length, '正在抽取关键帧…');

    // 1) 逐段抽帧
    var frames = [];
    var chain = Promise.resolve();
    slots.forEach(function (slot, idx) {
      chain = chain.then(function () {
        updateSubProgress(idx, slots.length, '正在抽取关键帧 ' + (idx + 1) + '/' + slots.length);
        return g.grab(slot.mid, 448, 0.72)
          .then(function (url) { if (url) frames.push({ dataUrl: url, timeText: fmt(slot.start) + '-' + fmt(slot.end), slot: slot }); })
          .catch(function () { /* 单帧失败就跳过这一段 */ });
      });
    });

    // 2) 分批并发交给模型：一次理解多帧 + 多批同时发，比逐帧串行快一个数量级
    chain
      .then(function () {
        if (!frames.length) throw new Error('一帧都没取到，可能是视频源不允许截图');

        var batches = [];
        for (var b = 0; b < frames.length; b += SUB_BATCH) batches.push(frames.slice(b, b + SUB_BATCH));

        var results = new Array(frames.length);
        var doneCount = 0;
        updateSubProgress(0, batches.length, 'AI 正在理解画面 1/' + batches.length);

        var jobs = batches.map(function (batch, bi) {
          var offset = bi * SUB_BATCH;
          return window.LabAI.subtitlesForFrames(batch)
            .then(function (texts) {
              texts.forEach(function (t, k) { results[offset + k] = t; });
            })
            .catch(function (err) {
              // 单批失败不拖垮整体：其余批次照常出字幕
              console.warn('[LabMark] 字幕批次失败', err);
            })
            .then(function () {
              doneCount += 1;
              updateSubProgress(doneCount, batches.length,
                doneCount >= batches.length ? '正在整理字幕…' : 'AI 正在理解画面 ' + (doneCount + 1) + '/' + batches.length);
            });
        });

        return Promise.all(jobs).then(function () { return results; });
      })
      .then(function (results) {
        var subs = [];
        results.forEach(function (text, i) {
          if (!text || !frames[i]) return;
          subs.push({
            id: uid('s'),
            start: frames[i].slot.start,
            end: frames[i].slot.end,
            text: text,
            createdAt: Date.now(),
          });
        });
        if (!subs.length) throw new Error('AI 没有返回可用的字幕，请重试');

        state.subtitles = subs;
        state.activeId = null;
        subBusy = false;
        persist();
        renderAll();
        toast('已生成 ' + subs.length + ' 条 AI 字幕，点击字幕可跳转');
      })
      .catch(function (err) {
        subBusy = false;
        renderSubtitles();
        handleAIError(err, 'AI 字幕生成失败');
      });
  }

  /* ---------------- 导出 Word / PDF ---------------- */

  /** 报告标题优先取正文里的一级标题，没有就退回默认值 */
  function exportTitle() {
    var text = (state.reportDraft && state.reportDraft.text) || '';
    var m = text.match(/^#\s+(.+)$/m);
    if (!m) {
      // 没生成 AI 报告时，导出的是「过程记录」，标题如实写，别假装是完整报告
      return state.markers.length || state.ranges.length ? '实验过程记录' : '实验报告';
    }
    return m[1].replace(/[#*`]/g, '').trim().slice(0, 40) || '实验报告';
  }

  /**
   * 没有 AI 报告时的正文兜底。
   * 比赛现场网络不稳、或模型临时抽风时，用户仍然要能交文档 ——
   * 这里用打点 + 区间自动拼一份可读的过程记录。
   */
  function fallbackBodyHTML() {
    var list = state.markers.slice().sort(byTime);
    if (!list.length && !state.ranges.length) {
      return '<p class="empty-hint">（还没有任何打点记录 —— 播放视频时按 M 打点，再导出就会有内容）</p>';
    }
    var items = list.map(function (m) {
      var note = String(m.note || '').replace(/\s+/g, ' ').trim();
      return '<li><b>' + fmt(m.time) + '</b> · ' + escapeHTML(note || '（这一步还没写笔记）') + '</li>';
    }).join('');
    var ranges = state.ranges.slice().sort(byStart).map(function (r) {
      var note = String(r.note || '').replace(/\s+/g, ' ').trim();
      return '<li><b>' + fmt(r.start) + ' → ' + fmt(r.end) + '</b> · ' + escapeHTML(note || '重点操作区间') + '</li>';
    }).join('');

    return (items ? '<h2>一、实验过程记录</h2><ol>' + items + '</ol>' : '') +
      (ranges ? '<h2>' + (items ? '二' : '一') + '、重点操作区间</h2><ul>' + ranges + '</ul>' : '') +
      '<p class="md-state">以上内容依据打点记录自动整理。点「生成实验报告初稿」可得到含实验目的 / ' +
      '器材 / 步骤 / 注意事项 / 数据 / 思考题的完整六章报告。</p>';
  }

  function exportPayload() {
    var text = (state.reportDraft && state.reportDraft.text) || '';
    // 报告的 Markdown 以「# 实验报告：xxx」开头，而文档顶部已经有标题了，
    // 这里去掉这个一级标题，避免导出的文档里标题出现两次
    var bodyText = text.replace(/^\s*#\s+[^\n]*\n+/, '');
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };

    var markers = state.markers.slice().sort(byTime);
    var frames = markers.map(function (m) {
      return { time: fmt(m.time), note: m.note, thumb: m.thumb || '' };
    });
    var ranges = state.ranges.slice().sort(byStart).map(function (r) {
      return { start: fmt(r.start), end: fmt(r.end), dur: r.end - r.start, note: r.note };
    });

    return {
      title: exportTitle(),
      subtitle: '依据实验录像标注自动生成 · LabMark',
      meta: [
        ['实验视频', state.vid ? state.vid : '示例视频（演示模式）'],
        ['打点数量', state.markers.length + ' 处'],
        ['重点区间', state.ranges.length + ' 段'],
        ['AI 字幕', state.subtitles.length + ' 条'],
        ['导出时间', d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())],
      ],
      bodyHTML: bodyText.trim() ? renderMarkdown(bodyText) : fallbackBodyHTML(),
      frames: frames,
      ranges: ranges,
      footer: '本报告由 LabMark 依据实验录像中的打点记录与关键帧生成，数据保存在本机浏览器。' +
        'AI 生成内容仅供参考，提交前请结合实验实际情况核对补全。',
    };
  }

  function exportWord() {
    try {
      var p = exportPayload();
      var html = window.LabExport.buildHTML({
        title: p.title, subtitle: p.subtitle, meta: p.meta, bodyHTML: p.bodyHTML,
        frames: p.frames, ranges: p.ranges, footer: p.footer, forWord: true,
      });
      var name = window.LabExport.toWord(html, exportTitle());
      toast('已导出 ' + name + '，可用 Word / WPS 打开继续编辑');
    } catch (err) {
      console.warn(err);
      toast('导出 Word 失败：' + ((err && err.message) || '未知错误'), 'danger');
    }
  }

  function exportPdf() {
    try {
      var payload = exportPayload();
      window.LabExport.toPDF(window.LabExport.buildHTML(payload));
      toast('已打开打印窗口，在目标打印机里选「另存为 PDF」');
    } catch (err) {
      console.warn(err);
      toast('导出 PDF 失败：' + ((err && err.message) || '未知错误'), 'danger');
    }
  }

  /** Markdown 正文：有 AI 报告就用报告，没有就用打点自动拼一份 */
  function markdownForExport() {
    var text = ((state.reportDraft && state.reportDraft.text) || '').trim();
    if (text) return text;

    var lines = ['# ' + exportTitle(), ''];
    lines.push('- **实验视频**：' + (state.vid || '示例视频（演示模式）'));
    lines.push('- **打点数量**：' + state.markers.length + ' 处');
    lines.push('- **重点区间**：' + state.ranges.length + ' 段');
    lines.push('');

    if (state.markers.length) {
      lines.push('## 实验过程记录', '');
      state.markers.slice().sort(byTime).forEach(function (m, i) {
        var note = String(m.note || '').replace(/\s+/g, ' ').trim() || '（这一步还没写笔记）';
        lines.push((i + 1) + '. **' + fmt(m.time) + '** ' + note);
      });
      lines.push('');
    }
    if (state.ranges.length) {
      lines.push('## 重点操作区间', '');
      state.ranges.slice().sort(byStart).forEach(function (r) {
        lines.push('- **' + fmt(r.start) + ' → ' + fmt(r.end) + '** ' +
          (String(r.note || '').trim() || '重点操作区间'));
      });
      lines.push('');
    }
    if (!state.markers.length && !state.ranges.length) {
      lines.push('> 还没有任何打点记录 —— 播放视频时按 M 打点，再导出就会有内容。');
      lines.push('');
    }
    lines.push('---');
    lines.push('*本文件由 LabMark 依据实验录像的打点记录生成。*');
    return lines.join('\n');
  }

  function exportMarkdown() {
    try {
      var md = markdownForExport();
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = window.LabExport.fileName(exportTitle()) + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
      toast('已导出 ' + a.download);
    } catch (err) {
      console.warn(err);
      toast('导出 Markdown 失败：' + ((err && err.message) || '未知错误'), 'danger');
    }
  }

  /**
   * 导出前给还缺图的打点补拍一次关键帧。
   * 用户最在意的就是「导出的 Word 里有没有图」，所以宁可多等 1 秒。
   */
  function withThumbs(run) {
    var missing = state.markers.filter(function (m) { return !m.thumb; });
    if (!missing.length || !videoPaintable()) { run(); return; }

    missing.forEach(function (m) { grabThumb(m.id); });

    var waited = 0;
    var timer = setInterval(function () {
      waited += 200;
      var left = state.markers.filter(function (m) {
        return !m.thumb && thumbQueue.indexOf(m.id) >= 0;
      }).length;
      if (!left || waited >= 1500) {
        clearInterval(timer);
        run();
      }
    }, 200);
  }

  function closeExportMenu() {
    if (!els.exportMenu) return;
    els.exportMenu.classList.add('is-hidden');
    var grp = els.btnExport && els.btnExport.closest('.export-group');
    if (grp) grp.classList.remove('is-open');
  }

  /* ---------------- 语音打点（SpeechRecognition + AI 整理） ---------------- */

  function speechEngine() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function showVoiceBar(text) {
    if (voice.barTimer) { clearTimeout(voice.barTimer); voice.barTimer = null; }
    els.voiceText.textContent = text;
    els.voiceBar.classList.remove('is-hidden');
  }

  /** 停止后延迟收起，让用户看清最后一句的整理结果 */
  function hideVoiceBarSoon(delay) {
    if (voice.barTimer) clearTimeout(voice.barTimer);
    voice.barTimer = setTimeout(function () {
      if (!voice.active) els.voiceBar.classList.add('is-hidden');
    }, delay == null ? 2200 : delay);
  }

  function setVoiceUI(active) {
    els.btnVoice.classList.toggle('is-rec', active);
    els.btnVoice.querySelector('.voice-label').textContent = active ? '聆听中…' : '语音打点';
    els.voiceTag.innerHTML = active
      ? '<i class="rec-dot"></i>聆听中'
      : '<i class="rec-dot" style="animation:none"></i>已停止';
    // 停止后「结束录音」按钮没意义了，收起来免得误点
    els.btnVoiceStop.classList.toggle('is-hidden', !active);
  }

  function toggleVoice() {
    if (voice.active) stopVoice();
    else startVoice();
  }

  /* ---- 语音不可用时的两条退路：重试 / 手动输入 ---- */

  /**
   * 识别引擎起不来时的统一状态。
   * 刻意不自动收起提示条：用户这一刻正需要看到「怎么办」，
   * 而「手动输入」按钮就摆在旁边，一步就能继续把流程走完。
   */
  function voiceFailed(msg) {
    voice.active = false;
    if (voice.barTimer) { clearTimeout(voice.barTimer); voice.barTimer = null; }
    els.voiceBar.classList.remove('is-hidden');
    els.voiceBar.classList.add('is-error');
    els.voiceTag.innerHTML = '<i class="rec-dot" style="animation:none"></i>改用输入';
    els.voiceText.textContent = msg;
    els.voiceInput.classList.add('is-hidden');
    els.btnVoiceStop.classList.add('is-hidden');
    els.btnVoiceRetry.classList.remove('is-hidden');
  }

  /** 手动输入：和语音走同一条落点 + AI 整理链路 */
  function openVoiceType() {
    if (voice.active) stopVoice();
    if (voice.barTimer) { clearTimeout(voice.barTimer); voice.barTimer = null; }
    els.voiceBar.classList.remove('is-hidden', 'is-error');
    els.voiceTag.innerHTML = '<i class="rec-dot" style="animation:none"></i>手动输入';
    els.voiceText.textContent = '输入一句话，回车即落在当前时间点：';
    els.btnVoiceStop.classList.add('is-hidden');
    els.btnVoiceRetry.classList.add('is-hidden');
    els.voiceInput.classList.remove('is-hidden');
    els.voiceInput.value = '';
    els.voiceInput.focus();
  }

  function closeVoiceType(keepBar) {
    els.voiceInput.classList.add('is-hidden');
    els.voiceInput.value = '';
    els.btnVoiceStop.classList.remove('is-hidden');
    if (!keepBar) els.voiceBar.classList.add('is-hidden');
  }

  function submitVoiceType() {
    var text = els.voiceInput.value.trim();
    if (!text) { els.voiceInput.focus(); return; }
    closeVoiceType(true);
    handleVoiceText(text);
  }

  function startVoice(isRetry) {
    var Engine = speechEngine();
    if (!Engine) {
      voiceFailed('这个浏览器没有语音识别能力。请用 Chrome / Edge 打开（需 localhost 或 https），或直接「手动输入」。');
      return;
    }
    if (!canUseVideo()) { toast('视频还在加载，稍等一下', 'warn'); return; }
    if (voice.active) return;
    if (!isRetry) voice.retried = false;

    var rec = new Engine();
    rec.lang = 'zh-CN';
    rec.continuous = true;        // 连续收音：一次可以连打好几个点
    rec.interimResults = true;    // 边说边显示，现场演示反馈更直接
    rec.maxAlternatives = 1;

    rec.onstart = function () {
      voice.active = true;
      els.voiceBar.classList.remove('is-error');
      els.btnVoiceRetry.classList.add('is-hidden');
      setVoiceUI(true);
      showVoiceBar('正在聆听，说一句现场操作描述（说完自动打点）…');
    };

    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var res = e.results[i];
        var txt = String((res[0] && res[0].transcript) || '').trim();
        if (!txt) continue;
        if (res.isFinal) handleVoiceText(txt);
        else interim += txt;
      }
      if (interim) showVoiceBar('“' + interim + '”');
    };

    rec.onerror = function (e) {
      var code = e.error || '';

      // 没听到声音 / 用户主动停：都不算失败，继续听
      if (code === 'no-speech' || code === 'aborted') return;

      /* network 是国内最常见的失败：Chrome 的 webkitSpeechRecognition 要访问
       * Google 的识别服务，基本连不上。这里先自动重试一次（有时只是瞬时抽风），
       * 还不行就把界面切成「需要手写」，并直接把输入框摆出来。 */
      if (code === 'network' && !voice.retried) {
        voice.retried = true;
        voice.active = false;
        try { rec.stop(); } catch (err) { /* 已经停了 */ }
        showVoiceBar('识别服务没连上，正在重试一次…');
        setTimeout(function () { if (!voice.active) startVoice(true); }, 360);
        return;
      }

      var map = {
        'not-allowed': '麦克风权限被拒绝。点地址栏左侧的锁 → 允许麦克风，再点「重试」；不想开麦克风就点「手动输入」。',
        'service-not-allowed': '浏览器把语音识别服务禁用了（常见于企业策略）。换 Edge 打开一般可用，也可以直接「手动输入」。',
        'audio-capture': '没有检测到麦克风设备。插上麦克风后点「重试」，或直接「手动输入」。',
        'network': '语音识别服务连不上 —— Chrome 的识别要访问 Google 服务器，国内网络通常不通。可换 Edge 打开，或直接用「手动输入」。',
      };
      var msg = map[code] || ('语音识别失败（' + code + '），可以改用「手动输入」');

      voice.active = false;
      setVoiceUI(false);
      voiceFailed(msg);
    };

    rec.onend = function () {
      // Chrome 在静音一段时间后会自己 end，这里如实反映状态
      if (voice.active) {
        voice.active = false;
        setVoiceUI(false);
        showVoiceBar(voice.pending ? '收音结束，正在整理最后的笔记…' : '收音结束');
        hideVoiceBarSoon(voice.pending ? 1800 : 1600);
      }
    };

    voice.rec = rec;
    try {
      rec.start();
    } catch (err) {
      voice.active = false;
      setVoiceUI(false);
      toast('语音识别启动失败：' + (err && err.message ? err.message : err), 'danger');
    }
  }

  function stopVoice() {
    if (!voice.rec) return;
    try { voice.rec.stop(); } catch (err) { /* 已停止 */ }
    voice.active = false;
    setVoiceUI(false);
    els.voiceBar.classList.remove('is-error');
    els.voiceInput.classList.add('is-hidden');
    els.btnVoiceRetry.classList.add('is-hidden');
    showVoiceBar('已停止收音');
    hideVoiceBarSoon(1600);
  }

  /**
   * 一句口语 → 一条打点。
   * 策略：先按当前时间戳落点、把口语原文存进去（绝不丢内容），
   *      再让 AI 整理成规范笔记；整理失败就保留原文。
   */
  function handleVoiceText(raw) {
    var text = String(raw || '').trim();
    if (!text) return;

    // continuous 模式下同一句可能被重复回调，3 秒内同文去重
    var key = text.replace(/\s+/g, '');
    var now = Date.now();
    if (key === voice.lastText && now - voice.lastAt < 3000) return;
    voice.lastText = key;
    voice.lastAt = now;

    var t = round2(player.getTime());
    var marker = {
      id: uid('m'),
      time: t,
      note: text,
      color: PALETTE[0],   // 普通打点统一用主题蓝，颜色仍可在笔记里手动改
      source: 'voice',
      createdAt: now,
    };

    state.markers.push(marker);
    state.markers.sort(byTime);
    state.activeId = marker.id;
    state.tab = 'notes';
    if (thumbQueue.indexOf(marker.id) < 0) thumbQueue.push(marker.id);
    delete thumbFailed[marker.id];

    persist();
    renderAll();
    markActive(marker.id);
    grabThumb(marker.id);

    // 没配 AI 就别浪费一次请求：口语原文本身已经是一句可用笔记
    if (!window.LabAI || !window.LabAI.isConfigured()) {
      toast('已语音打点 · ' + fmt(t) + '（未配置 AI，保留口语原文）');
      showVoiceBar('已打点 ' + fmt(t) + '：' + text);
      return;
    }

    voice.pending += 1;
    showVoiceBar('已打点 ' + fmt(t) + '，正在整理成规范笔记…');

    window.LabAI.polishSpeech(text)
      .then(function (clean) {
        marker.note = clean;
        persist();
        renderNotes();
        renderTimeline();
        markActive(marker.id);
        toast('语音笔记已规范化 · ' + fmt(t));
        showVoiceBar('已生成：' + clean);
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : '整理失败';
        toast('已保留口语原文，AI 整理失败：' + msg, 'warn');
        showVoiceBar('AI 整理失败，已保留口语原文');
        if (/40[13]|未配置/.test(msg)) handleAIError(err, '语音笔记整理失败');
      })
      .then(function () {
        voice.pending -= 1;
        if (!voice.active) hideVoiceBarSoon(2400);
      });
  }

  /* ---------------- AI 设置 ---------------- */

  /** 把表单里当前的值收集起来（测试连接用，不落盘） */
  function formAISettings() {
    return {
      baseUrl: els.aiBaseUrl.value.trim(),
      apiKey: els.aiKey.value.trim(),
      model: els.aiModel.value.trim() || 'deepseek-v4.1-flash-1017',
      visionModel: els.aiVisionModel.value.trim(),
    };
  }

  /** 测试结果写回弹层，成功绿色、失败红色，失败时把服务端原话完整展示出来 */
  function setTestResult(state, text) {
    var box = els.aiTestResult;
    box.classList.remove('is-ok', 'is-bad', 'is-busy');
    if (!state) { box.textContent = ''; return; }
    box.classList.add(state === 'ok' ? 'is-ok' : state === 'busy' ? 'is-busy' : 'is-bad');
    box.textContent = text;
  }

  function fillPresetOptions() {
    var list = window.LabAI.PRESETS || [];
    els.aiPreset.innerHTML = '';
    list.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      els.aiPreset.appendChild(opt);
    });
  }

  /** 根据 baseUrl 猜当前用的是哪家，保证打开弹层时下拉框状态是对的 */
  function guessPresetId(baseUrl) {
    var list = window.LabAI.PRESETS || [];
    var hit = 'custom';
    list.forEach(function (p) {
      if (p.baseUrl && baseUrl && baseUrl.indexOf(p.baseUrl.replace(/\/v1$/, '')) === 0) hit = p.id;
    });
    return hit;
  }

  function applyPreset(id) {
    var p = window.LabAI.presetOf(id);
    if (!p) return;
    if (p.id !== 'custom') {
      els.aiBaseUrl.value = p.baseUrl;
      els.aiModel.value = p.model;
      els.aiVisionModel.value = p.visionModel;
    }
    els.aiPresetNote.textContent = p.note || '';
    setTestResult(null);
  }

  function openAISettings() {
    if (!window.LabAI) return;
    var s = window.LabAI.settings();
    els.aiBaseUrl.value = s.baseUrl || '';
    els.aiKey.value = s.apiKey || '';
    els.aiModel.value = s.model || '';
    els.aiVisionModel.value = s.visionModel || '';

    fillPresetOptions();
    els.aiPreset.value = guessPresetId(s.baseUrl);
    var p = window.LabAI.presetOf(els.aiPreset.value);
    els.aiPresetNote.textContent = (p && p.note) || '';
    setTestResult(null);

    els.aiMask.classList.remove('is-hidden', 'is-closing');
    setTimeout(function () { els.aiKey.focus(); }, 60);
  }

  function closeAISettings() {
    fadeClose(els.aiMask);
  }

  /** 只测试、不保存：用表单里的临时值打一发最小请求 */
  /** 拉取当前 gateway 的模型列表，填进 datalist，顺手把关键模型数报出来
   *  用意：现场换 key / 换服务商时，能立刻确认「这个模型名到底存不存在」，
   *  而不是靠猜模型名反复试错。 */
  function listAIModels() {
    var btn = els.btnAIList;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '拉取中…';
    setTestResult('busy', '正在请求模型列表…');

    window.LabAI.listModels(formAISettings())
      .then(function (list) {
        var box = els.aiModelOptions;
        box.innerHTML = '';
        list.forEach(function (id) {
          var opt = document.createElement('option');
          opt.value = id;
          box.appendChild(opt);
        });

        // 挑「能看图」的模型给用户参考。
        // 注意要排除 realtime / asr / tts 这类语音模型——名字里带 omni 但不走图片输入
        var vision = list.filter(function (id) {
          if (/realtime|asr|tts|livetranslate|speech|embedding|rerank/i.test(id)) return false;
          return /(^|[^a-z])(vl|vision)/i.test(id) || /omni|4v|4\.\d-v/i.test(id);
        });
        var lines = [
          '共 ' + list.length + ' 个模型，已填入模型输入框的下拉候选。',
          vision.length ? '可识帧的多模态模型：' + vision.slice(0, 6).join('、') : '',
        ].filter(Boolean);
        setTestResult('ok', lines.join('\n'));
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : '获取模型列表失败';
        setTestResult('bad', '❌ ' + msg);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = label;
      });
  }

  function testAISettings() {
    var btn = els.btnAITest;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    setTestResult('busy', '正在请求 ' + (els.aiBaseUrl.value.trim() || '(未填 baseUrl)') + ' …');

    window.LabAI.ping(formAISettings())
      .then(function (text) {
        setTestResult('ok', '✅ 连接正常，模型返回：' + text);
        toast('AI 连接正常');
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : 'AI 连接失败';
        setTestResult('bad', '❌ ' + msg);
        toast('AI 连接失败，详情见弹层', 'danger');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = label;
      });
  }

  function saveAISettings() {
    window.LabAI.saveSettings(formAISettings());

    var btn = els.btnAISetSave;
    btn.disabled = true;
    btn.textContent = '测试中…';
    setTestResult('busy', '配置已保存，正在验证连通性…');

    window.LabAI.ping()
      .then(function (text) {
        setTestResult('ok', '✅ 连接正常，模型返回：' + text);
        toast('AI 连接正常，配置已保存');
        setTimeout(closeAISettings, 1200);
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : 'AI 连接失败';
        setTestResult('bad', '❌ ' + msg + '\n配置已保存，但当前不可用。换一家服务商或换一个 key 再试。');
        toast('AI 连接失败，详情见弹层', 'danger');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '保存并测试';
      });
  }

  function resetAISettings() {
    var s = window.LabAI.resetSettings();
    els.aiBaseUrl.value = s.baseUrl || '';
    els.aiKey.value = s.apiKey || '';
    els.aiModel.value = s.model || '';
    els.aiVisionModel.value = s.visionModel || '';
    els.aiPreset.value = guessPresetId(s.baseUrl);
    setTestResult(null);
    toast('已恢复 config.js 中的默认配置');
  }

  /* ---------------- 导入 / 导出 ---------------- */

  function exportJSON() {
    var payload = {
      app: 'LabMark',
      version: 1,
      vid: state.vid,
      exportedAt: new Date().toISOString(),
      markers: state.markers,
      ranges: state.ranges,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    a.href = url;
    a.download = 'labmark-' + (state.vid || 'demo') + '-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('标注数据已导出');
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var result = window.LabStore.merge(state, data, state.vid);
        state.markers = result.state.markers;
        state.ranges = result.state.ranges;
        persist();
        renderAll();
        toast('已导入标注数据（新增 ' + result.added + ' 条）');
      } catch (err) {
        console.warn(err);
        toast('导入失败：文件格式不正确', 'danger');
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindUI() {
    els.btnPlay.addEventListener('click', function () { player.toggle(); });
    els.btnBack.addEventListener('click', function () { player.seek(player.getTime() - SEEK_STEP); });
    els.btnFwd.addEventListener('click', function () { player.seek(player.getTime() + SEEK_STEP); });

    els.btnMark.addEventListener('click', addMarker);
    els.btnRangeStart.addEventListener('click', setRangeStart);
    els.btnRangeEnd.addEventListener('click', setRangeEnd);
    els.btnDraftCancel.addEventListener('click', cancelDraft);
    els.draftJump.addEventListener('click', function () {
      if (state.draftStart != null) jumpTo(state.draftStart);
    });

    els.btnClearAll.addEventListener('click', clearAll);

    /* ---- 顶部「导出」下拉：Word / PDF / Markdown / JSON ----
     * 之前 Word 只藏在「实验报告初稿」弹层底部，必须先让 AI 生成一次报告才看得到；
     * 现在提到一级入口，没有 AI 报告也能导出（正文用打点记录兜底）。 */
    els.btnExport.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = els.exportMenu.classList.contains('is-hidden');
      els.exportMenu.classList.toggle('is-hidden', !willOpen);
      var grp = els.btnExport.closest('.export-group');
      if (grp) grp.classList.toggle('is-open', willOpen);
    });

    els.exportMenu.addEventListener('click', function (e) {
      var item = e.target.closest('.menu-item');
      if (!item) return;
      closeExportMenu();
      var act = item.dataset.act;
      if (act === 'word') withThumbs(exportWord);
      else if (act === 'pdf') withThumbs(exportPdf);
      else if (act === 'md') exportMarkdown();
      else if (act === 'json') exportJSON();
      else if (act === 'import') els.fileImport.click();
    });

    document.addEventListener('click', function (e) {
      if (!els.exportMenu.classList.contains('is-hidden') && !e.target.closest('.export-group')) {
        closeExportMenu();
      }
    });

    if (els.btnImport) els.btnImport.addEventListener('click', function () { els.fileImport.click(); });

    // 视频库：顶部 VID 徽章与右上角「视频库」都从这里进
    // （原来的「示例视频 / 保利威播放器」二元切换，现在收进库里作为一个条目）
    if (els.btnLibrary) els.btnLibrary.addEventListener('click', openLibrary);
    if (els.vidBadge) els.vidBadge.addEventListener('click', openLibrary);
    els.btnLibClose.addEventListener('click', closeLibrary);
    els.btnLibAdd.addEventListener('click', addLibraryFromInput);

    // 点蒙版空白处关闭
    els.libMask.addEventListener('click', function (e) {
      if (e.target === els.libMask) closeLibrary();
    });

    // 卡片上的「打开 / 移除」用事件代理，列表重渲染后无需重新绑定
    els.libList.addEventListener('click', function (e) {
      var item = e.target.closest('.lib-item');
      if (!item) return;
      var vid = item.dataset.vid || '';

      if (e.target.closest('.lib-del')) {
        var hit = window.LabLibrary.findByVid(vid);
        window.LabLibrary.remove(vid);
        renderLibrary();
        toast('已从视频库移除「' + (hit ? hit.name : vid) + '」，标注数据仍保留在本机');
        return;
      }
      // 「打开」按钮和整条卡片都可以点
      switchVideo(vid === 'demo' ? '' : vid);
    });

    // 输入框里 Ctrl/⌘ + Enter 直接提交
    els.libInput.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        addLibraryFromInput();
      }
    });

    els.fileImport.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importJSON(f);
      e.target.value = '';
    });

    // 标签页
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    // 搜索
    els.search.addEventListener('input', function () {
      state.query = els.search.value.trim();
      renderNotes();
      renderRanges();
      renderSubtitles();
    });

    // 笔记列表：输入 / 自适应高度 / 跳转 / 删除 / 换色
    els.noteList.addEventListener('input', function (e) {
      var ta = e.target;
      if (!ta.classList.contains('note-text')) return;
      var li = ta.closest('.note-item');
      var m = li && findMarker(li.dataset.id);
      if (!m) return;
      m.note = ta.value;
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      markActive(m.id);
      persist();
    });

    els.noteList.addEventListener('click', function (e) {
      var li = e.target.closest('.note-item');
      if (!li) return;
      var id = li.dataset.id;
      var actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      var act = actEl.dataset.act;
      if (act === 'jump') jumpToMarker(id);
      else if (act === 'delete') removeMarker(id);
      else if (act === 'color') setMarkerColor(id, actEl.dataset.color);
      else if (act === 'thumb') {
        var tm = findMarker(id);
        // 有图 → 看大图；虚线占位 → 补拍一张
        if (tm && tm.thumb) openThumb(id);
        else {
          grabThumb(id, true);
          toast('正在重新截取 ' + fmt(tm ? tm.time : 0) + ' 的关键帧…', 'info');
        }
      }
    });

    // 字幕列表：点击条目跳转；空态里的按钮触发生成
    els.subList.addEventListener('click', function (e) {
      if (e.target.closest('#btnSubGenerate')) { generateSubtitles(); return; }
      var li = e.target.closest('.sub-item');
      if (li) jumpToSub(li.dataset.id);
    });

    // 时间轴字幕轨：点击跳转
    els.tlSubs.addEventListener('click', function (e) {
      var btn = e.target.closest('.tl-sub');
      if (!btn) return;
      e.stopPropagation();
      jumpToSub(btn.dataset.id);
    });

    // 区间列表
    els.rangeList.addEventListener('input', function (e) {
      var ta = e.target;
      if (!ta.classList.contains('note-text')) return;
      var li = ta.closest('.range-item');
      var r = li && findRange(li.dataset.id);
      if (!r) return;
      r.note = ta.value;
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      markActive(r.id);
      persist();
    });

    els.rangeList.addEventListener('click', function (e) {
      var li = e.target.closest('.range-item');
      if (!li) return;
      var id = li.dataset.id;
      var actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      var act = actEl.dataset.act;
      if (act === 'jump') jumpToRange(id);
      else if (act === 'delete') removeRange(id);
      else if (act === 'loop') toggleLoop(id);
    });

    bindTimeline();
    bindKeyboard();

    // ---- AI：识帧打点 ----
    els.btnAI.addEventListener('click', aiFrameNote);

    els.btnAIMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      els.aiMenu.classList.toggle('is-hidden');
    });

    els.aiMenu.addEventListener('click', function (e) {
      var item = e.target.closest('.menu-item');
      if (!item) return;
      els.aiMenu.classList.add('is-hidden');
      var act = item.dataset.act;
      if (act === 'frame') aiFrameNote();
      else if (act === 'upload') els.aiFile.click();
      else if (act === 'subtitle') generateSubtitles();
      else if (act === 'settings') openAISettings();
    });

    document.addEventListener('click', function (e) {
      if (!els.aiMenu.classList.contains('is-hidden') && !e.target.closest('.ai-group')) {
        els.aiMenu.classList.add('is-hidden');
      }
    });

    els.aiFile.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      aiUploadNote(f);
      e.target.value = '';
    });

    // ---- AI：复盘报告 ----
    els.btnReport.addEventListener('click', function () {
      if (!requireAI()) return;
      if (!state.markers.length) { toast('先打几个点，AI 才有素材', 'warn'); return; }
      openReport();
    });
    els.btnReportClose.addEventListener('click', closeReport);
    els.btnReportCopy.addEventListener('click', copyReport);
    els.btnReportDownload.addEventListener('click', downloadReport);
    els.btnReportRetry.addEventListener('click', function () {
      if (!requireAI()) return;
      generateReport();
    });
    els.reportMask.addEventListener('click', function (e) {
      if (e.target === els.reportMask) closeReport();
    });

    // ---- AI：实验报告初稿 ----
    els.btnReportDraft.addEventListener('click', function () {
      if (!state.markers.length) { toast('先打几个点，AI 才有素材', 'warn'); return; }
      if (!requireAI()) return;
      openDraftReport();
    });
    els.btnDraftClose.addEventListener('click', closeDraftReport);
    els.btnDraftCopy.addEventListener('click', copyDraftReport);
    els.btnDraftDownload.addEventListener('click', downloadDraftReport);
    els.btnDraftRetry.addEventListener('click', generateDraftReport);
    els.btnDraftRaw.addEventListener('click', toggleDraftRaw);
    els.btnDraftWord.addEventListener('click', exportWord);
    els.btnDraftPDF.addEventListener('click', exportPdf);
    els.draftMask.addEventListener('click', function (e) {
      if (e.target === els.draftMask) closeDraftReport();
    });

    // ---- 关键帧大图预览 ----
    els.btnThumbClose.addEventListener('click', closeThumb);
    els.btnThumbJump.addEventListener('click', function () {
      var id = state.thumbId;
      closeThumb();
      if (id) jumpToMarker(id);
    });
    els.thumbMask.addEventListener('click', function (e) {
      if (e.target === els.thumbMask) closeThumb();
    });

    // ---- 语音打点 ----
    els.btnVoice.addEventListener('click', toggleVoice);
    els.btnVoiceStop.addEventListener('click', stopVoice);
    // 语音不可用时的两条退路
    els.btnVoiceType.addEventListener('click', openVoiceType);
    els.btnVoiceRetry.addEventListener('click', function () {
      voice.retried = false;
      els.btnVoiceRetry.classList.add('is-hidden');
      els.voiceBar.classList.remove('is-error');
      startVoice();
    });
    els.voiceInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitVoiceType(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeVoiceType(false); }
    });

    // ---- A-B 循环播放 ----
    els.btnLoopToggle.addEventListener('click', toggleLoopSmart);
    els.rateSeg.addEventListener('click', function (e) {
      var btn = e.target.closest('.rate-btn');
      if (!btn) return;
      // 循环中：立刻切换播放速度；没开循环：只记住倍速，等开启循环时生效
      if (state.loop.id) { setLoopRate(btn.dataset.rate); return; }
      state.loop.rate = Number(btn.dataset.rate);
      persist();
      renderLoopBar();
      toast('循环倍速 ' + state.loop.rate + 'x');
    });
    els.btnLoopExit.addEventListener('click', function () { stopLoop(); });

    // ---- AI 设置 ----
    els.btnAISetClose.addEventListener('click', closeAISettings);
    els.btnAISetCancel.addEventListener('click', closeAISettings);
    els.btnAISetSave.addEventListener('click', saveAISettings);
    els.btnAITest.addEventListener('click', testAISettings);
    els.btnAIList.addEventListener('click', listAIModels);
    els.btnAIReset.addEventListener('click', resetAISettings);
    els.aiPreset.addEventListener('change', function () {
      applyPreset(els.aiPreset.value);
    });
    els.aiMask.addEventListener('click', function (e) {
      if (e.target === els.aiMask) closeAISettings();
    });

    // 播放器出错时提供降级入口
    els.noticeAction.addEventListener('click', function () {
      clearRetryWatchdog();
      player.switchToDemo('manual');
      hideNotice();
    });

    els.noticeRetry.addEventListener('click', retryPlayer);
    els.noticeDiag.addEventListener('click', runDiagnose);
  }

  function bindTimeline() {
    var track = els.tlTrack;
    var dragging = false;

    function ratioFromEvent(ev) {
      var rect = track.getBoundingClientRect();
      if (!rect.width) return 0;
      return clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    }

    function scrub(ev) {
      if (!canUseVideo()) return;
      jumpTo(ratioFromEvent(ev) * state.duration);
    }

    track.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('.tl-marker') || ev.target.closest('.tl-range')) return;
      dragging = true;
      try { track.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
      scrub(ev);
    });

    track.addEventListener('pointermove', function (ev) {
      if (dragging) scrub(ev);

      // 悬浮读数：鼠标在轨道任意位置（不在旗帜/区间上）时，淡入显示该处时间
      if (ev.target.closest('.tl-marker') || ev.target.closest('.tl-range')) return;
      if (!state.duration) return;
      showTipAt(ev.clientX, '跳到 <b>' + fmt(ratioFromEvent(ev) * state.duration) + '</b>');
    });

    track.addEventListener('pointerleave', function () {
      if (!dragging) hideTip();
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      track.addEventListener(name, function () { dragging = false; });
    });

    // 点击旗帜跳转
    els.tlMarkers.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.tl-marker');
      if (!btn) return;
      ev.stopPropagation();
      jumpToMarker(btn.dataset.id);
    });

    // 点击区间跳到起点
    els.tlRanges.addEventListener('click', function (ev) {
      var band = ev.target.closest('.tl-range');
      if (!band) return;
      ev.stopPropagation();
      jumpToRange(band.dataset.id);
    });

    // 悬浮提示
    els.tlMarkers.addEventListener('mouseover', function (ev) {
      var btn = ev.target.closest('.tl-marker');
      if (!btn) return;
      var m = findMarker(btn.dataset.id);
      if (!m) return;
      var idx = state.markers.slice().sort(byTime).indexOf(m) + 1;
      showTip(btn, '#' + idx + ' <b>' + fmt(m.time) + '</b> ' + escapeHTML(m.note || '未填写笔记'));
    });
    els.tlMarkers.addEventListener('mouseout', function (ev) {
      if (ev.target.closest('.tl-marker')) hideTip();
    });

    els.tlRanges.addEventListener('mouseover', function (ev) {
      var band = ev.target.closest('.tl-range');
      if (!band) return;
      var r = findRange(band.dataset.id);
      if (!r) return;
      showTip(band, '区间 <b>' + fmt(r.start) + ' → ' + fmt(r.end) + '</b> ' + escapeHTML(r.note || '未填写备注'));
    });
    els.tlRanges.addEventListener('mouseout', function (ev) {
      if (ev.target.closest('.tl-range')) hideTip();
    });
  }

  function showTip(anchor, html) {
    var aRect = anchor.getBoundingClientRect();
    showTipAt(aRect.left + aRect.width / 2, html);
  }

  /** 按屏幕横坐标定位的 tooltip（轨道悬浮读数用） */
  function showTipAt(clientX, html) {
    var tip = els.tlTip;
    var tRect = els.timeline.getBoundingClientRect();
    if (!tRect.width) return;

    tip.innerHTML = html;
    // 左右各留 34px，靠近两端时不让气泡被裁掉
    var left = clamp(clientX - tRect.left, 34, tRect.width - 34);
    tip.style.left = left + 'px';
    tip.classList.remove('is-hidden');
  }

  function hideTip() {
    els.tlTip.classList.add('is-hidden');
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

      // 弹层优先：Esc 关闭
      if (e.key === 'Escape') {
        if (els.libMask && !els.libMask.classList.contains('is-hidden')) { closeLibrary(); return; }
        if (!els.thumbMask.classList.contains('is-hidden')) { closeThumb(); return; }
        if (!els.aiMask.classList.contains('is-hidden')) { closeAISettings(); return; }
        if (!els.draftMask.classList.contains('is-hidden')) { closeDraftReport(); return; }
        if (!els.reportMask.classList.contains('is-hidden')) { closeReport(); return; }
        if (typing) t.blur();
        return;
      }

      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.toggle();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          addMarker();
          break;
        case 'a':
        case 'A':
          e.preventDefault();
          aiFrameNote();
          break;
        case 'v':
        case 'V':
          e.preventDefault();
          toggleVoice();
          break;
        case 'l':
        case 'L':
          // L：快速开启/关闭当前高亮区间（或第一个区间）的循环
          e.preventDefault();
          toggleLoopSmart();
          break;
        case 'i':
        case 'I':
          e.preventDefault();
          setRangeStart();
          break;
        case 'o':
        case 'O':
          e.preventDefault();
          setRangeEnd();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.seek(player.getTime() - SEEK_STEP);
          break;
        case 'ArrowRight':
          e.preventDefault();
          player.seek(player.getTime() + SEEK_STEP);
          break;
        default:
          break;
      }
    });
  }

  /* ---------------- 初始化 ---------------- */

  function cacheEls() {
    [
      'modeBadge', 'modeText', 'vidBadge', 'vidBadgeText', 'playerFrame', 'polyvWrap', 'demoWrap',
      'playerNotice', 'noticeText', 'noticeAction', 'noticeDiag', 'noticeRetry', 'btnPlay', 'btnBack', 'btnFwd',
      'tCur', 'tDur', 'btnMark', 'btnRangeStart', 'btnRangeEnd', 'draftBar', 'draftJump',
      'btnDraftCancel', 'timeline', 'tlTrack', 'tlRanges', 'tlMarkers', 'tlPlayhead',
      'tlTicks', 'tlEmpty', 'tlTip', 'cntNotes', 'cntRanges', 'search', 'noteList',
      'rangeList', 'subList', 'cntSubs', 'tlSubs',
      'saveState', 'btnClearAll', 'btnExport', 'btnImport', 'btnLibrary', 'exportMenu',
      // 视频库
      'libMask', 'libList', 'libMeta', 'libInput', 'btnLibAdd', 'btnLibClose',
      'fileImport', 'toastWrap',
      // AI
      'btnAI', 'btnAIMenu', 'aiMenu', 'aiFile',
      'btnReport', 'reportMask', 'reportMeta', 'reportBody', 'reportHint',
      'btnReportClose', 'btnReportCopy', 'btnReportDownload', 'btnReportRetry',
      'aiMask', 'aiBaseUrl', 'aiKey', 'aiModel', 'aiVisionModel',
      'btnAISetClose', 'btnAISetSave', 'btnAISetCancel', 'btnAIReset',
      'aiPreset', 'aiPresetNote', 'aiTestResult', 'btnAITest',
      'btnAIList', 'aiModelOptions',
      // 实验报告初稿
      'btnReportDraft', 'draftMask', 'draftMeta', 'draftBody',
      'btnDraftClose', 'btnDraftCopy', 'btnDraftDownload', 'btnDraftRetry', 'btnDraftRaw',
      'btnDraftWord', 'btnDraftPDF',
      // 关键帧预览
      'thumbMask', 'thumbImg', 'thumbTime', 'thumbNote', 'btnThumbJump', 'btnThumbClose',
      // 语音打点（含手动输入兜底）
      'btnVoice', 'voiceBar', 'voiceTag', 'voiceText', 'btnVoiceStop',
      'voiceInput', 'btnVoiceType', 'btnVoiceRetry',
      // A-B 循环播放
      'loopBar', 'loopRange', 'loopProg', 'rateSeg', 'btnLoopExit',
      'btnLoopToggle', 'loopNote',
    ].forEach(function (id) { els[id] = $(id); });

    els.panelBody = document.querySelector('.panel-body');
    // 循环开关里的文字节点（"循环" / "循环中"），只在渲染时改文本
    els.btnLoopBtnText = els.btnLoopToggle ? els.btnLoopToggle.querySelector('.ls-text') : null;
  }

  function init() {
    cacheEls();

    state.vid = (CFG.vid || '').trim();

    // 读取本地数据（按视频隔离存储）
    var saved = window.LabStore.load(state.vid);
    state.markers = saved.markers;
    state.ranges = saved.ranges;
    state.subtitles = saved.subtitles || [];
    state.report = saved.report;
    state.reportDraft = saved.reportDraft || null;
    state.loop = saved.loop || { id: '', rate: 1 };

    // 自愈：如果上一次 AI 识别还没返回就关了页面 / 刷新了，
    // 笔记会永久停在「AI 识别中…」。这里把它还原成可手写的空骨架。
    var stuck = 0;
    state.markers.forEach(function (m) {
      if (/^AI\s*识别中/.test(String(m.note).trim())) {
        m.note = '【操作描述】\n【易错提醒】';
        stuck += 1;
      }
    });
    if (stuck) persist();

    // 视频库：把当前视频登记进清单 —— 用 ?vid= 直接打开的视频也能在列表里找到自己，
    // 否则用户会疑惑「我正在看的这个怎么不在库里」。
    if (window.LabLibrary) {
      if (window.LabLibrary.isValidVid(state.vid)) window.LabLibrary.add('', state.vid);
      window.LabLibrary.touch(state.vid);
    }

    bindUI();
    renderAll();

    // 从视频库切换过来时落地提示一句：整页重载后不给反馈，用户不知道换没换成功
    try {
      var justSwitched = window.sessionStorage.getItem('labmark.justSwitched');
      if (justSwitched) {
        window.sessionStorage.removeItem('labmark.justSwitched');
        setTimeout(function () { toast('已切换到「' + justSwitched + '」'); }, 600);
      }
    } catch (err) { /* 隐私模式下降级为无提示 */ }

    // 创建播放器（保利威优先，失败自动降级）
    player = new window.LabPlayer({
      vid: state.vid,
      polyvMount: '#polyvWrap',
      demoMount: '#demoWrap',
      demoVideoId: 'demoVideo',
      demoSources: CFG.demoVideoSources || [],
      playerOptions: CFG.playerOptions || {},
    });

    player.on('time', function (t) {
      state.currentTime = t;
      updatePlayhead();
      checkLoop(t);          // A-B 循环：到达 B 点自动跳回 A 点
    });

    player.on('duration', function (d) {
      state.duration = d;
      els.tDur.textContent = fmt(d);
      // 迟到的时长说明视频其实能播，把之前的失败提示收掉
      if (player.mode === 'polyv' && d > 0) {
        hideNotice();
        // 重试后恢复正常：收回历史进度、恢复自动重试额度、给一次成功反馈
        if (playRetry.pending) {
          var back = Math.min(playRetry.resumeAt || 0, Math.max(0, d - 0.2));
          clearRetryWatchdog();
          playRetry.autoUsed = false;
          if (back > 0.5) player.seek(back);
          toast('已重新取到播放凭证，播放恢复正常', '');
        }
      }
      renderTimeline();
      updatePlayhead();
    });

    player.on('state', function (playing) {
      state.playing = playing;
      renderTransport();
    });

    player.on('mode', function (mode) {
      renderMode(mode);
    });

    player.on('ready', function () {
      // 只有真的拿到时长才算「能播」——播放器把 <video> 标签渲染出来不代表拿到了视频源
      if (player.mode === 'polyv' && player.getDuration() > 0) hideNotice();
      state.duration = player.getDuration();
      updatePlayhead();
      renderTimeline();
      restoreLoop();          // 恢复上次的 A-B 循环设置（不自动播放）
      flushThumbQueue();      // 视频终于出画面了：把打点时没截到的关键帧补上
    });

    player.on('error', function (info) {
      var isObj = info && typeof info === 'object';
      var msg = isObj ? info.message : String(info || '播放器异常');
      var advice = isObj ? info.advice : '';
      var code = isObj && info.code ? String(info.code) : '';

      // #003 = 取播放凭证失败，先静默重试一次再打扰用户（实测多为一过性）
      if (player.mode === 'polyv' && code === '003' && !playRetry.autoUsed) {
        playRetry.autoUsed = true;
        showNotice('播放凭证获取失败（#003），正在自动重试…', {});
        setTimeout(retryPlayer, 1200);
        toast('播放凭证获取失败，正在自动重试一次', 'warn');
        return;
      }

      clearRetryWatchdog();
      showNotice(
        msg + (advice ? '\n建议：' + advice : '') + '\n标注功能不受影响，可先「切换示例视频」把流程演完，或点「运行诊断」定位原因。',
        { demo: true, diag: true, retry: true, error: true }
      );
      toast(msg, 'warn');
    });

    player.init();

    // 首次进入的引导
    setTimeout(function () {
      if (!state.markers.length && !state.ranges.length) {
        toast('提示：把视频拖到关键步骤，按 M 或点「添加标记」开始打点');
      }
    }, 1400);

    els.saveState.textContent = state.markers.length + state.ranges.length
      ? '已从本地恢复 · ' + (state.markers.length + state.ranges.length) + ' 条标注'
      : '数据保存在本机浏览器';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
