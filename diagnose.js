const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  let prompt;
  try {
    const body = JSON.parse(event.body);
    prompt = body.prompt;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!prompt) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Prompt is required' }) };
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: 'You are a systems diagnostics consultant for QAMW Consulting. Review answers and produce a clear honest practical diagnosis. Write like a peer. Direct, short sentences, no jargon, no fluff. Return ONLY valid JSON with these exact keys: readiness_score (1-10 number as string), readiness_label (one of: Critical, Needs Work, Getting There, Strong Foundation), top_gap (one sentence), gap_explanation (2-3 sentences referencing their answers), priority_1 (object with title and detail), priority_2 (object with title and detail), priority_3 (object with title and detail), ai_readiness (one blunt sentence), honest_take (2-3 sentences of straight talk). No markdown, no backticks, just raw JSON.',
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    const parsed = JSON.parse(raw.trim());

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
      body: JSON.stringify({ error: 'Diagnosis failed.' })
    };
  }
};
