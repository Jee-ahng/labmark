/* ==========================================================================
 * config.js —— LabMark 全局配置
 *
 * 【开箱即用】
 *   默认 VID 使用保利威官方公开示例视频，双击 index.html 即可看到真实的
 *   保利威点播播放器（已实测：播放、暂停、timeupdate、seek 全部正常）。
 *
 * 【换成你自己的实验视频】——两条路，推荐第一条
 *   1. 页面上点顶部「VID xxx」徽章 → 视频库 → 底部粘贴 VID（支持一次粘多行），
 *      不写代码就能在多个视频之间切换，数据各存各的。详见 README 5.6。
 *   2. 写死：登录保利威后台 → 点播 → 视频列表复制 VID（形如 xxx_8），
 *      打开 index.html 时带上参数 index.html?vid=你的VID，
 *      或者直接把下面 DEFAULT_VID 改成你的 VID 并重新保存。
 *   页面顶部徽章会显示「保利威播放器 · 已接入」和当前 VID
 *
 * 【没网 / 没配 VID 时怎么看演示】
 *   打开 index.html?demo=1 —— 会切换到随项目附带的 40 秒操作示意片段
 *   （assets/media/demo-lab.webm，同源、51ms 就绪、可随机 seek），
 *   标注、笔记、区间、缩略图、本地存储全部功能照常，断网也能完整演示。
 * ========================================================================== */

(function () {
  'use strict';

  /* 保利威点播视频 VID
   * 当前默认：账号新上传的实验视频（02:44，化学滴定/加热操作）
   * 备用示例视频 VID：88083abbf5bcf1356e05d39666be527a_8（保利威官方公开示例） */
  var DEFAULT_VID = '003e81afbb9372cee82d370d135661b1_0';

  /* URL 参数：?vid=xxx 指定视频；?demo=1 强制演示模式 */
  var params = new URLSearchParams(window.location.search);
  var vid = params.has('demo') ? '' : (params.get('vid') || DEFAULT_VID);

  window.LABMARK_CONFIG = {
    /* 当前使用的 VID；为空字符串表示演示模式 */
    vid: vid,

    /* ------------------------------------------------------------------
     * 视频库：页面顶部的「VID」徽章点开就是它（清单本身存在 localStorage）
     *
     * 为什么不能自动列出账号下所有视频：
     *   保利威 VOD 的视频列表接口要用 secretkey 参与签名，secretkey 放进
     *   前端等于公开泄露；接口也不允许浏览器跨域直连。本项目是纯前端、
     *   无后端，所以改为「手工登记 VID」，页面上支持一次粘贴多行。
     *
     * 下面两条是内置条目：只在首次出现，永远排在最前、不可删除。
     * 你自己的视频加进这里也生效，但更推荐直接在页面上添加（不用改代码）。
     * ------------------------------------------------------------------ */
    videoLibrary: [
      { vid: DEFAULT_VID, name: '化学滴定 · 实验演示' },
      { vid: '88083abbf5bcf1356e05d39666be527a_8', name: '保利威官方示例视频' },
    ],

    /* 是否由 ?demo=1 主动进入演示模式（用于区分提示文案） */
    demoRequested: params.has('demo'),

    /* 切回保利威播放器时使用的 VID */
    fallbackVid: params.get('vid') || DEFAULT_VID,

    /* 播放器创建参数（透传给保利威 SDK） */
    playerOptions: {
      width: '100%',
      height: '100%',
      autoplay: false,
    },

    /* 演示模式使用的示例视频（未配置 VID / SDK 不可用时启用，按顺序回退）
     *
     * 选源标准三条，缺一不可：
     *   1) **必须同源或带 Access-Control-Allow-Origin**。关键帧缩略图要先把画面
     *      画到 canvas 再读像素，跨域且没给 CORS 头时 canvas 会被判定污染
     *      （Tainted canvases），toDataURL 直接抛 SecurityError —— 缩略图一张都出不来。
     *   2) **加载要快**。演示模式常在赛场弱网下被启用，外链动辄 5~46MB、首帧要等
     *      十秒以上，看起来就像「播放器坏了」，而且此时打点根本截不到图。
     *   3) **能 seek**。时间戳跳转、缩略图取帧都依赖随机定位。
     *
     * 所以首选是随仓库一起分发的本地片段（40 秒 / 960×540 / 4MB，同源、51ms 就绪、
     * 随机 seek 正常）。外链只作兜底 —— 它们是「有没有网」的问题，不该成为
     * 「能不能用」的前提。 */
    demoVideoSources: [
      'assets/media/demo-lab.webm',
      'https://vjs.zencdn.net/v/oceans.mp4',
      'https://media.w3.org/2010/05/sintel/trailer.mp4',
    ],

    /* localStorage 键前缀：实际键为 `${prefix}:${vid 或 demo}` */
    storageKeyPrefix: 'labmark.v1',

    /* 标记可选颜色（科技简约配色） */
    palette: ['#2b7fd4', '#14b8c4', '#e8a33c', '#e2667d', '#8a7bf0'],

    /* 快进 / 快退步长（秒） */
    seekStep: 5,

    /* 区间最短时长（秒） */
    minRangeSeconds: 1,

    /* ------------------------------------------------------------------
     * AI 能力配置：阿里云百炼（DashScope）OpenAI 兼容模式
     *
     * 当前接的是「DeepSeek v4.1 Flash」（百炼模型广场里的 deepseek-v4.1-flash-1017）。
     * 它和 DeepSeek 官方是两套东西：
     *   - 域名是 dashscope.aliyuncs.com，不是 api.deepseek.com
     *   - 模型名带版本号后缀 -1017
     *   - 这串 sk-ws- 开头的 key 属于百炼，拿到 DeepSeek 官方域名去用必然是 401
     *
     * 这个模型是「推理模型 + 多模态」：会先输出 reasoning_content（思考过程），
     * 再输出 content（正文）；也支持图片输入，所以识帧可以复用同一个模型。
     * 由此带来两条必须注意的实现细节（ai.js 里已处理）：
     *   1. max_tokens 要把思考过程算进去，给太小会出现「正文为空」
     *   2. 判断成败不能只看 content 是否为空，要结合 finish_reason
     *
     * 安全提示：key 放在前端代码里，任何打开页面的人都能看到。
     *   比赛本地演示可接受；一旦部署到公网，务必改为服务端中转。
     *   本仓库是公开的，因此这里的 apiKey 留空 —— 页面右上角「AI 设置」
     *   填一次即可（存 localStorage，不进代码、不进 Git），不用改代码就能换 key / 换模型。
     *   本地私钥请只在自己机器上填，别提交。
     * ------------------------------------------------------------------ */
    ai: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      /* 公开仓库不落任何真实密钥：留空即可，页面上点右上角「AI 设置」填一次就会
         存到浏览器 localStorage，不进代码、不进 Git。想写死也可以填在这里，
         但请确认仓库是私有的。 */
      apiKey: '',
      model: 'deepseek-v4.1-flash-1017',
      /* 识帧（模式 A）用：留空表示与文本模型相同。该模型本身支持图片输入。 */
      visionModel: 'deepseek-v4.1-flash-1017',
      supportsVision: true,
      /* 推理模型首字延迟略高，超时给足 */
      timeout: 90000,
    },
  };
})();
