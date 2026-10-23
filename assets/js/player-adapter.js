/* ==========================================================================
 * player-adapter.js —— 播放器适配层
 *
 * 作用：把「保利威点播播放器」与「演示模式原生 video」收敛成同一套接口，
 *       上层业务（打点 / 跳转 / 时间轴）完全不需要关心底层是谁在播。
 *
 * 暴露接口：
 *   player.init()                 初始化（有 VID + SDK 可用 → 保利威；否则演示模式）
 *   player.on('time'|'duration'|'state'|'mode'|'ready'|'error', fn)
 *   player.play() / pause() / toggle()
 *   player.seek(seconds)          定点跳转（保利威走 SDK seek，原生走 currentTime）
 *   player.getTime() / getDuration() / isPlaying()
 *   player.setRate(0.5|0.75|1)    倍速（A-B 循环观察细节用）
 *   player.switchToDemo(reason)   手动降级到演示模式
 *   player.retry()                重建播放器（重新请求播放凭证），用于 #003 这类瞬时失败
 *   player.diagnose()             返回 Promise，自检播放凭证接口，定位「网络不通」还是「视频不可播」
 *
 * error 事件载荷：{ code, vid, message, advice }
 *   code 为保利威错误码字符串（如 '003'），非播放器报错时为空字符串。
 *
 * 关于时间监听：
 *   1) 优先绑定保利威实例事件（timeupdate / onTimeupdate，按 SDK 版本兼容尝试）
 *   2) 同时绑定容器内原生 <video> 的 timeupdate，确保任何情况下都能拿到进度
 *   3) 再加一个 200ms 轮询兜底，保证 UI 永远跟得上播放器
 * ========================================================================== */

