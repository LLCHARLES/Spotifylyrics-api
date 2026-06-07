// pages/api/musixmatch.js

export default async function handler(req, res) {
  // CORS 设置
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { target_path, ...params } = req.query;
  
  if (!target_path) {
    return res.status(400).json({ error: 'Missing target_path parameter' });
  }
  
  // Musixmatch API 地址
  const MUSIXMATCH_API = 'https://apic.musixmatch.com';
  const MUSIXMATCH_TOKEN = process.env.MUSIXMATCH_TOKEN;
  
  // 构建完整 URL
  const url = `${MUSIXMATCH_API}${target_path}`;
  
  // 构建查询参数
  const queryParams = new URLSearchParams();
  
  // 添加所有参数
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null) {
      queryParams.append(key, params[key]);
    }
  });
  
  // 如果没有传 usertoken，使用环境变量
  if (!params.usertoken && MUSIXMATCH_TOKEN) {
    queryParams.append('usertoken', MUSIXMATCH_TOKEN);
  }
  
  // 添加格式参数
  queryParams.append('format', 'json');
  
  const fullUrl = `${url}?${queryParams.toString()}`;
  
  console.log('[Musixmatch Proxy] Requesting:', target_path);
  console.log('[Musixmatch Proxy] Params:', Object.keys(params));
  
  try {
    const response = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'VercelMusixmatchProxy/1.0',
        'Accept': 'application/json'
      }
    });
    
    const data = await response.json();
    
    // 返回与 Musixmatch 完全相同的响应格式
    res.status(response.status).json(data);
    
  } catch (error) {
    console.error('[Musixmatch Proxy] Error:', error.message);
    res.status(500).json({ 
      error: 'Proxy failed', 
      message: error.message,
      status_code: 500
    });
  }
}
