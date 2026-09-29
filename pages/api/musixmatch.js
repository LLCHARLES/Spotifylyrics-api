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

  // 所有请求直接透传给 Musixmatch，只加 headers
  try {
    const musixmatchUrl = new URL(`https://apic-appmobile.musixmatch.com${target_path}`);

    Object.keys(params).forEach(key => {
      if (params[key]) {
        musixmatchUrl.searchParams.append(key, params[key]);
      }
    });
    if (!musixmatchUrl.searchParams.has('format')) {
      musixmatchUrl.searchParams.append('format', 'json');
    }

    console.log('[Musixmatch Proxy] URL:', musixmatchUrl.toString());

    const response = await fetch(musixmatchUrl.toString(), {
      headers: MXM_HEADERS
    });

    console.log('[Musixmatch Proxy] status:', response.status);

    const data = await response.json();

    // 翻译注入：当请求带 selected_language 时，用 crowd.track.translations.get
    // 获取翻译，注入到 subtitle_translated 字段（Musixmatch 返回 restricted=1）
    const selectedLanguage = params.selected_language;
    if (selectedLanguage && target_path === '/ws/1.1/macro.subtitles.get') {
      console.log('[Musixmatch Proxy] selected_language:', selectedLanguage);
      const usertoken = params.usertoken || '';
      const appId = params.app_id || '';
      const trackSpotifyId = params.track_spotify_id || '';
      const qTrack = params.q_track || '';
      const qArtist = params.q_artist || '';

      if (trackSpotifyId || (qTrack && qArtist)) {
        const translationsData = await fetchTranslations(
          trackSpotifyId, qTrack, qArtist, selectedLanguage, usertoken, appId
        );

        if (translationsData) {
          console.log('[Musixmatch Proxy] Translations status:',
            translationsData?.message?.header?.status_code);
          injectTranslations(data, translationsData);
        }
      }
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('[Musixmatch Proxy] Error:', error.message);
    return res.status(500).json({
      error: 'Proxy failed',
      message: error.message
    });
  }
}

// 请求 crowd 翻译
async function fetchTranslations(trackSpotifyId, qTrack, qArtist, selectedLanguage, usertoken, appId) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/crowd.track.translations.get');

  const params = {
    track_spotify_id: trackSpotifyId,
    q_track: qTrack,
    q_artist: qArtist,
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
    const response = await fetch(url.toString(), { headers: MXM_HEADERS });
    console.log('[Musixmatch Proxy] Translations status:', response.status);
    return await response.json();
  } catch (error) {
    console.error('[Musixmatch Proxy] Translations fetch failed:', error.message);
    return null;
  }
}

// 把 crowd 翻译注入到 macro.subtitles.get 响应的 subtitle_translated 字段中
// 客户端从 subtitle.subtitle_translated.subtitle_body 读翻译，格式同 subtitle_body:
// [{"text":"翻译文本","time":{"total":123.45}}, ...]
function injectTranslations(data, translationsData) {
  try {
    const translationsList = translationsData?.message?.body?.translations_list;
    if (!Array.isArray(translationsList)) {
      console.log('[Musixmatch Proxy] No translations_list found');
      return;
    }

    const transMap = {};
    for (const entry of translationsList) {
      const t = entry.translation;
      if (!t) continue;
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

    // 在 macro_calls 里找 track.subtitles.get 的 subtitle_list
    const macroCalls = data?.message?.body?.macro_calls;
    if (!macroCalls) {
      console.log('[Musixmatch Proxy] No macro_calls found');
      return;
    }

    const subtitlesCall = macroCalls['track.subtitles.get'];
    const subtitleList = subtitlesCall?.message?.body?.subtitle_list;
    if (!Array.isArray(subtitleList) || subtitleList.length === 0) {
      console.log('[Musixmatch Proxy] No subtitle_list found');
      return;
    }

    const subtitle = subtitleList[0].subtitle;
    if (!subtitle) return;

    const subtitleBody = subtitle.subtitle_body;
    if (!subtitleBody) return;

    const originalLines = JSON.parse(subtitleBody);
    if (!Array.isArray(originalLines)) return;

    const translatedLines = originalLines.map(line => {
      const originalText = line.text || '';
      const translatedText = transMap[originalText] || '';
      return {
        text: translatedText,
        time: line.time
      };
    });

    subtitle.subtitle_translated = {
      subtitle_body: JSON.stringify(translatedLines),
      subtitle_language: translationsData?.message?.body?.selected_language || ''
    };

    if (subtitle.restricted === true || subtitle.restricted === 1) {
      subtitle.restricted = 0;
    }

    console.log('[Musixmatch Proxy] Injected translations into subtitle_translated');
  } catch (error) {
    console.error('[Musixmatch Proxy] injectTranslations failed:', error.message);
  }
}
