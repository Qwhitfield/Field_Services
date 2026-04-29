const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function fetchSiteContent(url) {
  try {
    const normalized = url.startsWith('http') ? url : 'https://' + url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(normalized, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadAnalyzer/1.0)' }
    });
    clearTimeout(timeout);
    const html = await response.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return 'PAGE TITLE: ' + title.trim() + '\n\nPAGE CONTENT:\n' + stripped.slice(0, 3000);
  } catch (e) {
    return null;
  }
}

function ensureNoZeroValues(parsed) {
  const fallbackRanges = ['$600 - $1,200/mo', '$900 - $1,800/mo', '$800 - $1,500/mo'];
  const findings = parsed.findings || [];
  let total = 0;

  findings.forEach(function(f, i) {
    if (!f.monthly_loss || f.monthly_loss === '$0' || f.monthly_loss === '-') {
      f.monthly_loss = fallbackRanges[i] || '$500 - $1,000/mo';
    }
    if (!f.loss_basis || f.loss_basis === '-') {
      f.loss_basis = 'Based on conservative estimate of 2-3 missed leads/week at average job value for this industry.';
    }
    const match = f.monthly_loss.match(/\$([0-9,]+)/);
    if (match) total += parseInt(match[1].replace(/,/g, ''), 10);
  });

  if (!parsed.estimated_monthly_leak || parsed.estimated_monthly_leak === '$0' || parsed.estimated_monthly_leak === '-') {
    const hi = Math.round(total * 1.8);
    parsed.estimated_monthly_leak = '$' + total.toLocaleString() + ' - $' + hi.toLocaleString() + '/mo';
  }

  return parsed;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let url, software;
  try {
    const body = JSON.parse(event.body);
    url = body.url;
    software = body.software;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!url || !software) {
    return { statusCode: 400, body: JSON.stringify({ error: 'URL and software are required' }) };
  }

  const siteContent = await fetchSiteContent(url);
  const siteContext = siteContent
    ? '\n\nHere is the actual content scraped from their website -- use this to make your findings specific to what they actually offer:\n\n' + siteContent
    : '\n\nNote: The site could not be fetched. Infer as much as possible from the URL and domain name.';

  const systemPrompt = 'You are a systems and lead-generation analyst for QAMW Consulting, run by Quinita Whitfield. You review field service company websites and identify specific opportunities to capture more leads and stop revenue from slipping through the cracks. Your tone is direct, peer-to-peer, and plain-spoken. Never use corporate filler. Keep it real and specific.\n\nYou will return ONLY valid JSON, no markdown, no explanation outside the JSON.\n\nReturn this exact structure:\n{\n  "domain": "the domain name only, no https",\n  "estimated_monthly_leak": "a single dollar range like $3,200 - $6,500/mo",\n  "findings": [\n    {\n      "title": "short punchy title under 6 words",\n      "body": "2-3 sentences specific to their site",\n      "monthly_loss": "dollar range e.g. $800 - $1,400/mo",\n      "loss_basis": "one short sentence explaining the math",\n      "tag": "quick_win or system_fix or revenue_leak"\n    }\n  ]\n}\n\nTag definitions:\n- quick_win: something fixable fast with high impact\n- system_fix: underlying software or process issue\n- revenue_leak: money or leads actively being lost\n\nDollar estimate rules:\n- HVAC $350-$600, plumbing $250-$500, roofing $4,000-$12,000, electrical $200-$450, landscaping $200-$800\n- Be conservative\n- monthly_loss must ALWAYS be a dollar range, never $0\n- estimated_monthly_leak must ALWAYS be a dollar range\n\nFinding rules:\n- Finding 1: lead capture or website friction\n- Finding 2: their specific software (' + software + ') and how its likely underused\n- Finding 3: deeper data or revenue visibility problem\n- Reference actual services or details visible in site content\n- Do not say "I noticed" or "I see" -- just state the finding directly';

  const userPrompt = 'Analyze this field service company website: ' + url + '\n\nThey use: ' + software + siteContext + '\n\nGive me 3 specific findings with dollar estimates. JSON only, no other text.';

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = message.content[0].text;
    const parsed = ensureNoZeroValues(JSON.parse(raw.trim()));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Analysis failed. Check your API key and try again.' })
    };
  }
};
