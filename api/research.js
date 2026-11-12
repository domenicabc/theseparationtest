const MAX_NAME = 90;
const LIMIT = 8;
const windows = new Map(); // Best-effort per-instance rate limiting; not a global quota.

const DAY_SECONDS = 86400;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const redisReady = () => Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
async function redis(...command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('Shared cache unavailable');
  const body = await response.json();
  if (body.error) throw new Error('Shared cache unavailable');
  return body.result;
}
const cacheKey = name => `tst:v1:person:${name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g,' ').trim()}`;
const parseSaved = raw => {try {return raw ? JSON.parse(raw) : null;}catch{return null;}};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > MAX_NAME || !/^[\p{L}\p{N} .,'’()\-]+$/u.test(name)) return res.status(400).json({error:'Enter a public figure’s name (up to 90 characters).'});
  if (!redisReady()) return res.status(503).json({error:'Shared 24-hour cache is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.'});
  const key = cacheKey(name);
  const lockKey = `${key}:lock`;
  let ownsLock = false;
  try {
    const existing = parseSaved(await redis('GET', key));
    if (existing) return res.status(200).json({...existing, cached:true});
    // Only one deployment can acquire this lock for a given person.
    ownsLock = (await redis('SET', lockKey, 'working', 'NX', 'EX', 90)) === 'OK';
    if (!ownsLock) {
      for (let i=0; i<22; i++) {
        await wait(2000);
        const saved = parseSaved(await redis('GET', key));
        if (saved) return res.status(200).json({...saved, cached:true});
        if (!(await redis('GET', lockKey))) break;
      }
      return res.status(202).json({pending:true,message:'This person is already being researched. Please search again in a moment.'});
    }
    // Check again after obtaining the lock in case a previous request just completed.
    const secondCheck = parseSaved(await redis('GET', key));
    if (secondCheck) return res.status(200).json({...secondCheck, cached:true});
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({error:'Research is not configured yet. Set OPENAI_API_KEY in Vercel.'});
  } catch (err) {
    console.error('Cache failed', err?.message);
    return res.status(503).json({error:'Shared cache unavailable. Research was not started to avoid duplicate charges.'});
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 52000);
    let response;
    try { response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',signal:controller.signal,
      headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:process.env.OPENAI_MODEL || 'gpt-5.4-mini',
        tools:[{type:'web_search',search_context_size:'medium'}],
        tool_choice:'required',
        max_output_tokens:2200,
        instructions:`You are an evidence-conscious cultural ethics researcher. Search the live web for this well-known public figure. Never conflate people with the same name. If identity is ambiguous, or insufficient reliable evidence, set both scores null and explain. Do not invent sources or events. Separate verified conduct from allegations, and avoid stating allegations as fact. Give exactly 5 concise bullet strings for contributions and exactly 5 for ethics when evidence supports them, otherwise fewer and say evidence is insufficient. Be balanced about documented beneficial actions and harms. Scores 0-100 are transparent subjective editorial estimates, NOT objective moral worth; null if evidence is insufficient. Avoid basing moral judgments on protected traits, beliefs, identity, or rumors. Evaluate potential consequences of buying, sharing, studying, criticizing, or financially supporting the person's work, including living/deceased distinctions. Write a contextual philosophical reflection discussing how attention can legitimize harm or enable good, without presuming all engagement is endorsement. Cite credible web evidence in your reasoning. Return ONLY a JSON object with keys: name,identity,confidence (high/medium/low),contributionScore,ethicsScore,contributions (array of strings),ethics (array of strings),verdictTitle,verdict,reflection. Plain text JSON, no markdown.`,
        input:`Research the public figure named: ${name}`
      })
    });}finally{clearTimeout(timeout);}
    if(!response.ok){console.error('API error',response.status);return res.status(502).json({error:'Research provider temporarily unavailable. Please try later.'});}
    const payload=await response.json();
    const message=(payload.output||[]).find(x=>x.type==='message');
    const content=(message?.content||[]).filter(x=>x.type==='output_text');
    const raw=content.map(x=>x.text||'').join('').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    let analysis;
    try {analysis=JSON.parse(raw);}catch {return res.status(502).json({error:'Research returned an incomplete result. Please try again.'});}
    const urls=new Map();
    for(const c of content) for(const a of (c.annotations||[])) if(a.type==='url_citation' && /^https?:\/\//.test(a.url||''))urls.set(a.url,{title:a.title||a.url,url:a.url});
    // Never treat model-written URLs as independently verified citations.
    const record = {analysis,sources:[...urls.values()].slice(0,20),researchedAt:new Date().toISOString()};
    // Save before returning; if storage fails, don't imply everyone will see identical results.
    try { await redis('SET', key, JSON.stringify(record), 'EX', DAY_SECONDS); }
    catch(err) { console.error('Cache save failed',err?.message); return res.status(503).json({error:'Research completed but could not be saved. Please try later.'}); }
    return res.status(200).json({...record,cached:false});
  }catch(err){console.error('Research failed',err?.message);return res.status(502).json({error:'Research timed out or failed. Please try again.'});}
  finally { if (ownsLock) { try { await redis('DEL',lockKey); } catch(err) { console.error('Lock cleanup failed',err?.message); } } }
}
