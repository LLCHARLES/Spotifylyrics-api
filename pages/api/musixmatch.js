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
  // 当请求 macro.subtitles.get 时，同时获取 richsync
  if (target_path === '/ws/1.1/macro.subtitles.get') {
    return await handleMergedRequest(params, res);
  }

  // 原有逻辑：普通代理
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
  console.log('[Musixmatch Proxy] Starting merged request (richsync + subtitles)');

  const usertoken = params.usertoken || '';
  const appId = params.app_id || '';

  // 透传客户端发来的所有参数（namespace, richsync_compact_type 等）
  const baseParams = { ...params };
  delete baseParams.usertoken;
  delete baseParams.app_id;
  baseParams.format = 'json';

  // 并行请求两个接口
  const richsyncPromise = fetchRichsync(baseParams, usertoken, appId);
  const subtitlesPromise = fetchSubtitles(baseParams, usertoken, appId);

  try {
    const [richsyncData, subtitlesData] = await Promise.all([
      richsyncPromise,
      subtitlesPromise
    ]);

    console.log('[Musixmatch Proxy] Richsync status:', richsyncData?.message?.header?.status_code);
    console.log('[Musixmatch Proxy] Subtitles status:', subtitlesData?.message?.header?.status_code);

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