window.LabPlayer = (function () {
  'use strict';

  var POLL_MS = 200;

  /* 保利威播放器错误码 → 中文说明
   * 只收录本项目实测过的码（不同播放器皮肤文案不同，不做无依据的猜测）：
   *   #003 → "视频暂时无法播放，请稍后刷新重试 #003" / "Error code: #003"
   *   #004 → "#004 当前视频无法播放，请向管理员反馈"（VID 不存在时即出现）
   * 其余码只展示播放器原话 + 通用建议。 */
  var SDK_ERRORS = {
    '003': {
      title: '获取播放凭证失败',
      advice: '多为瞬时失败（凭证接口被限流 / 代理或插件拦了一次请求 / 后台刚改完播放设置未生效），点「重试播放」通常即可恢复；仍不行再查播放域名白名单与转码状态。',
    },
    '004': {
      title: '当前视频无法播放（VID 不存在、已删除，或本账号无权播放）',
      advice: '核对 VID 是否复制完整（一般以 _0 / _8 结尾），并确认后台视频已发布。',
    },
  };

  function LabPlayer(options) {
    this.opts = options || {};
    this.mode = 'pending';       // 'polyv' | 'demo'
    this.instance = null;        // 保利威播放器实例
    this.videoEl = null;         // 容器内真实 <video> 元素（两种模式通用）
    this.duration = 0;
    this.currentTime = 0;
    this.playing = false;
    this.handlers = {};
    this._pollTimer = null;
    this._watchTimers = [];
    this._sdkHooked = false;
    this._errorEmitted = false;
    this._lastError = null;      // 最近一次结构化错误（诊断时一并输出）
    this._retryCount = 0;        // 已经重建过几次播放器
    this._demoIndex = 0;
    this._destroyed = false;
  }

  /* ---------------- 事件 ---------------- */

  LabPlayer.prototype.on = function (name, fn) {
    (this.handlers[name] || (this.handlers[name] = [])).push(fn);
    return this;
  };

  LabPlayer.prototype._emit = function (name, payload) {
    var list = this.handlers[name] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) { console.error('[LabMark] 事件处理异常', err); }
    }
  };

  /** 统一的时间推送入口：去抖动，避免多路监听导致重复渲染 */
  LabPlayer.prototype._pushTime = function (t) {
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return;
    if (Math.abs(t - this.currentTime) < 0.02) return;
    this.currentTime = t;
    this._emit('time', t);
  };

  LabPlayer.prototype._pushDuration = function (d) {
    if (typeof d !== 'number' || !isFinite(d) || d <= 0) return;
    if (Math.abs(d - this.duration) < 0.2) return;
    this.duration = d;
    this._emit('duration', d);
  };

  /* ---------------- 初始化 ---------------- */

  LabPlayer.prototype.init = function () {
    var hasVid = !!(this.opts.vid && String(this.opts.vid).trim());
    var sdkReady = typeof window.polyvPlayer === 'function';

    if (hasVid && sdkReady) {
      try {
        this._initPolyv();
      } catch (err) {
        console.warn('[LabMark] 保利威播放器初始化失败，自动降级为演示模式', err);
        this._initDemo('sdk-error');
      }
    } else {
      this._initDemo(hasVid ? 'sdk-missing' : 'no-vid');
    }

    this._startPolling();
    return this;
  };

  /** 模式一：保利威官方点播播放器 */
  LabPlayer.prototype._initPolyv = function () {
    var self = this;
    var mount = document.querySelector(this.opts.polyvMount);
    var demoMount = document.querySelector(this.opts.demoMount);
    var options = this.opts.playerOptions || {};

    this.mode = 'polyv';
    mount.classList.remove('is-hidden');
    demoMount.classList.add('is-hidden');
    mount.innerHTML = '';

    // 创建播放器实例
    var params = {
      wrap: this.opts.polyvMount,     // 容器选择器
      width: options.width || '100%',
      height: options.height || '100%',
      vid: String(this.opts.vid).trim(),
      autoplay: false,
    };
    Object.keys(options).forEach(function (k) {
      if (k !== 'width' && k !== 'height') params[k] = options[k];
    });

    this.instance = window.polyvPlayer(params);
    this._emit('mode', 'polyv');

    // 尝试挂载 SDK 事件（不同版本事件名略有差异，全部 try 一次，失败不影响主流程）
    this._hookSdkEvents();

    // 兜底一：盯住播放器自己渲染的错误面板（形如 "Error code: #003"）
    this._watchSdkError();

    // 等播放器把 <video> 渲染出来后接管原生事件
    this._watchVideoElement(9000, function (video) {
      self.videoEl = video;
      self._bindNativeEvents(video);
      self._emit('ready', 'polyv');
    }, function () {
      self._fail(null, null, '播放器 9 秒内没有加载出视频画面，可能是 VID 无效、视频还在转码，或账号限制了播放域名。');
    });

    // 兜底二：<video> 标签可能在、但永远拿不到时长（典型的「黑屏 + 转圈」）
    var startupTimer = setTimeout(function () {
      if (self._destroyed || self._errorEmitted) return;
      if (self.getDuration() <= 0) {
        self._fail(null, null, '播放器已创建，但 9 秒内没拿到视频时长（画面一直黑着），视频源大概率不可播。');
      }
    }, 9200);
    this._watchTimers.push(startupTimer);
  };

  /** 收敛的错误出口：无论来自哪条检测路径，都只对外抛一次结构化错误 */
  LabPlayer.prototype._fail = function (code, sdkCode, message, raw) {
    if (this._errorEmitted) return;
    this._errorEmitted = true;

    var known = sdkCode ? SDK_ERRORS[String(sdkCode)] : null;
    var text = message || '播放器未能正常就绪';

    if (sdkCode) {
      text = '保利威播放器报错 #' + sdkCode + (known ? '：' + known.title : '');
      // 播放器自己写的原话也带上，方便对照后台排查
      if (raw && (!known || raw.indexOf(known.title) === -1)) text += '\n播放器原话：' + raw;
    }

    // 先记录，再抛出：error 回调里可能立刻触发 retry()，它会清空 _lastError
    this._lastError = { code: sdkCode ? String(sdkCode) : '', message: text, at: Date.now() };

    this._emit('error', {
      code: sdkCode ? String(sdkCode) : (code || ''),
      vid: this.opts.vid || '',
      message: text,
      advice: known ? known.advice : '',
    });
  };

  /** 重置「出错」状态与所有就绪判定计时器（重试前必须做，否则新实例的检测会被旧标记挡住） */
  LabPlayer.prototype._resetErrorState = function () {
    this._errorEmitted = false;
    this._lastError = null;
    if (this._sdkErrTimer) { clearInterval(this._sdkErrTimer); this._sdkErrTimer = null; }
    this._watchTimers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    this._watchTimers = [];
  };

  /**
   * 重建保利威播放器 —— 等价于「重新向保利威要一次播放凭证」。
   *
   * 为什么需要它：#003 是凭证获取失败，成因多是瞬时的（接口限流、代理/插件
   * 拦了某一次请求、后台改完播放设置还没生效）。这类失败刷新页面能好，
   * 但刷新会丢掉当前进度和未保存的草稿，所以这里就地重建播放器：
   * 销毁旧实例 → 清空容器 → 用同一个 VID 重新初始化。
   *
   * 返回 false 表示当前不是保利威模式或重建过程中抛错（此时上层应提示降级）。
   */
  LabPlayer.prototype.retry = function () {
    if (this.mode !== 'polyv') return false;

    var mount = document.querySelector(this.opts.polyvMount);
    var demoMount = document.querySelector(this.opts.demoMount);

    this._retryCount += 1;
    this._resetErrorState();

    if (this.videoEl) { try { this.videoEl.pause(); } catch (err) { /* 忽略 */ } }
    if (this.instance && typeof this.instance.destroy === 'function') {
      try { this.instance.destroy(); } catch (err) { /* 个别版本没有 destroy，忽略 */ }
    }
    this.instance = null;
    this.videoEl = null;
    this._sdkHooked = false;
    this.duration = 0;
    this.currentTime = 0;

    if (mount) {
      mount.innerHTML = '';
      mount.classList.remove('is-seeked');
    }
    if (demoMount) demoMount.classList.add('is-hidden');

    try {
      this._initPolyv();
    } catch (err) {
      console.error('[LabMark] 播放器重建失败', err);
      return false;
    }
    return true;
  };

  /** 兜底一：轮询容器文本，捕获播放器渲染出来的 "Error code: #xxx" */
  LabPlayer.prototype._watchSdkError = function () {
    var self = this;
    var mount = document.querySelector(this.opts.polyvMount);
    var start = Date.now();

    var timer = setInterval(function () {
      if (self._destroyed || self._errorEmitted) { clearInterval(timer); return; }
      var video = mount ? mount.querySelector('video') : null;
      if (video && video.readyState >= 2) { clearInterval(timer); return; }   // 已经能播，不再判定
      // 用 textContent 而非 innerText：不触发重排，20 秒内每 400ms 扫一次也没有性能负担
      var text = mount ? (mount.textContent || '') : '';
      // 播放器两套错误皮肤的写法不同：
      //   "Error code: #003"（初始化失败面板） / "视频暂时无法播放，请稍后刷新重试 #003"（播放失败面板）
      var m = /#\s*(\d{3})\b/.exec(text);
      if (m) {
        clearInterval(timer);
        var flat = text.replace(/\s+/g, ' ').trim();
        var pos = flat.search(/#\s*\d{3}/);
        if (pos > 0) flat = flat.slice(0, pos + 6);            // 只取错误码及其前面那句原话
        flat = flat.replace(/\s*\d{1,2}:\d{2}[\s\S]*$/, '');   // 去掉后面的时间码/控件文字
        self._fail(null, m[1], null, flat.slice(0, 56));
        return;
      }
      if (Date.now() - start > 20000) clearInterval(timer);
    }, 400);

    this._sdkErrTimer = timer;
    this._watchTimers.push(timer);
  };

  /** 自检：直接请求播放器用的凭证接口，判断是「网络不通」还是「视频侧不可播」 */
  LabPlayer.prototype.diagnose = function () {
    var vid = String(this.opts.vid || '').trim();
    var lines = [];

    lines.push('页面来源：' + (location.protocol === 'file:' ? '本地文件（file://）' : location.protocol + '//' + location.host));
    lines.push('播放器 SDK：' + (typeof window.polyvPlayer === 'function' ? '已加载' : '未加载'));
    lines.push('当前 VID：' + (vid || '未配置'));

    if (!vid) {
      return Promise.resolve({ ok: false, short: '当前没有配置 VID', summary: lines.join('\n') });
    }

    var probe = function (protocol) {
      var url = protocol + '//player.polyv.net/videojson/' + encodeURIComponent(vid) + '.json';
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;

      return fetch(url, { mode: 'cors', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (res) {
          return res.text().then(function (txt) {
            var body = '', code = 0;
            try { var j = JSON.parse(txt); body = String(j.body || ''); code = j.code; } catch (e) { /* 非 JSON */ }
            return { protocol: protocol, status: res.status, code: code, len: body.length };
          });
        })
        .catch(function (err) {
          return { protocol: protocol, error: err && err.name === 'AbortError' ? '超时' : '请求失败' };
        })
        .then(function (r) { if (timer) clearTimeout(timer); return r; });
    };

    // https 页面只探 https（否则会因混合内容被浏览器直接拦掉，反而误导）
    var protocols = location.protocol === 'https:' ? ['https:'] : ['https:', 'http:'];

    return Promise.all(protocols.map(probe)).then(function (rs) {
      var best = null;
      rs.forEach(function (r) {
        lines.push('凭证接口 ' + r.protocol + '//player.polyv.net：' + (r.error
          ? r.error
          : 'HTTP ' + r.status + ' · code ' + r.code + ' · 数据 ' + r.len + ' 字节'));
        if (!r.error && r.status === 200 && (!best || r.len > best.len)) best = r;
      });

      var verdict;
      // 接口通、凭证也不空，但播放器还是报了 #003 —— 这是「限流 / 插件二次拦截」的典型组合，
      // 结论要落在「重试」而不是「去后台改设置」，否则用户会白折腾一圈
      var lastCode = this._lastError && this._lastError.code;
      if (lastCode) lines.push('播放器报错：# ' + lastCode + '（' + (SDK_ERRORS[lastCode] ? SDK_ERRORS[lastCode].title : '未收录') + '）');

      if (!best) {
        verdict = {
          ok: false,
          short: '播放凭证接口请求失败',
          text: '结论：本机连不上保利威的凭证接口，先查网络 / 代理 / 广告拦截插件，再刷新页面。',
        };
      } else if (best.len < 320) {
        verdict = {
          ok: false,
          short: '凭证内容为空，视频侧不可播',
          text: '结论：接口通了，但返回的凭证是空的 —— 视频多半还在转码、已下线，或被后台的播放安全设置限制。去保利威后台确认视频状态与播放设置。',
        };
      } else if (lastCode === '003') {
        verdict = {
          ok: false,
          short: '凭证接口可达，播放器仍未取到凭证',
          text: '结论：本浏览器的凭证接口是通的（上面返回了 ' + best.len + ' 字节数据），但播放器取凭证仍失败（#003）—— 这通常是瞬时失败：短时间内刷新太多次被限流、代理缓存了旧凭证，或插件拦了播放器发出的那一跳。\n处置：先点「重试播放」（会重建播放器、重新要一次凭证），一般一次就好；连续两三次都失败再停用广告拦截插件 / 换网络 / 关掉代理，或先用示例视频把流程演完。',
        };
      } else {
        verdict = {
          ok: true,
          short: '凭证接口正常',
          text: '结论：凭证接口返回正常。若画面仍然是黑的，多半是浏览器插件 / 代理拦了媒体流，或被后台播放域名白名单挡住；可先用示例视频把流程演完。',
        };
      }
      lines.push(verdict.text);
      return { ok: verdict.ok, short: verdict.short, summary: lines.join('\n') };
    }.bind(this));
  };

  /** 模式二：演示模式（未配置 VID / SDK 不可用时，保证功能闭环可演示） */
  LabPlayer.prototype._initDemo = function (reason) {
    var self = this;
    var mount = document.querySelector(this.opts.polyvMount);
    var demoMount = document.querySelector(this.opts.demoMount);
    var video = document.getElementById(this.opts.demoVideoId || 'demoVideo');

    this.mode = 'demo';
    this._demoReason = reason || 'no-vid';

    if (mount) mount.classList.add('is-hidden');
    if (demoMount) demoMount.classList.remove('is-hidden');
    if (!video) return;

    this.videoEl = video;
    this._bindNativeEvents(video);

    var sources = this.opts.demoSources || [];
    this._loadDemoSource(0);

    this._emit('mode', 'demo');
    this._emit('ready', 'demo');
  };

  LabPlayer.prototype._loadDemoSource = function (index) {
    var self = this;
    var sources = this.opts.demoSources || [];
    if (!this.videoEl || index >= sources.length) {
      this._emit('error', '示例视频加载失败，请检查网络；也可直接在 config.js 填入自己的保利威 VID。');
      return;
    }
    this._demoIndex = index;
    this.videoEl.src = sources[index];
    this.videoEl.load();

    var onErr = function () {
      self.videoEl.removeEventListener('error', onErr);
      self._loadDemoSource(index + 1);
    };
    this.videoEl.addEventListener('error', onErr);
  };

  /** 轮询等待播放器内部 <video> 就绪 */
  LabPlayer.prototype._watchVideoElement = function (timeout, onFound, onTimeout) {
    var self = this;
    var mount = document.querySelector(this.opts.polyvMount);
    var start = Date.now();

    var timer = setInterval(function () {
      if (self._destroyed) { clearInterval(timer); return; }
      var v = mount ? mount.querySelector('video') : null;
      if (v) {
        clearInterval(timer);
        onFound(v);
        return;
      }
      if (Date.now() - start > timeout) {
        clearInterval(timer);
        if (onTimeout) onTimeout();
      }
    }, 120);

    this._watchTimers.push(timer);
  };

  /** 绑定原生 video 事件（两种模式都走这里，保证 timeupdate 真实可用） */
  LabPlayer.prototype._bindNativeEvents = function (video) {
    var self = this;

    this._pushDuration(video.duration);

    video.addEventListener('timeupdate', function () {
      self._pushTime(video.currentTime);
    });
    video.addEventListener('durationchange', function () {
      self._pushDuration(video.duration);
    });
    video.addEventListener('loadedmetadata', function () {
      self._pushDuration(video.duration);
      self._emit('ready', self.mode);
    });
    video.addEventListener('play', function () {
      self.playing = true;
      self._emit('state', true);
    });
    video.addEventListener('playing', function () {
      self.playing = true;
      self._emit('state', true);
    });
    video.addEventListener('pause', function () {
      self.playing = false;
      self._emit('state', false);
    });
    video.addEventListener('ended', function () {
      self.playing = false;
      self._emit('state', false);
    });
    video.addEventListener('error', function () {
      if (self.mode === 'polyv') {
        self._fail(null, null, '视频流加载失败，请确认 VID 是否正确、视频是否允许公开播放。');
      }
    });
  };

  /** 尝试使用保利威 SDK 的事件系统（多版本兼容） */
  LabPlayer.prototype._hookSdkEvents = function () {
    if (this._sdkHooked || !this.instance || typeof this.instance.on !== 'function') return;
    var self = this;
    var names = ['timeupdate', 'onTimeupdate', 'videoTimeupdate', 'timeUpdate'];

    names.forEach(function (name) {
      try {
        self.instance.on(name, function () {
          // SDK 回调里直接读取播放器进度
          var t = self.instance.currentTime;
          if (typeof t === 'number') self._pushTime(t);
        });
      } catch (err) {
        /* 该版本不支持此事件名，忽略即可（原生事件 + 轮询已覆盖） */
      }
    });

    this._sdkHooked = true;
  };

  /* ---------------- 播放控制 ---------------- */

  LabPlayer.prototype.play = function () {
    try {
      if (this.mode === 'polyv' && this.instance && typeof this.instance.play === 'function') {
        var ret = this.instance.play();
        if (ret && typeof ret.catch === 'function') ret.catch(function () {});
      } else if (this.videoEl) {
        var p = this.videoEl.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (err) {
      console.warn('[LabMark] play 调用失败', err);
    }
  };

  LabPlayer.prototype.pause = function () {
    try {
      if (this.mode === 'polyv' && this.instance && typeof this.instance.pause === 'function') {
        this.instance.pause();
      } else if (this.videoEl) {
        this.videoEl.pause();
      }
    } catch (err) {
      console.warn('[LabMark] pause 调用失败', err);
    }
  };

  LabPlayer.prototype.toggle = function () {
    if (this.isPlaying()) this.pause();
    else this.play();
  };

  /** 定点跳转：优先使用保利威 SDK 的 seek，保证播放器自身状态同步 */
  LabPlayer.prototype.seek = function (seconds) {
    var target = Number(seconds);
    if (!isFinite(target)) return;
    var max = this.duration || 0;
    target = Math.max(0, max > 0 ? Math.min(target, max - 0.05) : target);

    var seeked = false;
    if (this.mode === 'polyv' && this.instance) {
      if (typeof this.instance.seek === 'function') {
        try { this.instance.seek(target); seeked = true; } catch (err) { /* 降级 */ }
      }
      if (!seeked && typeof this.instance.jumpPlay === 'function') {
        try { this.instance.jumpPlay(target); seeked = true; } catch (err) { /* 降级 */ }
      }
    }
    if (!seeked && this.videoEl) {
      try { this.videoEl.currentTime = target; } catch (err) { /* 忽略 */ }
    }

    this._syncSeekCover(target);

    // 立即同步一次进度，让 UI 不等下一次 timeupdate
    this.currentTime = target;
    this._emit('time', target);
  };

  /**
   * 收起保利威的封面层。
   *
   * 实测现象：视频「一次都没播放过」时，即使把 currentTime 设到 01:41，
   * 播放器仍然显示片头封面图（`.pv-cover` 一直是 display:block），
   * 而底下的 <video> 其实已经停在正确帧上了（截帧拿到的是 01:41 的真实画面）。
   * 结果就是：点时间轴 / 点笔记跳转，用户以为「没跳成功」。
   *
   * 处理：跳离起点就把封面收起来（回到 0 秒再放回去），
   * 播放时保利威自己也会隐藏封面，不冲突。
   */
  LabPlayer.prototype._syncSeekCover = function (target) {
    if (this.mode !== 'polyv') return;
    var mount = document.querySelector(this.opts.polyvMount);
    if (!mount) return;
    if (target > 0.5) mount.classList.add('is-seeked');
    else mount.classList.remove('is-seeked');
  };

  LabPlayer.prototype.getTime = function () {
    if (this.videoEl && typeof this.videoEl.currentTime === 'number') return this.videoEl.currentTime;
    return this.currentTime || 0;
  };

  /**
   * 设置播放倍速（A-B 循环时观察精细操作用）。
   *
   * 两条路都试：
   *   1) 原生 <video>.playbackRate —— 最可靠，演示模式和保利威内嵌 video 都吃这个
   *   2) 保利威 SDK 的 setSpeed / setPlayerSpeed —— 让播放器自己的速度 UI 也同步，
   *      否则用户看到的倍速标签和实际播放速度会不一致
   * 返回值是最终生效的倍速（拿不到就返回传入值）。
   */
  LabPlayer.prototype.setRate = function (rate) {
    var r = Number(rate);
    if (!isFinite(r) || r <= 0) return this.getRate();

    if (this.videoEl) {
      try { this.videoEl.playbackRate = r; } catch (err) { /* 个别内核会拒绝 */ }
      try { this.videoEl.defaultPlaybackRate = r; } catch (err) { /* 忽略 */ }
    }
    if (this.mode === 'polyv' && this.instance) {
      ['setSpeed', 'setPlayerSpeed', 'speed'].forEach(function (m) {
        if (typeof this[m] === 'function') {
          try { this[m](r); } catch (err) { /* 该版本不支持 */ }
        }
      }, this.instance);
    }
    return this.getRate();
  };

  LabPlayer.prototype.getRate = function () {
    if (this.videoEl && isFinite(this.videoEl.playbackRate) && this.videoEl.playbackRate > 0) {
      return this.videoEl.playbackRate;
    }
    return 1;
  };

  LabPlayer.prototype.getDuration = function () {
    if (this.videoEl && isFinite(this.videoEl.duration) && this.videoEl.duration > 0) return this.videoEl.duration;
    return this.duration || 0;
  };

  LabPlayer.prototype.isPlaying = function () {
    if (this.videoEl) return !this.videoEl.paused && !this.videoEl.ended;
    return this.playing;
  };

  /** 手动降级（播放器报错时给用户一个兜底按钮） */
  LabPlayer.prototype.switchToDemo = function (reason) {
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch (err) { /* 忽略 */ }
    }
    if (this.instance && typeof this.instance.destroy === 'function') {
      try { this.instance.destroy(); } catch (err) { /* 忽略 */ }
    }
    this.instance = null;
    this._sdkHooked = false;
    this._initDemo(reason || 'manual');
  };

  /* ---------------- 轮询兜底 ---------------- */

  LabPlayer.prototype._startPolling = function () {
    var self = this;
    if (this._pollTimer) clearInterval(this._pollTimer);

    this._pollTimer = setInterval(function () {
      var v = self.videoEl;
      if (!v) return;

      if (isFinite(v.duration) && v.duration > 0) self._pushDuration(v.duration);
      if (typeof v.currentTime === 'number') self._pushTime(v.currentTime);

      var playing = !v.paused && !v.ended;
      if (playing !== self.playing) {
        self.playing = playing;
        self._emit('state', playing);
      }
    }, POLL_MS);
  };

  LabPlayer.prototype.destroy = function () {
    this._destroyed = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._watchTimers.forEach(function (t) { clearInterval(t); });
    this._watchTimers = [];
  };

  return LabPlayer;
})();
