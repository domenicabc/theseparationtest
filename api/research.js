const MAX_NAME = 90;
const LIMIT = 8;
const windows = new Map(); // Best-effort per-instance rate limiting; not a global quota.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > MAX_NAME || !/^[\p{L}\p{N} .,'’()\-]+$/u.test(name)) return res.status(400).json({error:'Enter a public figure’s name (up to 90 characters).'});
  const ip = String(req.headers['x-forwarded-for'] || 'anonymous').split(',')[0].trim();
  const now = Date.now(), bucket = windows.get(ip) || {since:now,count:0};
  if (now-bucket.since>86400000){bucket.since=now;bucket.count=0;}
  if (++bucket.count>LIMIT) return res.status(429).json({error:'Daily search limit reached. Try again tomorrow.'});
  windows.set(ip,bucket);
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({error:'Research is not configured yet. The site owner must set OPENAI_API_KEY in Vercel.'});
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
    return res.status(200).json({analysis,sources:[...urls.values()].slice(0,20),researchedAt:new Date().toISOString()});
  }catch(err){console.error('Research failed',err?.message);return res.status(502).json({error:'Research timed out or failed. Please try again.'});}
}
