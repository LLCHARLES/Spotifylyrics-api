// pages/api/musixmatch.js

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

  if (target_path === '/ws/1.1/macro.subtitles.get') {
    return await handleMergedRequest(params, res);
  }

  try {
    const musixmatchUrl = new URL(`https://apic-appmobile.musixmatch.com${target_path}`);
    Object.keys(params).forEach(key => {
      musixmatchUrl.searchParams.append(key, params[key]);
    });
    musixmatchUrl.searchParams.append('format', 'json');

    const response = await fetch(musixmatchUrl.toString(), { headers: MXM_HEADERS });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
}

async function handleMergedRequest(params, res) {
  const usertoken = params.usertoken || '';
  const appId = params.app_id || '';
  const selectedLanguage = params.selected_language || '';

  console.log('[Musixmatch Proxy] selected_language:', selectedLanguage || '(none)');

  const baseParams = { ...params };
  delete baseParams.usertoken;
  delete baseParams.app_id;
  delete baseParams.part;
  delete baseParams.selected_language;
  baseParams.format = 'json';

  const richsyncPromise = fetchRichsync(baseParams, usertoken, appId);
  const subtitlesPromise = fetchSubtitles(baseParams, usertoken, appId);

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

    if (translationsData) {
      injectTranslations(subtitlesData, translationsData);
    }

    const mergedResponse = {
      message: {
        header: { status_code: 200, execute_time: 0 },
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
    return res.status(500).json({
      message: { header: { status_code: 500, execute_time: 0 }, body: { macro_calls: {} } }
    });
  }
}

async function fetchRichsync(baseParams, usertoken, appId) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/track.richsync.get');
  const params = { ...baseParams, usertoken, app_id: appId };
  Object.keys(params).forEach(key => { if (params[key]) url.searchParams.append(key, params[key]); });
  try {
    const response = await fetch(url.toString(), { headers: MXM_HEADERS });
    return await response.json();
  } catch (error) {
    return { message: { header: { status_code: 500 }, body: {} } };
  }
}

async function fetchSubtitles(baseParams, usertoken, appId) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/track.subtitles.get');
  const params = { ...baseParams, subtitle_format: 'mxm', usertoken, app_id: appId };
  Object.keys(params).forEach(key => { if (params[key]) url.searchParams.append(key, params[key]); });
  try {
    const response = await fetch(url.toString(), { headers: MXM_HEADERS });
    return await response.json();
  } catch (error) {
    return { message: { header: { status_code: 500 }, body: {} } };
  }
}

async function fetchTranslations(baseParams, usertoken, appId, selectedLanguage) {
  const url = new URL('https://apic-appmobile.musixmatch.com/ws/1.1/crowd.track.translations.get');
  const params = {
    track_spotify_id: baseParams.track_spotify_id,
    q_track: baseParams.q_track,
    q_artist: baseParams.q_artist,
    selected_language: selectedLanguage,
    usertoken,
    app_id: appId,
    format: 'json'
  };
  Object.keys(params).forEach(key => { if (params[key]) url.searchParams.append(key, params[key]); });
  try {
    const response = await fetch(url.toString(), { headers: MXM_HEADERS });
    return await response.json();
  } catch (error) {
    return null;
  }
}

function injectTranslations(subtitlesData, translationsData) {
  try {
    const translationsList = translationsData?.message?.body?.translations_list;
    if (!Array.isArray(translationsList)) return;

    const transMap = {};
    for (const entry of translationsList) {
      const t = entry.translation;
      if (!t) continue;
      const original = t.matched_line || t.subtitle_matched_line || '';
      const translated = t.description || '';
      if (original && translated) transMap[original] = translated;
    }

    if (Object.keys(transMap).length === 0) return;

    const subtitleList = subtitlesData?.message?.body?.subtitle_list;
    if (!Array.isArray(subtitleList) || subtitleList.length === 0) return;

    const subtitle = subtitleList[0].subtitle;
    if (!subtitle || !subtitle.subtitle_body) return;

    const originalLines = JSON.parse(subtitle.subtitle_body);
    if (!Array.isArray(originalLines)) return;

    const translatedLines = originalLines.map(line => ({
      text: transMap[line.text || ''] || '',
      time: line.time
    }));

    subtitle.subtitle_translated = {
      subtitle_body: JSON.stringify(translatedLines),
      subtitle_language: translationsData?.message?.body?.selected_language || ''
    };

    if (subtitle.restricted === true) subtitle.restricted = false;
  } catch (error) {
    console.error('[Musixmatch Proxy] injectTranslations failed:', error.message);
  }
}