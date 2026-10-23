/* ==========================================================================
 * ai.js —— LabMark AI 能力层（DeepSeek 兼容 OpenAI Chat Completions 协议）
 *
 * 两个能力，对应两种 mode：
 *   mode = "frame_note"   → noteFromFrame(dataUrl)
 *       输入当前视频帧截图，输出严格两行：【操作描述】/【易错提醒】
 *   mode = "gen_report"   → report({markers, ranges, ...})
 *       输入全部打点记录，输出固定 4 个模块的复盘报告
 *
 * 配置优先级：localStorage('labmark.ai') > config.js 里的 ai 字段
 * 这样比赛现场不用改代码，页面上就能换 key / 换模型。
 * ========================================================================== */

window.LabAI = (function () {
  'use strict';

  var CFG = window.LABMARK_CONFIG || {};
  var BASE_CFG = CFG.ai || {};
  var STORE_KEY = 'labmark.ai';

  /* ---------------- 配置 ---------------- */

  function settings() {
    var s = {
      baseUrl: BASE_CFG.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: BASE_CFG.apiKey || '',
      model: BASE_CFG.model || 'deepseek-v4.1-flash-1017',
      visionModel: BASE_CFG.visionModel || '',
      supportsVision: BASE_CFG.supportsVision !== false,
      timeout: BASE_CFG.timeout || 60000,
    };
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {};
      Object.keys(saved).forEach(function (k) {
        if (saved[k] !== '' && saved[k] !== null && saved[k] !== undefined) s[k] = saved[k];
      });
    } catch (err) { /* 忽略脏配置 */ }
    return s;
  }

  function saveSettings(patch) {
    var cur = {};
    try { cur = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (err) { cur = {}; }
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    window.localStorage.setItem(STORE_KEY, JSON.stringify(cur));
    return settings();
  }

  function resetSettings() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (err) { /* 忽略 */ }
    return settings();
  }

  function isConfigured() {
    var s = settings();
    return !!(s.baseUrl && s.apiKey);
  }

  /* ---------------- 服务商预设 ----------------
   * 全部走 OpenAI 兼容协议，换一家只要换 baseUrl + 模型名。
   * 模型名只是「能跑通」的示例，界面里可随时改。 */
  var PRESETS = [
    {
      id: 'bailian', name: '阿里云百炼（当前默认）',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'deepseek-v4.1-flash-1017', visionModel: 'deepseek-v4.1-flash-1017',
      note: 'DeepSeek v4.1 Flash，推理 + 多模态，同一模型可识帧。注意域名是 dashscope 而非 deepseek 官方',
    },
    {
      id: 'deepseek', name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', visionModel: '',
      note: 'deepseek-chat 是纯文本模型，识帧需要另配多模态模型',
    },
    {
      id: 'siliconflow', name: '硅基流动 SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct', visionModel: 'Qwen/Qwen2-VL-72B-Instruct',
      note: '注册送额度，识帧可直接用 Qwen2-VL',
    },
    {
      id: 'zhipu', name: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash', visionModel: 'glm-4v-flash',
      note: 'glm-4-flash 有免费额度，glm-4v-flash 支持图片',
    },
    {
      id: 'moonshot', name: 'Moonshot Kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k', visionModel: 'moonshot-v1-8k-vision-preview',
      note: '需要实名认证后开通',
    },
    {
      id: 'ollama', name: '本地 Ollama（无需 key）',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b', visionModel: 'llava',
      note: '本地跑模型，key 随便填（如 local）；需先 ollama pull',
    },
    {
      id: 'custom', name: '自定义 / 自建网关',
      baseUrl: '', model: '', visionModel: '',
      note: '只要实现了 /chat/completions 就能接',
    },
  ];

  function presetOf(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  /* ---------------- 请求封装 ---------------- */

  function endpoint(baseUrl) {
    return String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  }

  function normalizeError(status, body) {
    var detail = '';
    try {
      var j = JSON.parse(body);
      detail = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || '';
    } catch (err) { detail = String(body || '').slice(0, 160); }

    // 服务端原话一定要带上：401 的 message 里通常直接写明 key 前缀和无效原因
    var tail = detail ? '（服务端返回：' + detail + '）' : '';

    if (status === 401) return 'AI 接口 401：key 无效，或与当前 baseUrl 不匹配' + tail;
    if (status === 403) return 'AI 接口 403：无权访问该模型' + tail;
    if (status === 404) return 'AI 接口 404：接口地址或模型名不存在，请检查 baseUrl / model' + tail;
    if (status === 429) return 'AI 接口 429：请求过于频繁或额度用尽，稍后重试' + tail;
    if (status === 400) return 'AI 接口 400：请求被拒绝（多为模型名不对或不支持图片）' + tail;
    if (status >= 500) return 'AI 服务异常（' + status + '）' + tail;
    return 'AI 请求失败（' + status + '）' + tail;
  }

  /** 去掉模型偶尔自作主张加的 ``` / ```markdown 围栏和首尾空行 */
  function cleanText(raw) {
    var s = String(raw == null ? '' : raw).trim();
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    return s.trim();
  }

  /**
   * 调一次 chat/completions。
   *
   * 返回 Promise<{ text, finish, reasoning, model, usage }>，而不是直接返回字符串，
   * 因为现在的模型可能是「推理模型」（如 deepseek-v4.1-flash）：
   *   - 它会先花 token 输出 reasoning_content（思考过程），再输出 content（正文）
   *   - max_tokens 太小 → 全被思考过程吃掉，content 变成空字符串
   * 所以调用方需要能拿到 finish_reason 才能判断「是空回复」还是「被截断」。
   *
   * opts.override  : 临时覆盖配置（测试连接用，不落盘）
   * opts.allowEmpty: 允许正文为空（ping 用，只要 HTTP 200 就算连通）
   */
  function chat(messages, opts) {
    var s = settings();
    opts = opts || {};

    // 允许临时覆盖（「测试连接」用表单值试一把，不写进 localStorage）
    if (opts.override) {
      Object.keys(opts.override).forEach(function (k) {
        if (opts.override[k]) s[k] = opts.override[k];
      });
    }

    if (!s.apiKey) return Promise.reject(new Error('未配置 AI key，请在「AI 设置」中填写'));
    if (!s.baseUrl) return Promise.reject(new Error('未配置 AI 接口地址'));

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, s.timeout);

    var payload = {
      model: opts.model || s.model,
      messages: messages,
      temperature: opts.temperature == null ? 0.3 : opts.temperature,
      max_tokens: opts.maxTokens || 900,
      stream: false,
    };

    return fetch(endpoint(s.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + s.apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) throw new Error(normalizeError(res.status, text));
          var json;
          try { json = JSON.parse(text); } catch (err) { throw new Error('AI 返回内容不是合法 JSON'); }

          var choice = (json && json.choices && json.choices[0]) || null;
          var msg = (choice && choice.message) || {};
          var content = cleanText(msg.content);
          var finish = choice ? choice.finish_reason : null;
          var reasoning = String(msg.reasoning_content || '');

          // 正文为空的三种情况要分清楚，否则用户只会看到一句没用的「返回为空」
          if (!content && !opts.allowEmpty) {
            if (finish === 'length') {
              throw new Error('模型把 max_tokens 全用在思考过程上了，正文为空。请重试，或在 AI 设置里调大输出长度');
            }
            if (reasoning) {
              throw new Error('模型只输出了思考过程，没有给出正文。请重试，或在 AI 设置里调大输出长度');
            }
            throw new Error('AI 返回为空，请重试');
          }

          return {
            text: content,
            finish: finish,
            reasoning: reasoning,
            model: json.model || payload.model,
            usage: json.usage || null,
            emptyReasoning: !content && !!reasoning,
          };
        });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw new Error('AI 请求超时（' + Math.round(s.timeout / 1000) + 's）');
        if (err instanceof TypeError) throw new Error('网络异常：无法访问 AI 接口（可能是跨域或网络不通）');
        throw err;
      })
      .then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  /* ---------------- 取帧 ---------------- */

  function drawToJpeg(source, width, height, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality == null ? 0.86 : quality); // 跨域画面会在这里抛 SecurityError
  }

  /**
   * 截取当前播放画面为 JPEG dataURL。
   * 保利威视频在 CDN 上（带 Access-Control-Allow-Origin: *），
   * 但 SDK 创建的 <video> 未必带 crossOrigin，直接画到 canvas 再读取会被判定跨域。
   * 兜底方案：用同源地址新建一个带 crossOrigin='anonymous' 的 video，seek 到同一时刻再取帧。
   */
  function captureFrame(video, maxWidth) {
    maxWidth = maxWidth || 720;

    if (!video || !video.videoWidth) {
      return Promise.reject(new Error('当前没有可截取的画面'));
    }

    var scale = Math.min(1, maxWidth / video.videoWidth);
    var w = Math.round(video.videoWidth * scale);
    var h = Math.round(video.videoHeight * scale);

    try {
      return Promise.resolve(drawToJpeg(video, w, h));
    } catch (err) {
      return captureWithCorsVideo(video, w, h);
    }
  }

  function captureWithCorsVideo(video, w, h) {
    return new Promise(function (resolve, reject) {
      var src = video.currentSrc || video.src;
      if (!src) { reject(new Error('无法获取视频地址，截图失败')); return; }

      var target = video.currentTime || 0;

      var clone = document.createElement('video');
      clone.crossOrigin = 'anonymous';
      clone.muted = true;
      clone.playsInline = true;
      clone.preload = 'auto';
      clone.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';

      var done = false;
      var timer = setTimeout(function () {
        finish(new Error('截图超时，请重试'));
      }, 8000);

      function cleanup() {
        clearTimeout(timer);
        clone.removeEventListener('loadedmetadata', onMeta);
        clone.removeEventListener('loadeddata', onData);
        clone.removeEventListener('seeked', onSeeked);
        clone.removeEventListener('error', onError);
        if (clone.parentNode) clone.parentNode.removeChild(clone);
      }

      /** 取到可用画面后落盘；err 有值表示失败 */
      function finish(err) {
        if (done) return;
        done = true;
        if (err) { cleanup(); reject(err); return; }
        try {
          var dataUrl = drawToJpeg(clone, w, h);
          cleanup();
          resolve(dataUrl);
        } catch (e) {
          cleanup();
          reject(new Error('该视频源不允许截图，请改用「上传截图识别」'));
        }
      }

      function onMeta() {
        // 起点在 0 秒时不需要 seek，等 loadeddata 直接取帧
        if (target > 0.05) clone.currentTime = target;
      }

      function onData() {
        if (Math.abs(clone.currentTime - target) <= 0.15) finish();
      }

      function onSeeked() {
        finish();
      }

      function onError() {
        finish(new Error('视频帧加载失败，截图失败'));
      }

      clone.addEventListener('loadedmetadata', onMeta);
      clone.addEventListener('loadeddata', onData);
      clone.addEventListener('seeked', onSeeked);
      clone.addEventListener('error', onError);

      document.body.appendChild(clone);
      clone.src = src;
    });
  }

  /** 读取本地图片文件为 dataURL（模式 A 也支持直接上传截图） */
  function fileToDataURL(file, maxWidth) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('请选择图片文件')); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, (maxWidth || 720) / img.width);
          try {
            resolve(drawToJpeg(img, Math.round(img.width * scale), Math.round(img.height * scale)));
          } catch (err) { reject(new Error('图片读取失败')); }
        };
        img.onerror = function () { reject(new Error('图片格式不支持')); };
        img.src = String(reader.result);
      };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  /* ---------------- 模式 A：单帧识别 ---------------- */

  var FRAME_PROMPT =
    '请识别这张实验视频截图中的操作，严格按下面两行输出，不要输出任何其它内容：\n' +
    '【操作描述】一句话说明当前操作，不超过25字\n' +
    '【易错提醒】提炼1个典型易错点，不超过30字\n' +
    '要求：理工科实验通用（电路、化学、金工、生物等），专业但通俗。\n' +
    '如果画面模糊、看不清实验器材或操作，固定输出：\n' +
    '【操作描述】画面识别失败\n' +
    '【易错提醒】无法识别当前实验操作，请手动记录';

  function clip(str, max) {
    var s = String(str || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^【[^】]*】/, '').trim();
    if (s.length > max) s = s.slice(0, max - 1) + '…';
    return s;
  }

  /** 解析模型输出；格式不符返回 null（由上层决定降级方式） */
  function parseNote(text) {
    var op = /【操作描述】\s*([^\n【]*)/.exec(text || '');
    var warn = /【易错提醒】\s*([^\n【]*)/.exec(text || '');
    if (!op || !warn) return null;
    return {
      op: clip(op[1], 25),
      warn: clip(warn[1], 30),
      raw: text,
    };
  }

  function noteFromFrame(dataUrl) {
    var s = settings();
    if (!s.supportsVision) {
      return Promise.reject(new Error('当前模型未开启图片输入（config.ai.supportsVision）'));
    }

    var messages = [
      { role: 'system', content: '你是 LabMark 高校实验教学智能助手，服务理工科大学生的实验视频复盘。只输出规定格式，不要寒暄、不要解释、不要额外说明。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: FRAME_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];

    return chat(messages, { model: s.visionModel || s.model, maxTokens: 1500, temperature: 0.2 })
      .then(function (res) {
        var parsed = parseNote(res.text);
        if (!parsed) throw new Error('AI 返回格式异常，请重试');
        return parsed;
      });
  }

  /* ---------------- 模式 B：复盘报告 ---------------- */

  function fmtClock(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '--:--';
    var total = Math.floor(sec);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(secs) : pad(m) + ':' + pad(secs);
  }

  function buildReportPrompt(data) {
    var lines = [];
    lines.push('下面是某高校实验课视频的复盘打点记录（时间戳 + 学生笔记），请生成结构化复盘报告。');
    lines.push('');
    lines.push('严格输出以下 4 个模块，标题一字不改，不要添加开场白、总结语或额外说明：');
    lines.push('1. 📌 实验时间线：按时序精简梳理全部操作步骤');
    lines.push('2. ⚠️ 高频易错汇总：合并提取所有标记里的风险、错误操作');
    lines.push('3. ✅ 实验复盘建议：给出2~3条预习/重做优化建议');
    lines.push('4. 📝 小结：一句话概括本次实验核心重点');
    lines.push('');
    lines.push('约束：文字精炼，贴合大学实验报告；标记少时不要凭空编造内容。');
    lines.push('');
    lines.push('【视频信息】时长 ' + fmtClock(data.duration) + '，标记 ' + data.markers.length + ' 条，重点区间 ' + data.ranges.length + ' 段');

    lines.push('');
    lines.push('【打点记录】');
    data.markers.slice().sort(function (a, b) { return a.time - b.time; }).forEach(function (m, i) {
      var note = String(m.note || '').replace(/\s*\n\s*/g, ' / ').trim() || '（未填写笔记）';
      lines.push((i + 1) + '. [' + fmtClock(m.time) + '] ' + note);
    });

    if (data.ranges.length) {
      lines.push('');
      lines.push('【重点区间】');
      data.ranges.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (r, i) {
        var note = String(r.note || '').replace(/\s*\n\s*/g, ' / ').trim() || '（未填写备注）';
        lines.push((i + 1) + '. [' + fmtClock(r.start) + ' - ' + fmtClock(r.end) + '] ' + note);
      });
    }

    return lines.join('\n');
  }

  function report(data) {
    var messages = [
      { role: 'system', content: '你是 LabMark 高校实验教学智能助手，擅长把实验视频的零散笔记整理成规范的大学实验复盘报告。只输出报告正文，不要寒暄、不要解释、不要代码块。' },
      { role: 'user', content: buildReportPrompt(data) },
    ];
    // 推理模型会先花一部分 token 思考，这里给足额度，避免报告写到一半被截断
    return chat(messages, { maxTokens: 4000, temperature: 0.35 })
      .then(function (res) {
        if (res.finish === 'length') {
          throw new Error('报告输出被截断（max_tokens 用尽），请重试；标记很多时可分批生成');
        }
        return res.text;
      });
  }

  /* ---------------- 实验报告初稿（6 章结构，可直接交给老师） ---------------- */

  /* 业务 prompt 原文照录：结构由产品定义，不在这里做二次加工，
   * 改需求时只改这一段即可。 */
  var REPORT_DRAFT_PROMPT = [
    '你是LabMark实验报告助手，帮助大学生根据自己的实验视频打点记录，生成一份规范的大学实验报告初稿。',
    '',
    '输入：一组实验视频打点记录，每条格式为【时间戳 + 学生笔记/AI笔记】。',
    '任务：基于这些标记，生成一份结构完整、可以直接交给老师的实验报告初稿。学生只需要手动补填原始数据、计算结果和签名即可。',
    '',
    '严格按照以下结构输出，不要额外寒暄：',
    '# 实验报告：{根据内容推测的实验名称}',
    '## 一、实验目的',
    '（根据标记内容推测2~3条实验目的，语言规范）',
    '## 二、实验器材',
    '（列出可能用到的仪器、试剂，不确定的写"待补充"）',
    '## 三、实验步骤',
    '（按时间顺序，把打点记录整理成连贯的步骤描述，每一步前加序号，简洁专业）',
    '## 四、注意事项与误差分析',
    '（从所有"易错提醒"类标记中提炼，分点列出）',
    '## 五、数据记录',
    '（留空表格或模板，提示学生在此填入实测数据）',
    '## 六、思考题与小结',
    '（基于实验内容，提出1~2个可深入思考的问题，并给出一句话小结）',
    '',
    '约束：',
    '- 只根据输入的打点记录生成，标记里没提到的器材/步骤不要瞎编，标注"待学生补充"',
    '- 语言符合大学理工科实验报告规范，不要口语化',
    '- 控制篇幅，不要太长，学生后续还要自己改',
    '- 如果输入记录太少（少于3条），开头加一句"⚠️ 当前标记较少，报告内容仅供参考，请补充完整后再生成"',
  ].join('\n');

  /** 打点记录 → 纯文本清单（时间戳 + 笔记），作为报告生成的上下文 */
  function buildRecordLines(markers) {
    var lines = ['【打点记录】'];
    (markers || []).slice().sort(function (a, b) { return a.time - b.time; }).forEach(function (m, i) {
      var note = String(m.note || '').replace(/\s*\n\s*/g, ' / ').trim() || '（未填写笔记）';
      lines.push((i + 1) + '. [' + fmtClock(m.time) + '] ' + note);
    });
    return lines.join('\n');
  }

  /**
   * 生成实验报告初稿（Markdown 原文）。
   * 返回 Promise<string>，字符串可直接渲染 / 复制 / 下载。
   */
  function reportDraft(data) {
    var markers = (data && data.markers) || [];

    var messages = [
      { role: 'system', content: '你是LabMark实验报告助手。严格按用户给定的结构与约束输出，只输出报告正文，不要寒暄、不要解释、不要用 ``` 代码块包裹。' },
      { role: 'user', content: REPORT_DRAFT_PROMPT + '\n\n' + buildRecordLines(markers) },
    ];

    return chat(messages, { maxTokens: 6000, temperature: 0.3 }).then(function (res) {
      if (res.finish === 'length') {
        throw new Error('报告输出被截断（输出长度用尽），请重试');
      }
      var text = res.text;

      // 少于 3 条必须带提示语。模型经常会漏，所以代码兜一层，保证一定出现。
      if (markers.length < 3 && text.indexOf('当前标记较少') === -1) {
        text = '⚠️ 当前标记较少，报告内容仅供参考，请补充完整后再生成\n\n' + text;
      }
      return text;
    });
  }

  /* ---------------- 语音打点：口语 → 规范实验笔记 ---------------- */

  var SPEECH_PROMPT = [
    '你是LabMark实验笔记整理助手。',
    '输入：学生在实验现场随口说的一句话（语音转写文本，通常口语化、有语气词、不完整）。',
    '任务：把这句口语整理成一句规范、简洁的实验笔记，方便学生直接保存在视频打点里。',
    '要求：',
    '1. 去掉所有语气词、口头禅（"哦""那个""就是""然后""哎呀"等）',
    '2. 把口语化表达改成实验记录语言',
    '3. 保留学生想表达的关键信息，不要脑补额外内容',
    '4. 只输出整理后的那一句话，不要加解释、不要加引号、不要前后寒暄',
    '5. 控制在30字以内',
    '示例：',
    '输入："哦刚才那个开关要往左拧不然烧表"',
    '输出："开关逆时针旋转，注意防止表头过载"',
  ].join('\n');

  /** 硬性截到 max 字，去掉被截断后挂在末尾的标点，避免出现「……，」这种尾巴 */
  function cutTo(str, max) {
    var s = String(str || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max).replace(/[，,、；;：:\s]+$/, '');
  }

  /**
   * 把一句口语整理成规范实验笔记。
   * 模型可能会带引号 / 前缀 / 多行，这里统一洗掉，只留一句话。
   */
  function polishSpeech(text) {
    var raw = String(text || '').trim();
    if (!raw) return Promise.reject(new Error('没有识别到语音内容'));

    var messages = [
      { role: 'system', content: '你是LabMark实验笔记整理助手，只输出整理后的那一句话。' },
      { role: 'user', content: SPEECH_PROMPT + '\n\n输入："' + raw + '"' },
    ];

    return chat(messages, { maxTokens: 900, temperature: 0.2 }).then(function (res) {
      var out = String(res.text || '')
        .split(/\r?\n/)
        .map(function (s) { return s.trim(); })
        .filter(Boolean)[0] || '';

      out = out
        .replace(/^(整理后|输出|笔记)[:：]\s*/, '')     // 模型偶尔加前缀
        .replace(/^["'“”「『]+|["'“”」』]+$/g, '')      // 去掉成对引号
        .trim();

      if (!out) throw new Error('AI 没有返回有效内容');
      return cutTo(out, 30);
    });
  }

  /* ---------------- 取帧器（复用同一个 CORS 副本 video） ---------------- */

  /**
   * 保利威的 <video> 是跨域且没带 crossOrigin，直接截帧会被 taint。
   * 单次截帧靠 captureWithCorsVideo 每次新建一个副本还能接受，
   * 但「批量抽帧生成字幕」要连续截十几张，反复建元素太慢也太浪费。
   * 这里复用一个副本 video，串行 seek → 截帧，第一帧之后每帧只要 100~300ms。
   */
  function makeGrabber(sourceVideo) {
    var clone = null;
    var loaded = null;
    var chain = Promise.resolve();
    var lastSrc = '';
    /* 主 video 能不能直接读像素：null = 还没试过，false = 跨域污染（之后一律走副本） */
    var directOk = null;

    /** 主画面就在眼前且没被跨域污染时，直接取当前帧（最快，也不用重新下载视频） */
    function tryDirectAt(time, maxWidth, quality) {
      if (directOk === false) return null;
      if (!sourceVideo || !sourceVideo.videoWidth) return null;
      // 只在这个时间戳确实就是当前画面时才直取，否则宁可走副本 seek
      if (Math.abs((sourceVideo.currentTime || 0) - time) > 0.4) return null;

      var scale = Math.min(1, (maxWidth || 320) / sourceVideo.videoWidth);
      var w = Math.max(2, Math.round(sourceVideo.videoWidth * scale));
      var h = Math.max(2, Math.round(sourceVideo.videoHeight * scale));
      try {
        var url = drawToJpeg(sourceVideo, w, h, quality == null ? 0.75 : quality);
        directOk = true;
        return url;
      } catch (err) {
        directOk = false;   // 污染了，后面都走副本
        return null;
      }
    }

    function ensureClone() {
      var src = sourceVideo && (sourceVideo.currentSrc || sourceVideo.src);
      if (!src) return Promise.reject(new Error('无法获取视频地址'));

      if (clone && lastSrc === src && clone.readyState >= 1) return loaded;

      if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
      clone = document.createElement('video');
      clone.crossOrigin = 'anonymous';
      clone.muted = true;
      clone.playsInline = true;
      clone.preload = 'auto';
      clone.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(clone);
      lastSrc = src;

      loaded = new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          reject(new Error('视频帧加载超时'));
        }, 12000);
        clone.addEventListener('loadedmetadata', function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(clone);
        }, { once: true });
        clone.addEventListener('error', function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          /* 副本加载失败最常见的两个原因：
           *   1) 视频源没给 Access-Control-Allow-Origin（跨域取帧必失败）
           *   2) 源是 m3u8 / 需要鉴权的直链，裸 <video> 播不了
           * 清掉副本，下次打点重新建一次，不至于一次失败就永久没图。 */
          console.warn('[LabMark] 关键帧副本加载失败，源：', src);
          if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
          clone = null;
          loaded = null;
          lastSrc = '';
          reject(new Error('视频帧加载失败'));
        }, { once: true });
      });
      clone.src = src;
      return loaded;
    }

    function grabAt(time, maxWidth, quality) {
      return ensureClone().then(function (v) {
        return new Promise(function (resolve, reject) {
          var dur = v.duration || 0;
          var t = Math.min(Math.max(0, time), Math.max(0, dur - 0.15));
          var vw = v.videoWidth || 320;
          var vh = v.videoHeight || 180;
          var scale = Math.min(1, (maxWidth || 320) / vw);
          var w = Math.max(2, Math.round(vw * scale));
          var h = Math.max(2, Math.round(vh * scale));

          function finish() {
            try { resolve(drawToJpeg(v, w, h, quality == null ? 0.75 : quality)); }
            catch (e) { reject(new Error('该视频源不允许截图')); }
          }

          // 已经在目标位置，直接取
          if (Math.abs(v.currentTime - t) < 0.06 && v.readyState >= 2) {
            setTimeout(finish, 70);
            return;
          }

          var done = false;
          var timer = setTimeout(function () {
            if (done) return;
            done = true;
            finish();
          }, 5000);

          v.addEventListener('seeked', function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            // seeked 之后画面不一定已经绘制，留一帧的时间
            setTimeout(finish, 90);
          }, { once: true });

          try { v.currentTime = t; }
          catch (e) { done = true; clearTimeout(timer); finish(); }
        });
      });
    }

    return {
      grab: function (time, maxWidth, quality) {
        var direct = tryDirectAt(time, maxWidth, quality);
        if (direct) return Promise.resolve(direct);

        var p = chain.then(function () { return grabAt(time, maxWidth, quality); });
        chain = p.catch(function () { });   // 单次失败不阻断后续
        return p;
      },
      destroy: function () {
        if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
        clone = null;
        loaded = null;
        lastSrc = '';
      },
    };
  }

  /** 把已有 dataURL 缩到指定宽度（缩略图用，避免把 720px 的图整张存进 localStorage） */
  function downscale(dataUrl, maxWidth, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, (maxWidth || 320) / img.width);
          resolve(drawToJpeg(
            img,
            Math.max(1, Math.round(img.width * scale)),
            Math.max(1, Math.round(img.height * scale)),
            quality == null ? 0.72 : quality
          ));
        } catch (e) {
          reject(new Error('缩略图生成失败'));
        }
      };
      img.onerror = function () { reject(new Error('缩略图生成失败')); };
      img.src = dataUrl;
    });
  }

  /* ---------------- AI 分段字幕 ---------------- */

  var SUBTITLE_PROMPT = [
    '你在看一段实验教学录像的关键帧，共 {N} 张，按时间先后顺序排列。',
    '请为每一张写一句不超过 20 个字的客观中文，说明画面里正在进行的实验操作或现象。',
    '要求：',
    '1. 只描述画面里确实存在的东西，不要推测画面之外的内容；',
    '2. 优先说「在做什么操作」，其次说「用了什么仪器 / 出现了什么现象」；',
    '3. 不要出现「图中」「画面中」「可以看到」这类废话，也不要重复时间戳；',
    '4. 严格按下面格式输出，一张一行，序号必须与给出的编号完全一致，不要输出任何其它内容：',
    '1|这一帧的一句话说明',
    '2|这一帧的一句话说明',
  ].join('\n');

  /**
   * 一批关键帧 → 与输入顺序对齐的字幕文本数组。
   * 一次请求处理多帧，比逐帧请求快得多（推理模型每次都有一笔固定的思考开销）。
   */
  function subtitlesForFrames(frames) {
    if (!frames || !frames.length) return Promise.reject(new Error('没有可分析的画面'));

    var content = [{ type: 'text', text: SUBTITLE_PROMPT.replace('{N}', String(frames.length)) }];
    frames.forEach(function (f, i) {
      content.push({ type: 'text', text: '第 ' + (i + 1) + ' 张（' + f.timeText + '）：' });
      content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
    });

    return chat([{ role: 'user', content: content }], { maxTokens: 4000, temperature: 0.2 })
      .then(function (res) {
        var out = String(res.text || '');
        var map = {};
        out.split(/\r?\n/).forEach(function (line) {
          var m = line.trim().match(/^(\d+)\s*[|｜:：.、]\s*(.+)$/);
          if (!m) return;
          var idx = Number(m[1]) - 1;
          if (idx < 0 || idx >= frames.length) return;
          var text = m[2]
            .replace(/^["'“”「『]+|["'“”」』]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text && !map[idx]) map[idx] = cutTo(text, 30);
        });

        var result = frames.map(function (f, i) { return map[i] || ''; });
        if (!result.filter(Boolean).length) throw new Error('AI 没按格式返回字幕，请重试');
        return result;
      });
  }

  /** 连通性测试：保存设置时用，避免用户存了一个不能用的 key */
  function ping(override) {
    return chat([{ role: 'user', content: '请只回复两个字：正常' }], {
      // 推理模型光思考就要几十个 token，给太小会「正文为空」而被误判成失败
      maxTokens: 512,
      temperature: 0,
      override: override,
      allowEmpty: true,   // 只要接口 200，就说明 key / 地址 / 模型名都是对的
    }).then(function (res) {
      return res.text || '（模型返回了思考过程）';
    });
  }

  /** 拉取该网关可用的模型列表（诊断用：确认模型名到底对不对） */
  function listModels(override) {
    var s = settings();
    if (override) {
      Object.keys(override).forEach(function (k) {
        if (override[k]) s[k] = override[k];
      });
    }
    if (!s.apiKey) return Promise.reject(new Error('未配置 AI key'));

    var url = String(s.baseUrl).replace(/\/+$/, '') + '/models';

    return fetch(url, {
      headers: { Authorization: 'Bearer ' + s.apiKey },
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error(normalizeError(res.status, text));
        var json;
        try { json = JSON.parse(text); } catch (err) { throw new Error('模型列表不是合法 JSON'); }
        return (json.data || []).map(function (m) { return m.id; }).filter(Boolean);
      });
    }).catch(function (err) {
      if (err instanceof TypeError) throw new Error('网络异常：无法访问模型列表接口');
      throw err;
    });
  }

  return {
    PRESETS: PRESETS,
    presetOf: presetOf,
    isConfigured: isConfigured,
    settings: settings,
    saveSettings: saveSettings,
    resetSettings: resetSettings,
    captureFrame: captureFrame,
    makeGrabber: makeGrabber,
    downscale: downscale,
    fileToDataURL: fileToDataURL,
    noteFromFrame: noteFromFrame,
    parseNote: parseNote,
    subtitlesForFrames: subtitlesForFrames,
    SUBTITLE_PROMPT: SUBTITLE_PROMPT,
    report: report,
    buildReportPrompt: buildReportPrompt,
    reportDraft: reportDraft,
    REPORT_DRAFT_PROMPT: REPORT_DRAFT_PROMPT,
    polishSpeech: polishSpeech,
    fmtClock: fmtClock,
    ping: ping,
    listModels: listModels,
  };
})();
