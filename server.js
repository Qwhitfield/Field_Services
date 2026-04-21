require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function fetchSiteContent(url) {
  try {
    const normalized = url.startsWith('http') ? url : `https://${url}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(normalized, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadAnalyzer/1.0)' }
    });
    clearTimeout(timeout);
    const html = await response.text();
    // Extract meaningful text: title, headings, paragraphs, list items, nav links
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Return first 3000 chars — enough for Claude to understand the business
    return `PAGE TITLE: ${title.trim()}\n\nPAGE CONTENT:\n${stripped.slice(0, 3000)}`;
  } catch {
    return null;
  }
}

function ensureNoZeroValues(parsed) {
  // Fallback industry ranges if Claude returns $0 or missing values
  const fallbackRanges = ['$600 – $1,200/mo', '$900 – $1,800/mo', '$800 – $1,500/mo'];
  const findings = parsed.findings || [];
  let total = 0;

  findings.forEach((f, i) => {
    if (!f.monthly_loss || f.monthly_loss === '$0' || f.monthly_loss === '-' || f.monthly_loss === '—') {
      f.monthly_loss = fallbackRanges[i] || '$500 – $1,000/mo';
    }
    if (!f.loss_basis || f.loss_basis === '-' || f.loss_basis === '—') {
      f.loss_basis = 'Based on conservative estimate of 2–3 missed leads/week at average job value for this industry.';
    }
    // Parse low end for total
    const match = f.monthly_loss.match(/\$([0-9,]+)/);
    if (match) total += parseInt(match[1].replace(/,/g, ''), 10);
  });

  if (!parsed.estimated_monthly_leak || parsed.estimated_monthly_leak === '$0' || parsed.estimated_monthly_leak === '-' || parsed.estimated_monthly_leak === '—') {
    const hi = Math.round(total * 1.8);
    parsed.estimated_monthly_leak = `$${total.toLocaleString()} – $${hi.toLocaleString()}/mo`;
  }

  return parsed;
}

app.post('/api/analyze', async (req, res) => {
  const { url, software } = req.body;

  if (!url || !software) {
    return res.status(400).json({ error: 'URL and software are required' });
  }

  const siteContent = await fetchSiteContent(url);
  const siteContext = siteContent
    ? `\n\nHere is the actual content scraped from their website — use this to make your findings specific to what they actually offer and how their site is set up:\n\n${siteContent}`
    : '\n\nNote: The site could not be fetched. Infer as much as possible from the URL and domain name.';

  const systemPrompt = `You are a systems and lead-generation analyst for QAMW Consulting, run by Quinita Whitfield. You review field service company websites and identify specific opportunities to capture more leads and stop revenue from slipping through the cracks. Your tone is direct, peer-to-peer, and plain-spoken — like a trusted advisor, not a vendor. Never use corporate filler. Keep it real and specific.

You will return ONLY valid JSON, no markdown, no explanation outside the JSON.

Return this exact structure:
{
  "domain": "the domain name only, no https",
  "estimated_monthly_leak": "a single dollar range like $3,200 – $6,500/mo — the total estimated monthly revenue being lost across all 3 findings. MUST be a dollar range. Never $0, never a dash.",
  "findings": [
    {
      "title": "short punchy title under 6 words",
      "body": "2-3 sentences. Be specific to what you actually see on their site — reference their real services, location, or business name where visible. Reference the software they use where relevant. Tell them what it's costing them in concrete terms.",
      "monthly_loss": "a specific dollar range this single issue is likely costing per month, e.g. $800 – $1,400/mo. MUST be a dollar range — never $0, never a dash, never null.",
      "loss_basis": "one short sentence explaining the math behind the estimate, e.g. 'Based on 3 missed leads/week at an average $350 job value.' MUST always be present — never a dash.",
      "tag": "quick_win or system_fix or revenue_leak"
    },
    {
      "title": "...",
      "body": "...",
      "monthly_loss": "...",
      "loss_basis": "...",
      "tag": "..."
    },
    {
      "title": "...",
      "body": "...",
      "monthly_loss": "...",
      "loss_basis": "...",
      "tag": "..."
    }
  ]
}

Tag definitions:
- quick_win: something fixable fast with high impact
- system_fix: underlying software or process issue that needs proper setup
- revenue_leak: money or leads actively being lost right now

Dollar estimate rules:
- Use realistic average job values by industry: HVAC $350–$600, plumbing $250–$500, roofing $4,000–$12,000, electrical $200–$450, general construction $5,000–$50,000, landscaping $200–$800
- Base estimates on what you can observe about their actual business from the site content
- Be conservative — low-end estimates feel more credible than inflated ones
- Base the estimate on a realistic number of leads or jobs affected per month
- The loss_basis should make the math transparent so they can follow it
- monthly_loss must ALWAYS be a dollar range, never $0, never a dash, never null
- estimated_monthly_leak must ALWAYS be a dollar range — the sum/range across all 3 findings

Finding rules:
- Finding 1: lead capture or website friction (booking flow, forms, contact page) — based on what you actually see on the site
- Finding 2: their specific software (${software}) and how it's likely underused given what you see on the site
- Finding 3: deeper data or revenue visibility problem specific to their business type
- Reference actual services, location, or business details visible in the site content
- Sound like someone who actually read their site, not a template
- Do not say "I noticed" or "I see" — just state the finding directly`;

  const userPrompt = `Analyze this field service company website for lead generation and revenue opportunities: ${url}

They use: ${software}${siteContext}

Give me 3 specific findings with dollar estimates based on what you can observe about this specific business. JSON only, no other text.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = message.content[0].text;
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = ensureNoZeroValues(JSON.parse(clean));
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed. Check your API key and try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
