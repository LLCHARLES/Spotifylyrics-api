// pages/api/musixmatch.js

// Musixmatch requires these headers; without x-mxm-app-version the token returns 401 "upgrade".
const MXM_HEADERS = {
  'Accept': 'application/json',
  'x-mxm-app-version': '10.1.1',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { target_path, ...params } = req.query;

  console.log('[Musixmatch Proxy] target_path:', target_path);

  // ========== 合并请求模式 ==========
  // 当请求 macro.subtitles.get 时，同时获取 richsync + subtitles
  if (target_path === '/ws/1.1/macro.subtitles.get') {
    return await handleMergedRequest(params, res);
  }

  // 原有逻辑：普通代理（crowd.track.translations.get 等走这里）
  try {
    const musixmatchUrl = new URL(`https://apic-appmobile.musixmatch.com${target_path}`);

    Object.keys(params).forEach(key => {
      musixmatchUrl.searchParams.append(key, params[key]);
    });
    musixmatchUrl.searchParams.append('format', 'json');

    console.log('[Musixmatch Proxy] Full URL:', musixmatchUrl.toString());

    const response = await fetch(musixmatchUrl.toString(), {
      headers: MXM_HEADERS
    });

    console.log('[Musixmatch Proxy] Response status:', response.status);

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error('[Musixmatch Proxy] Error:', error.message);
    return res.status(500).json({
      error: 'Proxy failed',
      message: error.message
    });
  }
}

// 合并请求处理函数
async function handleMergedRequest(params, res) {
  const usertoken = params.usertoken || '';
  const appId = params.app_id || '';
  const selectedLanguage = params.selected_language || '';

  console.log('[Musixmatch Proxy] selected_language:', selectedLanguage || '(none)');

  // 透传客户端参数，但去掉会导致 Musixmatch restricted 的 part=subtitle_translated
  // 翻译改由 crowd.track.translations.get 获取，代理注入回 subtitle_translated
  const baseParams = { ...params };
  delete baseParams.usertoken;
  delete baseParams.app_id;
  delete baseParams.part;              // 不要让 Musixmatch 返回 restricted subtitle
  delete baseParams.selected_language;  // 原始歌词不需要 selected_language
  baseParams.format = 'json';

  // 并行请求：richsync + subtitles + translations
  const richsyncPromise = fetchRichsync(baseParams, usertoken, appId);
  const subtitlesPromise = fetchSubtitles(baseParams, usertoken, appId);

  // 翻译：subtitle_translated 已被 restricted，改用 crowd.track.translations.get
  let translationsPromise = Promise.resolve(null);
  if (selectedLanguage) {
    console.log('[Musixmatch Proxy] Fetching crowd translations for:', selectedLanguage);
    translationsPromise = fetchTranslations(baseParams, usertoken, appId, selectedLanguage);
  }

  try {
    const [richsyncData, subtitlesData, translationsData] = await Promise.all([
      richsyncPromise,
      subtitlesPromise,
      translationsPromise
    ]);

    console.log('[Musixmatch Proxy] Richsync status:', richsyncData?.message?.header?.status_code);
    console.log('[Musixmatch Proxy] Subtitles status:', subtitlesData?.message?.header?.status_code);
    console.log('[Musixmatch Proxy] Translations status:', translationsData?.message?.header?.status_code);

    // 如果有翻译，把翻译注入到 subtitles 响应的 subtitle_translated 字段中
    // 这样客户端代码不需要改，仍然从 subtitle_translated.subtitle_body 读翻译
    if (translationsData) {
      injectTranslations(subtitlesData, translationsData);
    }

    // 构建合并后的响应（与 macro.subtitles.get 的格式一致）
    const mergedResponse = {
      message: {
        header: {
          status_code: 200,
          execute_time: 0
        },
        body: {
          macro_calls: {
            "track.richsync.get": richsyncData,
            "track.subtitles.get": subtitlesData
          }
        }
      }
    };

    return res.status(200).json(mergedResponse);

  } catch (error) {
    console.error('[Musixmatch Proxy] Merged request failed:', error.message);

    return res.status(500).json({
      message: {
        header: {
          status_code: 500,
          execute_time: 0
        },
        body: {
          macro_calls: {}
        }
      }
    });
  }
}

// 请求 RichSync 逐字歌词
async function fetchRichsync(baseParams, usertoken, appId) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/track.richsync.get');

  const params = {
    ...baseParams,
    usertoken: usertoken,
    app_id: appId
  };

  Object.keys(params).forEach(key => {
    if (params[key]) {
      url.searchParams.append(key, params[key]);
    }
  });

  console.log('[Musixmatch Proxy] Richsync URL:', url.toString());

  try {
    const response = await fetch(url.toString(), {
      headers: MXM_HEADERS
    });

    console.log('[Musixmatch Proxy] Richsync status:', response.status);

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Musixmatch Proxy] Richsync fetch failed:', error.message);
    return {
      message: {
        header: { status_code: 500 },
        body: {}
      }
    };
  }
}

