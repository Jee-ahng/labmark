/* ==========================================================================
 * export.js —— 把实验记录导出成「能直接交给老师」的文档
 *
 * 为什么要有这一层：
 *   AI 生成的是 Markdown，学生拿着一个 .md 文件是交不了作业的 ——
 *   手机打不开、Word 不认、老师也未必知道 md 是什么。
 *   所以这里把「报告正文 + 实验元信息 + 关键帧截图 + 打点清单」拼成一份
 *   A4 文档，可以导出 Word（.doc）或直接打印成 PDF。
 *
 * 两个实现要点：
 *   1. Word 走的是「HTML 伪装成 .doc」这条路（Blob + application/msword）。
 *      Word 对现代 CSS 支持极差，不认 flex / grid，所以版式一律用 <table>，
 *      图片用 width 属性定宽，不靠 CSS。
 *   2. PDF 走浏览器原生打印（隐藏 iframe + window.print），
 *      必须等 base64 图片全部 decode 完再调 print，否则会印出空白。
 * ========================================================================== */

window.LabExport = (function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Word 与打印共用同一套样式表。
   * 单位尽量用 pt，Word 对 px 的换算不如 pt 稳定。 */
  function docCSS() {
    return [
      '@page { size: A4; margin: 18mm 16mm 16mm; }',
      'body { font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;',
      '  font-size: 10.5pt; line-height: 1.75; color: #1f2933; margin: 0; }',
      '.doc { max-width: 100%; }',

      /* 封面区 */
      '.doc-title { font-size: 19pt; font-weight: bold; color: #12324f; margin: 0 0 4pt; letter-spacing: 0.5pt; }',
      '.doc-sub { font-size: 10pt; color: #6b7c8f; margin: 0 0 14pt; }',
      '.doc-rule { border: none; border-top: 1.5pt solid #2b7fd4; margin: 0 0 14pt; }',

      /* 元信息表 */
      'table.meta { width: 100%; border-collapse: collapse; margin: 0 0 18pt; }',
      'table.meta td { padding: 4.5pt 8pt; border: 0.5pt solid #dde6ef; font-size: 9.5pt; vertical-align: top; }',
      'table.meta td.k { width: 22%; background: #f4f8fc; color: #4a5c70; font-weight: bold; }',

      /* 正文（AI 生成的 Markdown 渲染结果） */
      '.doc-body h1 { font-size: 15pt; color: #12324f; margin: 20pt 0 8pt; padding-bottom: 5pt;',
      '  border-bottom: 0.75pt solid #dde6ef; }',
      '.doc-body h2 { font-size: 12.5pt; color: #12324f; margin: 16pt 0 7pt;',
      '  padding-left: 8pt; border-left: 3pt solid #2b7fd4; }',
      '.doc-body h3 { font-size: 11pt; color: #1f4e79; margin: 12pt 0 5pt; }',
      '.doc-body h4 { font-size: 10.5pt; color: #1f4e79; margin: 10pt 0 4pt; }',
      '.doc-body p { margin: 0 0 7pt; }',
      '.doc-body ul, .doc-body ol { margin: 0 0 8pt; padding-left: 20pt; }',
      '.doc-body li { margin-bottom: 3pt; }',
      '.doc-body blockquote { margin: 8pt 0; padding: 7pt 10pt; background: #f6f9fc;',
      '  border-left: 3pt solid #b9d4ee; color: #46586b; }',
      '.doc-body hr { border: none; border-top: 0.5pt solid #dde6ef; margin: 12pt 0; }',
      '.doc-body code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f1f5f9; padding: 1pt 3pt; }',
      '.doc-body table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 9.5pt; }',
      '.doc-body th { background: #eef5fb; border: 0.5pt solid #cdddea; padding: 5pt 7pt;',
      '  text-align: left; color: #23415c; }',
      '.doc-body td { border: 0.5pt solid #dde6ef; padding: 5pt 7pt; vertical-align: top; }',
      '.doc-body .md-alert { color: #a05a00; background: #fff8ec; border-left: 3pt solid #e8a33c;',
      '  padding: 7pt 10pt; margin: 8pt 0; }',
      '.doc-body .md-state { color: #8a97a5; font-style: italic; }',

      /* 关键帧附录 */
      '.sec-title { font-size: 12.5pt; color: #12324f; margin: 18pt 0 8pt;',
      '  padding-left: 8pt; border-left: 3pt solid #14b8c4; }',
      'table.frames { width: 100%; border-collapse: collapse; }',
      'table.frames td { width: 50%; padding: 6pt; border: 0.5pt solid #dde6ef;',
      '  vertical-align: top; page-break-inside: avoid; }',
      'table.frames img { width: 100%; display: block; }',
      '.frame-t { font-size: 9pt; color: #2b7fd4; font-weight: bold; margin-bottom: 2pt; }',
      '.frame-n { font-size: 9pt; color: #46586b; line-height: 1.55; }',

      /* 区间清单 */
      'table.plain { width: 100%; border-collapse: collapse; font-size: 9.5pt; }',
      'table.plain th { background: #eef5fb; border: 0.5pt solid #cdddea; padding: 5pt 7pt; text-align: left; }',
      'table.plain td { border: 0.5pt solid #dde6ef; padding: 5pt 7pt; vertical-align: top; }',

      '.doc-foot { margin-top: 22pt; padding-top: 8pt; border-top: 0.5pt solid #dde6ef;',
      '  font-size: 8.5pt; color: #8a97a5; line-height: 1.6; }',
      '.empty-hint { color: #8a97a5; font-style: italic; padding: 10pt 0; }',
    ].join('\n');
  }

  /** 元信息表：[[键, 值], ...] */
  function metaTable(rows) {
    if (!rows || !rows.length) return '';
    return '<table class="meta">' + rows.map(function (r) {
      return '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
    }).join('') + '</table>';
  }

  /** 关键帧附录：两列一行的表格，Word 与打印都能正常分页 */
  function framesSection(frames) {
    if (!frames || !frames.length) return '';
    var cells = frames.map(function (f) {
      return '<td>' +
        '<div class="frame-t">' + esc(f.time) + '</div>' +
        (f.thumb ? '<img src="' + f.thumb + '" width="300" alt="' + esc(f.time) + '">' : '') +
        '<div class="frame-n">' + esc(f.note || '（这一步还没有写笔记）') + '</div>' +
        '</td>';
    });

    var rows = '';
    for (var i = 0; i < cells.length; i += 2) {
      rows += '<tr>' + cells[i] + (cells[i + 1] || '<td></td>') + '</tr>';
    }
    return '<div class="sec-title">附录 · 实验过程关键帧</div>' +
      '<table class="frames">' + rows + '</table>';
  }

  /** 重点区间清单 */
  function rangesSection(ranges) {
    if (!ranges || !ranges.length) return '';
    var rows = ranges.map(function (r, i) {
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(r.start) + ' → ' + esc(r.end) + '</td>' +
        '<td>' + Math.round(r.dur) + ' 秒</td>' +
        '<td>' + esc(r.note || '—') + '</td>' +
        '</tr>';
    }).join('');

    return '<div class="sec-title">附录 · 重点区间</div>' +
      '<table class="plain"><tr><th style="width:8%">#</th><th style="width:22%">时间段</th>' +
      '<th style="width:14%">时长</th><th>备注</th></tr>' + rows + '</table>';
  }

  /**
   * 拼出完整文档。
   * opts = { title, subtitle, meta, bodyHTML, frames, ranges, footer, forWord }
   */
  function buildHTML(opts) {
    opts = opts || {};
    var body = opts.bodyHTML || '<div class="empty-hint">（尚未生成报告正文，此处为实验过程记录）</div>';

    var inner =
      '<div class="doc">' +
        '<div class="doc-title">' + esc(opts.title || '实验报告') + '</div>' +
        (opts.subtitle ? '<div class="doc-sub">' + esc(opts.subtitle) + '</div>' : '') +
        '<hr class="doc-rule">' +
        metaTable(opts.meta) +
        '<div class="doc-body">' + body + '</div>' +
        framesSection(opts.frames) +
        rangesSection(opts.ranges) +
        (opts.footer ? '<div class="doc-foot">' + esc(opts.footer) + '</div>' : '') +
      '</div>';

    if (!opts.forWord) {
      return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<title>' + esc(opts.title || '实验报告') + '</title>' +
        '<style>' + docCSS() + '</style></head><body>' + inner + '</body></html>';
    }

    /* Word 版本：
     * 必须带 Office 命名空间和 WordSection1，否则 Word 打开是纯文本、分页也乱。 */
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
      'xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8">' +
      '<title>' + esc(opts.title || '实验报告') + '</title>' +
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>' +
      '<w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->' +
      '<style>@page WordSection1 { size: 21cm 29.7cm; margin: 2cm 1.8cm; }' +
      'div.WordSection1 { page: WordSection1; }' + docCSS() + '</style></head>' +
      '<body><div class="WordSection1">' + inner + '</div></body></html>';
  }

  function fileName(base) {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (base || '实验报告') + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /** 导出 Word：HTML 伪装成 .doc，Word / WPS 都能直接打开并继续编辑 */
  function toWord(html, base) {
    // 开头加 BOM，否则 Word 偶尔会按 GBK 解码导致中文乱码
    var blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName(base) + '.doc';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return a.download;
  }

  /** 导出 PDF：隐藏 iframe + 浏览器打印，用户在打印面板里选「另存为 PDF」 */
  function toPDF(html) {
    var frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    // 关键：给一个接近 A4 的真实尺寸再挪到屏幕外。
    // 如果用 1px 宽的 iframe，部分浏览器会按 1px 视口先排版一次，打印出来版式会错。
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;height:1160px;border:0;';
    document.body.appendChild(frame);

    var doc = frame.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    var printed = false;
    function go() {
      if (printed) return;
      printed = true;
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (err) {
        console.warn('[LabMark] 调起打印失败', err);
      }
      // print() 在部分浏览器是同步阻塞的，延迟移除更安全
      setTimeout(function () {
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      }, 2000);
    }

    // 关键：base64 图片没解码完就 print，会印出一堆空白框
    var imgs = doc.images;
    var pending = imgs.length;
    if (!pending) { setTimeout(go, 250); return; }

    var settled = 0;
    function tick() {
      settled += 1;
      if (settled >= pending) setTimeout(go, 220);
    }
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete) tick();
      else {
        imgs[i].addEventListener('load', tick, { once: true });
        imgs[i].addEventListener('error', tick, { once: true });
      }
    }
    setTimeout(go, 5000);   // 兜底：图片卡住也不能让用户干等
  }

  return {
    buildHTML: buildHTML,
    toWord: toWord,
    toPDF: toPDF,
    fileName: fileName,
  };
})();
