// pages/api/musixmatch.js

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
    const musixmatchUrl = new URL(`https://apic.musixmatch.com${target_path}`);
    
    Object.keys(params).forEach(key => {
      musixmatchUrl.searchParams.append(key, params[key]);
    });
    musixmatchUrl.searchParams.append('format', 'json');
    
    const response = await fetch(musixmatchUrl.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
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
  console.log('[Musixmatch Proxy] 🚀 Starting merged request (richsync + subtitles)');
  
  // 提取参数
  const trackSpotifyId = params.track_spotify_id;
  const qTrack = params.q_track;
  const qArtist = params.q_artist;
  const selectedLanguage = params.selected_language || '';
  const usertoken = params.usertoken || '';
  const appId = params.app_id || '';
  
  // 构建基础查询参数
  const baseParams = {
    track_spotify_id: trackSpotifyId,
    q_track: qTrack,
    q_artist: qArtist,
    format: 'json'
  };
  
  if (selectedLanguage) {
    baseParams.selected_language = selectedLanguage;
  }
  
  // 并行请求两个接口
  const richsyncPromise = fetchRichsync(baseParams, usertoken, appId);
  const subtitlesPromise = fetchSubtitles(baseParams, usertoken, appId, selectedLanguage);
  
  try {
    // 等待两个请求完成
    const [richsyncData, subtitlesData] = await Promise.all([
      richsyncPromise,
      subtitlesPromise
    ]);
    
    // 构建合并后的响应（兼容客户端现有解析逻辑）
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
    
    console.log('[Musixmatch Proxy] ✅ Merged request completed');
    return res.status(200).json(mergedResponse);
    
  } catch (error) {
    console.error('[Musixmatch Proxy] ❌ Merged request failed:', error.message);
    
    // 降级：至少返回一个可用的响应
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
  const url = new URL('https://apic.musixmatch.com/ws/1.1/track.richsync.get');
  
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
  
  console.log('[Musixmatch Proxy] Fetching richsync...');
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
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

// 请求字幕（包含翻译）
async function fetchSubtitles(baseParams, usertoken, appId, selectedLanguage) {
  const url = new URL('https://apic.musixmatch.com/ws/1.1/track.subtitles.get');
  
  const params = {
    ...baseParams,
    subtitle_format: 'mxm',
    usertoken: usertoken,
    app_id: appId
  };
  
  if (selectedLanguage) {
    params.part = 'subtitle_translated';
  }
  
  Object.keys(params).forEach(key => {
    if (params[key]) {
      url.searchParams.append(key, params[key]);
    }
  });
  
  console.log('[Musixmatch Proxy] Fetching subtitles...');
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
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