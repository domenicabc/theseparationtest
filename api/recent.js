
const RECENT_KEY = 'tst:v1:recent';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!process.env.UPSTASH_REDIS_REST_URL ||
      !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({
      error: 'Recent searches are not configured.'
    });
  }

  try {
    const response = await fetch(
      process.env.UPSTASH_REDIS_REST_URL,
      {
        method: 'POST',
        headers: {
          Authorization:
            `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          'ZREVRANGE',
          RECENT_KEY,
          0,
          3
        ])
      }
    );

    if (!response.ok) {
      throw new Error(`Upstash HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error || !Array.isArray(data.result)) {
      throw new Error('Unexpected Upstash response');
    }

    const names = data.result.filter(
      x => typeof x === 'string' && x.length <= 90
    );

    return res.status(200).json({ names });

  } catch (error) {
    console.error(
      'Recent searches fetch failed:',
      error?.message
    );

    return res.status(503).json({
      error: 'Recent searches are temporarily unavailable.'
    });
  }
}
