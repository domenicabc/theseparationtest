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
const cacheKey = name => `tst:v2:person:${name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g,' ').trim()}`;
async function recordRecent(name) {
  try {
    await redis('ZADD', 'tst:v1:recent', Date.now(), name);
    await redis('EXPIRE', 'tst:v1:recent', 604800);
  } catch (error) { console.error('Recent search tracking failed', error?.message); }
}
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
    if (existing) { await recordRecent(existing.analysis?.name || name); return res.status(200).json({...existing, cached:true}); }
    // Only one deployment can acquire this lock for a given person.
    ownsLock = (await redis('SET', lockKey, 'working', 'NX', 'EX', 90)) === 'OK';
    if (!ownsLock) {
      for (let i=0; i<22; i++) {
        await wait(2000);
        const saved = parseSaved(await redis('GET', key));
        if (saved) { await recordRecent(saved.analysis?.name || name); return res.status(200).json({...saved, cached:true}); }
        if (!(await redis('GET', lockKey))) break;
      }
      return res.status(202).json({pending:true,message:'This person is already being researched. Please search again in a moment.'});
    }
    // Check again after obtaining the lock in case a previous request just completed.
    const secondCheck = parseSaved(await redis('GET', key));
    if (secondCheck) { await recordRecent(secondCheck.analysis?.name || name); return res.status(200).json({...secondCheck, cached:true}); }
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
        max_output_tokens:4300,
        instructions:`You research public figures across art, technology, culture and other fields. Search the web. Never confuse same-name people. Avoid invented or defamatory assertions; label allegations as disputed and do not use anonymous rumors as established facts. Distinguish conduct from creative influence. Do not treat ordinary commercial success, popularity, or business expansion as misconduct. The six evidence categories are culturalGood, culturalNeutral, culturalBad, ethicalGood, ethicalNeutral, ethicalBad. Search actively for each category, but return [] if no reliable, relevant findings; do not fabricate a positive/negative to achieve balance. Cultural categories describe the work and its impacts; ethical categories describe documented actions and accountability. Each finding MUST be a short OBJECT {"text":"one factual sentence without URLs or markdown", "sourceIds":[1,2]} with 1 or more source IDs referring to the sources array. Avoid repetitive findings and excessive corporate PR sources; seek independent reputable coverage. Include up to 4 distinct meaningful findings per category, fewer when evidence is thin. Sources array: [{"id":1,"title":"readable title","url":"https://..."}] using actual pages discovered in search, no guessed URLs. Cite each finding by sourceIds. If you cannot cite a finding to an actual discovered source, omit it. Include contributionReason and ethicsReason: 1-2 sentences EACH explaining exactly what evidence drives the score and limitations; no unsourced claims. Scores are subjective 0-100 editorial assessments, not morality, and should be null if too little evidence; avoid false precision or forced middle scores. An ethics score does NOT require positive actions if documented conduct supports an assessment; explain this explicitly rather than implying that lack of negative reports proves virtue. Avoid scoring protected identity or political beliefs. communityDiscussions: [] or up to 3 short descriptions of PUBLIC online discussion THEMES, not personal allegations, without impact on scores. Consider consequences of studying vs financially supporting someone's work. Return ONLY one valid JSON object with keys name,identity,confidence (high/medium/low),contributionScore,ethicsScore,contributionReason,ethicsReason,culturalGood,culturalNeutral,culturalBad,ethicalGood,ethicalNeutral,ethicalBad,sources,communityDiscussions,verdictTitle,verdict,reflection. No markdown or URLs embedded in finding text.`,
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
    // Only keep source URLs with valid HTTPS links. Model-provided references are
    // presented transparently, not claimed to be independently verified.
    const supplied = Array.isArray(analysis.sources) ? analysis.sources : [];
    const cleanSources = [];
    const ids = new Map();
    for (const source of supplied) {
      if (cleanSources.length >= 24) break;
      if (!source || typeof source.url !== 'string') continue;
      let url;
      try { url = new URL(source.url); } catch { continue; }
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      const id = Number(source.id);
      if (!Number.isSafeInteger(id) || ids.has(id)) continue;
      ids.set(id, cleanSources.length + 1);
      cleanSources.push({title:String(source.title || url.hostname).slice(0,180),url:url.href});
    }
    const categories = ['culturalGood','culturalNeutral','culturalBad','ethicalGood','ethicalNeutral','ethicalBad'];
    for (const category of categories) {
      const values = Array.isArray(analysis[category]) ? analysis[category] : [];
      analysis[category] = values.map(item => {
        if (!item || typeof item !== 'object') return null;
        const sourceIds = [...new Set((Array.isArray(item.sourceIds)?item.sourceIds:[]).map(id => ids.get(Number(id))).filter(Boolean))];
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        return text && sourceIds.length ? {text:text.slice(0,450),sourceIds} : null;
      }).filter(Boolean).slice(0,4);
    }
    // Do not show numeric assessments without evidence and a rationale.
    const hasCultural = ['culturalGood','culturalNeutral','culturalBad'].some(k => analysis[k].length);
    const hasEthical = ['ethicalGood','ethicalNeutral','ethicalBad'].some(k => analysis[k].length);
    for (const [scoreKey,reasonKey,hasEvidence] of [
      ['contributionScore','contributionReason',hasCultural],
      ['ethicsScore','ethicsReason',hasEthical]
    ]) {
      const score = analysis[scoreKey];
      if (!hasEvidence || typeof analysis[reasonKey] !== 'string' || !analysis[reasonKey].trim() ||
          score === null || score === undefined || score === '' || !Number.isFinite(Number(score))) {
        analysis[scoreKey] = null;
        analysis[reasonKey] = 'Insufficient sourced evidence to explain a reliable assessment.';
      } else analysis[scoreKey] = Math.round(Math.max(0,Math.min(100,Number(score))));
    }
    delete analysis.sources;
    const record = {analysis,sources:cleanSources,researchedAt:new Date().toISOString()};
    // Save before returning; if storage fails, don't imply everyone will see identical results.
    try { await redis('SET', key, JSON.stringify(record), 'EX', DAY_SECONDS); }
    catch(err) { console.error('Cache save failed',err?.message); return res.status(503).json({error:'Research completed but could not be saved. Please try later.'}); }
    await recordRecent(analysis.name || name);
    return res.status(200).json({...record,cached:false});
  }catch(err){console.error('Research failed',err?.message);return res.status(502).json({error:'Research timed out or failed. Please try again.'});}
  finally { if (ownsLock) { try { await redis('DEL',lockKey); } catch(err) { console.error('Lock cleanup failed',err?.message); } } }
}