// 请求字幕
async function fetchSubtitles(baseParams, usertoken, appId) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/track.subtitles.get');

  const params = {
    ...baseParams,
    subtitle_format: 'mxm',
    usertoken: usertoken,
    app_id: appId
  };

  Object.keys(params).forEach(key => {
    if (params[key]) {
      url.searchParams.append(key, params[key]);
    }
  });

  console.log('[Musixmatch Proxy] Subtitles URL:', url.toString());

  try {
    const response = await fetch(url.toString(), {
      headers: MXM_HEADERS
    });

    console.log('[Musixmatch Proxy] Subtitles status:', response.status);

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Musixmatch Proxy] Subtitles fetch failed:', error.message);
    return {
      message: {
        header: { status_code: 500 },
        body: {}
      }
    };
  }
}

// 请求 crowd 翻译
async function fetchTranslations(baseParams, usertoken, appId, selectedLanguage) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/crowd.track.translations.get');

  const params = {
    track_spotify_id: baseParams.track_spotify_id,
    q_track: baseParams.q_track,
    q_artist: baseParams.q_artist,
    selected_language: selectedLanguage,
    usertoken: usertoken,
    app_id: appId,
    format: 'json'
  };

  Object.keys(params).forEach(key => {
    if (params[key]) {
      url.searchParams.append(key, params[key]);
    }
  });

  console.log('[Musixmatch Proxy] Translations URL:', url.toString());

  try {
    const response = await fetch(url.toString(), {
      headers: MXM_HEADERS
    });

    console.log('[Musixmatch Proxy] Translations status:', response.status);

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Musixmatch Proxy] Translations fetch failed:', error.message);
    return null;
  }
}

// 把 crowd 翻译注入到 subtitles 响应中，合成 subtitle_translated 字段
// 客户端从 subtitle.subtitle_translated.subtitle_body 读翻译，格式同 subtitle_body:
// [{"text":"翻译文本","time":{"total":123.45}}, ...]
function injectTranslations(subtitlesData, translationsData) {
  try {
    // 从 translationsData 拿到 matched_line → description 的映射
    const translationsList = translationsData?.message?.body?.translations_list;
    if (!Array.isArray(translationsList)) {
      console.log('[Musixmatch Proxy] No translations_list found');
      return;
    }

    const transMap = {};
    for (const entry of translationsList) {
      const t = entry.translation;
      if (!t) continue;
      // API 返回 matched_line 或 subtitle_matched_line，两个都试
      const original = t.matched_line || t.subtitle_matched_line || '';
      const translated = t.description || '';
      if (original && translated) {
        transMap[original] = translated;
      }
    }

    console.log('[Musixmatch Proxy] translations map size:', Object.keys(transMap).length);
    if (Object.keys(transMap).length === 0) {
      console.log('[Musixmatch Proxy] translations map is empty');
      return;
    }

    // 从 subtitlesData 拿到第一条字幕
    const subtitleList = subtitlesData?.message?.body?.subtitle_list;
    if (!Array.isArray(subtitleList) || subtitleList.length === 0) {
      console.log('[Musixmatch Proxy] No subtitle_list found');
      return;
    }

    const subtitle = subtitleList[0].subtitle;
    if (!subtitle) return;

    const subtitleBody = subtitle.subtitle_body;
    if (!subtitleBody) return;

    // 解析原始 subtitle_body，拿到每行的 text 和 time
    const originalLines = JSON.parse(subtitleBody);
    if (!Array.isArray(originalLines)) return;

    // 为每行找到翻译，用原始时间，合成翻译后的 subtitle_body
    const translatedLines = originalLines.map(line => {
      const originalText = line.text || '';
      const translatedText = transMap[originalText] || '';
      return {
        text: translatedText,
        time: line.time   // 保持原始时间，客户端用时间对齐
      };
    });

    // 注入 subtitle_translated 字段，格式和原始 subtitle 一致
    subtitle.subtitle_translated = {
      subtitle_body: JSON.stringify(translatedLines),
      subtitle_language: translationsData?.message?.body?.selected_language || ''
    };

    // 确保 restricted 不为 true
    if (subtitle.restricted === true) {
      subtitle.restricted = false;
    }

    console.log('[Musixmatch Proxy] Injected translations into subtitle_translated');
  } catch (error) {
    console.error('[Musixmatch Proxy] injectTranslations failed:', error.message);
  }
}
